import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ============================================================
   종이 접기 3D — 평면 접기(flat fold) 엔진
   종이 = 볼록 다각형 조각(facet)들의 목록.
   facet = { pts: 종이좌표 다각형(CCW), T: 종이→테이블 2D 등거리변환, layer: 정수 }
   접기 = 테이블 공간 직선으로 전 facet 클리핑 → 접는 쪽 T' = 반사 ∘ T + 층 재배치
   ============================================================ */

const LAYER_EPS = 0.1;        // 층 간격 (종이 두께)
const MIN_AREA = 0.02;        // 이 미만 조각은 버림
const BASE_H = 29.7;          // 종이 높이 고정(A4), 폭은 이미지 비율 따름

let paperW = 21.0;
let paperH = BASE_H;

// ---------- 2D 기하 유틸 ----------
const applyT = (T, p) => ({ x: T.a * p.x + T.b * p.y + T.tx, y: T.c * p.x + T.d * p.y + T.ty });

function reflectAcross(L0, u) { // 테이블 공간에서 직선(L0, 방향 u) 반사 행렬
  const m00 = 2 * u.x * u.x - 1, m01 = 2 * u.x * u.y;
  const m10 = m01, m11 = 2 * u.y * u.y - 1;
  return {
    m00, m01, m10, m11,
    tx: L0.x - (m00 * L0.x + m01 * L0.y),
    ty: L0.y - (m10 * L0.x + m11 * L0.y),
  };
}
function composeRT(R, T) { // (반사 R) ∘ (변환 T)
  return {
    a: R.m00 * T.a + R.m01 * T.c,
    b: R.m00 * T.b + R.m01 * T.d,
    c: R.m10 * T.a + R.m11 * T.c,
    d: R.m10 * T.b + R.m11 * T.d,
    tx: R.m00 * T.tx + R.m01 * T.ty + R.tx,
    ty: R.m10 * T.tx + R.m11 * T.ty + R.ty,
  };
}
function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
// Sutherland–Hodgman: gvals[i] 부호 기준으로 반평면 클리핑
function clipPoly(pts, gvals, keepPositive) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const ga = gvals[i], gb = gvals[(i + 1) % n];
    const ain = keepPositive ? ga >= -1e-9 : ga <= 1e-9;
    const bin = keepPositive ? gb >= -1e-9 : gb <= 1e-9;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = ga / (ga - gb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

// ---------- 상태 ----------
function initialFacet() {
  return {
    pts: [{ x: 0, y: 0 }, { x: paperW, y: 0 }, { x: paperW, y: paperH }, { x: 0, y: paperH }],
    T: { a: 1, b: 0, c: 0, d: 1, tx: -paperW / 2, ty: -paperH / 2 },
    layer: 0,
  };
}
let facets = [initialFacet()];
const undoStack = [];
let mode = 'view';           // view | draw | side | angle
let lightMode = false;

// 접기 진행 중 데이터
let foldLine = null;         // { L0, u, n }
let split = null;            // { pos: [facet...], neg: [facet...] }
let chosenSign = 0;          // +1 = pos쪽 접기, -1 = neg쪽 접기
let foldDir = 'over';        // over | under
let foldAngle = 0;

// ---------- three.js 셋업 ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);
camera.up.set(0, 0, 1);
camera.position.set(0, -42, 30);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- 텍스처 ----------
let frontImg = null, backImg = null;   // 업로드된 원본 Image (없으면 기본 종이)
let texFront, texBack, texCombined;

function makeDefaultFront() {
  const c = document.createElement('canvas');
  c.width = 724; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#fdfdf8'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 6;
  g.strokeRect(14, 14, c.width - 28, c.height - 28);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.font = 'bold 130px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('앞', c.width / 2, c.height / 2);
  return c;
}
function makeDefaultBack() {
  const c = document.createElement('canvas');
  c.width = 724; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#f3ecd9'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 6;
  g.strokeRect(14, 14, c.width - 28, c.height - 28);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.font = 'bold 130px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('뒤', c.width / 2, c.height / 2);
  return c;
}
function fitDraw(g, src, w, h) { g.drawImage(src, 0, 0, w, h); }

function rebuildTextures() {
  const srcFront = frontImg || makeDefaultFront();
  const srcBack = backImg || makeDefaultBack();
  const fw = srcFront.width || srcFront.naturalWidth;
  const fh = srcFront.height || srcFront.naturalHeight;
  const scale = Math.min(1, 2048 / Math.max(fw, fh));
  const w = Math.max(64, Math.round(fw * scale));
  const h = Math.max(64, Math.round(fh * scale));

  // 앞면
  const cf = document.createElement('canvas'); cf.width = w; cf.height = h;
  fitDraw(cf.getContext('2d'), srcFront, w, h);

  // 뒷면: 좌우 미러 (실물 종이를 뒤에서 보는 좌표와 일치시킴)
  const cb = document.createElement('canvas'); cb.width = w; cb.height = h;
  const gb = cb.getContext('2d');
  gb.translate(w, 0); gb.scale(-1, 1);
  fitDraw(gb, srcBack, w, h);

  // 빛에 비추기: 앞면 × 미러된 뒷면 (곱셈 = 빛 투과 느낌)
  const cc = document.createElement('canvas'); cc.width = w; cc.height = h;
  const gc = cc.getContext('2d');
  gc.drawImage(cf, 0, 0);
  gc.globalCompositeOperation = 'multiply';
  gc.drawImage(cb, 0, 0);

  const mk = (cnv) => {
    const t = new THREE.CanvasTexture(cnv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  };
  texFront?.dispose(); texBack?.dispose(); texCombined?.dispose();
  texFront = mk(cf); texBack = mk(cb); texCombined = mk(cc);
  applyMaterialMode();
}

// ---------- 재질 ----------
const matFront = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
const matBack = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
const matEdge = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 });
const matFoldLine = new THREE.LineBasicMaterial({ color: 0xff4455 });
const matFoldDash = new THREE.LineDashedMaterial({ color: 0xff4455, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.6 });
const matHighlight = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthTest: false });

function applyMaterialMode() {
  if (lightMode) {
    matFront.map = texCombined; matBack.map = texCombined;
    matFront.transparent = matBack.transparent = true;
    matFront.opacity = matBack.opacity = 0.8;
    matFront.depthWrite = matBack.depthWrite = false;
  } else {
    matFront.map = texFront; matBack.map = texBack;
    matFront.transparent = matBack.transparent = false;
    matFront.opacity = matBack.opacity = 1;
    matFront.depthWrite = matBack.depthWrite = true;
  }
  matFront.needsUpdate = true; matBack.needsUpdate = true;
}

// ---------- 메시 생성 ----------
const paperGroup = new THREE.Group();     // 확정 상태 (또는 stay 조각)
const previewGroup = new THREE.Group();   // 접는 중인 조각 (경첩 회전)
const overlayGroup = new THREE.Group();   // 하이라이트/접기선
previewGroup.matrixAutoUpdate = false;
scene.add(paperGroup, previewGroup, overlayGroup);

function facetGeometry(facet, zOverride = null) {
  const n = facet.pts.length;
  const z = zOverride ?? facet.layer * LAYER_EPS;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const tp = applyT(facet.T, facet.pts[i]);
    pos[i * 3] = tp.x; pos[i * 3 + 1] = tp.y; pos[i * 3 + 2] = z;
    uv[i * 2] = facet.pts[i].x / paperW; uv[i * 2 + 1] = facet.pts[i].y / paperH;
  }
  const idx = [];
  for (let i = 1; i < n - 1; i++) idx.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

function buildFacetInto(group, facet) {
  const geo = facetGeometry(facet);
  const m1 = new THREE.Mesh(geo, matFront);
  const m2 = new THREE.Mesh(geo, matBack);
  m1.renderOrder = m2.renderOrder = 1000 + facet.layer;
  group.add(m1, m2);
  // 조각 테두리 (접힌 선이 보이도록) — 인덱스 없이 외곽 정점만 연결
  const z = facet.layer * LAYER_EPS + 0.012;
  const edgePts = facet.pts.map(p => {
    const tp = applyT(facet.T, p);
    return new THREE.Vector3(tp.x, tp.y, z);
  });
  const edgeGeo = new THREE.BufferGeometry().setFromPoints(edgePts);
  const edge = new THREE.LineLoop(edgeGeo, matEdge);
  edge.renderOrder = 3000;
  group.add(edge);
}

function clearGroup(g) {
  for (const child of [...g.children]) {
    child.geometry?.dispose();
    g.remove(child);
  }
}

function rebuildScene() {
  clearGroup(paperGroup); clearGroup(previewGroup); clearGroup(overlayGroup);
  previewGroup.matrix.identity();
  for (const f of facets) buildFacetInto(paperGroup, f);
}

// ---------- 접기 연산 ----------
function computeSplit(L0, u) {
  const n = { x: -u.y, y: u.x };
  const pos = [], neg = [];
  for (const f of facets) {
    const gvals = f.pts.map(p => {
      const tp = applyT(f.T, p);
      return (tp.x - L0.x) * n.x + (tp.y - L0.y) * n.y;
    });
    const pPos = clipPoly(f.pts, gvals, true);
    const pNeg = clipPoly(f.pts, gvals, false);
    if (pPos.length >= 3 && polyArea(pPos) > MIN_AREA) pos.push({ pts: pPos, T: f.T, layer: f.layer });
    if (pNeg.length >= 3 && polyArea(pNeg) > MIN_AREA) neg.push({ pts: pNeg, T: f.T, layer: f.layer });
  }
  if (pos.length === 0 || neg.length === 0) return null;
  return { pos, neg };
}

function sideOfPoint(p) {
  const g = (p.x - foldLine.L0.x) * foldLine.n.x + (p.y - foldLine.L0.y) * foldLine.n.y;
  return g >= 0 ? 1 : -1;
}

function commitFold() {
  const stay = chosenSign > 0 ? split.neg : split.pos;
  const fold = chosenSign > 0 ? split.pos : split.neg;
  const R = reflectAcross(foldLine.L0, foldLine.u);
  const stayLayers = stay.map(f => f.layer);
  const foldLayers = fold.map(f => f.layer);
  const maxStay = Math.max(...stayLayers), minStay = Math.min(...stayLayers);
  const maxFold = Math.max(...foldLayers), minFold = Math.min(...foldLayers);

  const newFacets = stay.map(f => ({ pts: f.pts, T: f.T, layer: f.layer }));
  for (const f of fold) {
    const layer = foldDir === 'over'
      ? maxStay + 1 + (maxFold - f.layer)        // 위로: 남는 더미 위에 역순으로
      : minStay - 1 - (f.layer - minFold);       // 아래로: 남는 더미 아래에 역순으로
    newFacets.push({ pts: f.pts, T: composeRT(R, f.T), layer });
  }
  // 층 정규화 (최소 0)
  const minL = Math.min(...newFacets.map(f => f.layer));
  for (const f of newFacets) f.layer -= minL;

  undoStack.push(structuredClone(facets));
  facets = newFacets;
}

// ---------- 접기선 그리기 & 하이라이트 ----------
function drawFoldLineVisual(p0, p1, extended) {
  // 기존 선 제거
  for (const c of [...overlayGroup.children]) {
    if (c.userData.isFoldLine) { c.geometry?.dispose(); overlayGroup.remove(c); }
  }
  const zTop = Math.max(...facets.map(f => f.layer)) * LAYER_EPS + 0.05;
  const seg = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(p0.x, p0.y, zTop), new THREE.Vector3(p1.x, p1.y, zTop),
  ]);
  const line = new THREE.Line(seg, matFoldLine);
  line.userData.isFoldLine = true;
  line.renderOrder = 5000;
  overlayGroup.add(line);
  if (extended) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const ext = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(p0.x - ux * 200, p0.y - uy * 200, zTop),
      new THREE.Vector3(p1.x + ux * 200, p1.y + uy * 200, zTop),
    ]);
    const dash = new THREE.Line(ext, matFoldDash);
    dash.computeLineDistances();
    dash.userData.isFoldLine = true;
    dash.renderOrder = 4999;
    overlayGroup.add(dash);
  }
}

let highlightSign = 0;
function updateHighlight(sign) {
  if (sign === highlightSign) return;
  highlightSign = sign;
  for (const c of [...overlayGroup.children]) {
    if (c.userData.isHighlight) { c.geometry?.dispose(); overlayGroup.remove(c); }
  }
  if (!split || sign === 0) return;
  const pieces = sign > 0 ? split.pos : split.neg;
  for (const f of pieces) {
    const geo = facetGeometry(f, f.layer * LAYER_EPS + 0.03);
    const mesh = new THREE.Mesh(geo, matHighlight);
    mesh.userData.isHighlight = true;
    mesh.renderOrder = 4500;
    overlayGroup.add(mesh);
  }
}

// ---------- 각도 미리보기 ----------
function enterAnglePreview() {
  clearGroup(paperGroup); clearGroup(previewGroup);
  const stay = chosenSign > 0 ? split.neg : split.pos;
  const fold = chosenSign > 0 ? split.pos : split.neg;
  for (const f of stay) buildFacetInto(paperGroup, f);
  for (const f of fold) buildFacetInto(previewGroup, f);
  updateHighlight(0);
  foldAngle = 0;
  angleSlider.value = 0;
  updateAnglePreview();
}

function updateAnglePreview() {
  const maxAll = Math.max(...facets.map(f => f.layer));
  const zTop = maxAll * LAYER_EPS;
  // over: 접힌 더미가 위에 얹히도록, under: 아래로 들어가도록 경첩 높이 근사
  const hingeZ = foldDir === 'over' ? zTop / 2 + LAYER_EPS * 0.5 : -LAYER_EPS * 0.5;
  const axis = new THREE.Vector3(foldLine.u.x * chosenSign, foldLine.u.y * chosenSign, 0).normalize();
  const theta = THREE.MathUtils.degToRad(foldAngle) * (foldDir === 'over' ? 1 : -1);
  const M = new THREE.Matrix4()
    .makeTranslation(foldLine.L0.x, foldLine.L0.y, hingeZ)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, theta))
    .multiply(new THREE.Matrix4().makeTranslation(-foldLine.L0.x, -foldLine.L0.y, -hingeZ));
  previewGroup.matrix.copy(M);
  angleLabel.textContent = `${foldAngle}°`;
  confirmBtn.disabled = foldAngle !== 180;
}

// ---------- UI ----------
const hint = document.getElementById('hint');
const foldPanel = document.getElementById('foldPanel');
const angleSlider = document.getElementById('angle');
const angleLabel = document.getElementById('angleLabel');
const confirmBtn = document.getElementById('confirmFold');
const btnFold = document.getElementById('btnFold');
const btnLight = document.getElementById('btnLight');
const dirOverBtn = document.getElementById('dirOver');
const dirUnderBtn = document.getElementById('dirUnder');

function setHint(t) { hint.textContent = t; }

function setMode(m) {
  mode = m;
  foldPanel.classList.toggle('hidden', m !== 'angle');
  btnFold.classList.toggle('active', m !== 'view');
  controls.enabled = (m === 'view' || m === 'angle');
  canvas.style.cursor = (m === 'draw') ? 'crosshair' : 'default';
  if (m === 'view') {
    setHint('드래그로 회전 · 휠/핀치로 확대축소');
    clearGroup(overlayGroup); highlightSign = 0;
  } else if (m === 'draw') {
    setHint('종이 위에 접을 선을 드래그로 그으세요');
    clearGroup(overlayGroup); highlightSign = 0;
  } else if (m === 'side') {
    setHint('접을 쪽을 클릭하세요');
  } else if (m === 'angle') {
    setHint('슬라이더로 접기 · 180°에서 확정 (드래그로 회전 가능)');
  }
}

btnFold.addEventListener('click', () => {
  if (mode === 'view') setMode('draw');
  else { split = null; foldLine = null; rebuildScene(); setMode('view'); }
});

document.getElementById('btnUndo').addEventListener('click', () => {
  if (mode !== 'view' && mode !== 'draw') return;
  if (undoStack.length === 0) { setHint('되돌릴 접기가 없어요'); return; }
  facets = undoStack.pop();
  rebuildScene();
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (mode !== 'view' && mode !== 'draw') return;
  if (facets.length === 1) return;
  undoStack.push(structuredClone(facets));
  facets = [initialFacet()];
  rebuildScene();
});

btnLight.addEventListener('click', () => {
  lightMode = !lightMode;
  btnLight.classList.toggle('active', lightMode);
  applyMaterialMode();
});

dirOverBtn.addEventListener('click', () => { foldDir = 'over'; dirOverBtn.classList.add('active'); dirUnderBtn.classList.remove('active'); updateAnglePreview(); });
dirUnderBtn.addEventListener('click', () => { foldDir = 'under'; dirUnderBtn.classList.add('active'); dirOverBtn.classList.remove('active'); updateAnglePreview(); });

angleSlider.addEventListener('input', () => {
  let v = parseInt(angleSlider.value, 10);
  if (v >= 174) { v = 180; angleSlider.value = 180; }
  foldAngle = v;
  updateAnglePreview();
});

confirmBtn.addEventListener('click', () => {
  commitFold();
  split = null; foldLine = null;
  rebuildScene();
  setMode('view');
});

document.getElementById('cancelFold').addEventListener('click', () => {
  split = null; foldLine = null;
  rebuildScene();
  setMode('draw');
});

// 이미지 업로드
const fileFront = document.getElementById('fileFront');
const fileBack = document.getElementById('fileBack');
document.getElementById('btnFront').addEventListener('click', () => fileFront.click());
document.getElementById('btnBack').addEventListener('click', () => fileBack.click());

function loadImageFile(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
fileFront.addEventListener('change', async () => {
  const f = fileFront.files[0];
  if (!f) return;
  try {
    frontImg = await loadImageFile(f);
    // 종이 비율을 앞면 이미지에 맞춤 → 접기 상태 리셋
    const aspect = frontImg.naturalWidth / frontImg.naturalHeight;
    paperH = BASE_H;
    paperW = Math.min(60, Math.max(5, BASE_H * aspect));
    facets = [initialFacet()];
    undoStack.length = 0;
    rebuildTextures();
    rebuildScene();
    setHint('앞면 이미지 적용됨 (접기 상태 초기화)');
  } catch { setHint('이미지를 불러오지 못했어요'); }
  fileFront.value = '';
});
fileBack.addEventListener('change', async () => {
  const f = fileBack.files[0];
  if (!f) return;
  try {
    backImg = await loadImageFile(f);
    rebuildTextures();
    setHint('뒷면 이미지 적용됨');
  } catch { setHint('이미지를 불러오지 못했어요'); }
  fileBack.value = '';
});

// ---------- 포인터 (선 긋기 / 쪽 선택) ----------
const raycaster = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _v3 = new THREE.Vector3();

function pointerToTable(e) {
  const rect = canvas.getBoundingClientRect();
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const hit = raycaster.ray.intersectPlane(tablePlane, _v3);
  return hit ? { x: hit.x, y: hit.y } : null;
}

let dragStart = null, dragCur = null, downPos = null;

canvas.addEventListener('pointerdown', (e) => {
  if (mode === 'draw') {
    const p = pointerToTable(e);
    if (!p) return;
    dragStart = p; dragCur = p;
    canvas.setPointerCapture(e.pointerId);
  } else if (mode === 'side') {
    downPos = { x: e.clientX, y: e.clientY };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (mode === 'draw' && dragStart) {
    const p = pointerToTable(e);
    if (!p) return;
    dragCur = p;
    drawFoldLineVisual(dragStart, dragCur, true);
  } else if (mode === 'side') {
    const p = pointerToTable(e);
    if (p) updateHighlight(sideOfPoint(p));
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (mode === 'draw' && dragStart) {
    const p0 = dragStart, p1 = dragCur;
    dragStart = dragCur = null;
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (len < 0.8) {
      clearGroup(overlayGroup);
      return;
    }
    const u = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len };
    const n = { x: -u.y, y: u.x };
    const s = computeSplit(p0, u);
    if (!s) {
      setHint('선이 종이를 지나야 해요 — 다시 그어주세요');
      clearGroup(overlayGroup);
      return;
    }
    foldLine = { L0: p0, u, n };
    split = s;
    drawFoldLineVisual(p0, p1, true);
    setMode('side');
  } else if (mode === 'side' && downPos) {
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 8) return;
    const p = pointerToTable(e);
    if (!p) return;
    chosenSign = sideOfPoint(p);
    setMode('angle');
    enterAnglePreview();
  }
});

// ---------- 디버그/테스트 API ----------
window.__fold = {
  get facets() { return facets; },
  get mode() { return mode; },
  count() { return facets.length; },
  layers() { return facets.map(f => f.layer); },
  foldTable(x1, y1, x2, y2, sx, sy, dir = 'over') {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const u = { x: (x2 - x1) / len, y: (y2 - y1) / len };
    const n = { x: -u.y, y: u.x };
    const s = computeSplit({ x: x1, y: y1 }, u);
    if (!s) return false;
    foldLine = { L0: { x: x1, y: y1 }, u, n };
    split = s;
    chosenSign = ((sx - x1) * n.x + (sy - y1) * n.y) >= 0 ? 1 : -1;
    foldDir = dir;
    commitFold();
    split = null; foldLine = null;
    rebuildScene();
    return true;
  },
  undo() {
    if (!undoStack.length) return false;
    facets = undoStack.pop(); rebuildScene(); return true;
  },
  reset() {
    undoStack.push(structuredClone(facets));
    facets = [initialFacet()]; rebuildScene();
  },
  setLight(on) { lightMode = on; applyMaterialMode(); },
  snapshot() { return structuredClone(facets); },
};

// ---------- 시작 ----------
rebuildTextures();
rebuildScene();
setMode('view');

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
