import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ============================================================
   종이 접기 3D — 평면 접기(flat fold) + 오리기 + 옮기기
   종이 = 볼록 다각형 조각(facet)들의 목록.
   facet = { pts: 종이좌표 다각형(CCW), T: 종이→테이블 2D 등거리변환, layer: 정수, pieceId: 조각 번호 }
   접기 = "잡은 점 P를 놓은 점 Q로" — 접는 선은 PQ의 수직이등분선 (P가 속한 조각만 접힘)
   오리기 = 직선으로 전 조각 클리핑, 양쪽에 다른 pieceId 부여
   ============================================================ */

const LAYER_EPS = 0.1;        // 층 간격 (종이 두께)
const MIN_AREA = 0.02;        // 이 미만 조각은 버림
const BASE_H = 29.7;          // 종이 높이 고정(A4), 폭은 이미지 비율 따름
const FOLD_ANIM_MS = 150;     // 놓은 뒤 정착 애니메이션 시간

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
function rotationAround(c, ang) { // 점 c 중심 회전 행렬
  const co = Math.cos(ang), si = Math.sin(ang);
  return {
    m00: co, m01: -si, m10: si, m11: co,
    tx: c.x - (co * c.x - si * c.y),
    ty: c.y - (si * c.x + co * c.y),
  };
}
function composeRT(R, T) { // (행렬 R) ∘ (변환 T)
  return {
    a: R.m00 * T.a + R.m01 * T.c,
    b: R.m00 * T.b + R.m01 * T.d,
    c: R.m10 * T.a + R.m11 * T.c,
    d: R.m10 * T.b + R.m11 * T.d,
    tx: R.m00 * T.tx + R.m01 * T.ty + R.tx,
    ty: R.m10 * T.tx + R.m11 * T.ty + R.ty,
  };
}
const translateT = (T, dx, dy) => ({ ...T, tx: T.tx + dx, ty: T.ty + dy });

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
// Sutherland-Hodgman: gvals[i] 부호 기준으로 반평면 클리핑
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
function pointInConvex(p, pts) { // 볼록 다각형(임의 와인딩) 내부 판정
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cr) < 1e-9) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ---------- 상태 ----------
function initialFacet() {
  return {
    pts: [{ x: 0, y: 0 }, { x: paperW, y: 0 }, { x: paperW, y: paperH }, { x: 0, y: paperH }],
    T: { a: 1, b: 0, c: 0, d: 1, tx: -paperW / 2, ty: -paperH / 2 },
    layer: 0,
    pieceId: 0,
  };
}
let facets = [initialFacet()];
const undoStack = [];
let mode = 'view';           // view | fold | cut | move
let lightMode = false;
let foldDir = 'over';        // over | under
let selectedPiece = null;    // 옮기기 모드에서 마지막으로 잡은 조각

function pushUndo() { undoStack.push(structuredClone(facets)); if (undoStack.length > 60) undoStack.shift(); }
function maxLayer() { return Math.max(...facets.map(f => f.layer)); }
function nextPieceId() { return Math.max(...facets.map(f => f.pieceId)) + 1; }

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

// 도구 모드에서는 좌클릭/한 손가락 = 도구, 우클릭/두 손가락 = 회전
function setControlsForTool(toolActive) {
  controls.enabled = true;
  if (toolActive) {
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  } else {
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
}

// 카메라 극각(polar) 애니메이션 — THREE.Spherical은 Y축 극이라 Z-up에 맞게 쿼터니언 보정
let flipAnim = null;
const _sph = new THREE.Spherical();
const _upQ = new THREE.Quaternion();
const _upQInv = new THREE.Quaternion();
function getPolar() {
  _upQ.setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
  _upQInv.copy(_upQ).invert();
  const off = camera.position.clone().sub(controls.target).applyQuaternion(_upQ);
  _sph.setFromVector3(off);
  return _sph;
}
function setPolar(r, phi, theta) {
  const v = new THREE.Vector3().setFromSphericalCoords(r, phi, theta).applyQuaternion(_upQInv);
  camera.position.copy(controls.target).add(v);
}
function animatePolarTo(phiTarget) {
  const s = getPolar();
  flipAnim = { t0: performance.now(), from: s.phi, to: phiTarget, theta: s.theta, r: s.radius };
}
function startFlip() {
  const s = getPolar();
  animatePolarTo(Math.min(Math.PI - 0.03, Math.max(0.03, Math.PI - s.phi)));
}
function alignTopDown() { // 보고 있던 면의 정면으로
  const s = getPolar();
  animatePolarTo(s.phi > Math.PI / 2 ? Math.PI - 0.12 : 0.12);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- 텍스처 ----------
let frontImg = null, backImg = null;
let texFront, texBack, texCombined;

function makeDefaultSide(label, bg) {
  const c = document.createElement('canvas');
  c.width = 724; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 6;
  g.strokeRect(14, 14, c.width - 28, c.height - 28);
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.font = 'bold 130px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, c.width / 2, c.height / 2);
  return c;
}

function rebuildTextures() {
  const srcFront = frontImg || makeDefaultSide('앞', '#fdfdf8');
  const srcBack = backImg || makeDefaultSide('뒤', '#f3ecd9');
  const fw = srcFront.width || srcFront.naturalWidth;
  const fh = srcFront.height || srcFront.naturalHeight;
  const scale = Math.min(1, 2048 / Math.max(fw, fh));
  const w = Math.max(64, Math.round(fw * scale));
  const h = Math.max(64, Math.round(fh * scale));

  const cf = document.createElement('canvas'); cf.width = w; cf.height = h;
  cf.getContext('2d').drawImage(srcFront, 0, 0, w, h);

  // 뒷면: 좌우 미러 (실물 종이를 뒤에서 보는 좌표와 일치)
  const cb = document.createElement('canvas'); cb.width = w; cb.height = h;
  const gb = cb.getContext('2d');
  gb.translate(w, 0); gb.scale(-1, 1);
  gb.drawImage(srcBack, 0, 0, w, h);

  // 빛에 비추기: 앞면 × 미러된 뒷면
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
const matCutLine = new THREE.LineBasicMaterial({ color: 0x66d9ff });
const matFoldDash = new THREE.LineDashedMaterial({ color: 0xff4455, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.6 });
const matCutDash = new THREE.LineDashedMaterial({ color: 0x66d9ff, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.6 });
const matHighlight = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthTest: false });
const matPieceSel = new THREE.MeshBasicMaterial({ color: 0x4f7cff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthTest: false });

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
const paperGroup = new THREE.Group();     // 고정된 facet
const previewGroup = new THREE.Group();   // 접히는 중/옮기는 중 facet (행렬 애니메이션)
const overlayGroup = new THREE.Group();   // 선·하이라이트
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
  // 조각 테두리 — 인덱스 없이 외곽 정점만 연결
  const z = facet.layer * LAYER_EPS + 0.012;
  const edgePts = facet.pts.map(p => {
    const tp = applyT(facet.T, p);
    return new THREE.Vector3(tp.x, tp.y, z);
  });
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(edgePts), matEdge);
  edge.renderOrder = 3000;
  group.add(edge);
}

function clearGroup(g) {
  for (const child of [...g.children]) {
    child.geometry?.dispose();
    g.remove(child);
  }
}

// excludeTest: 해당 facet은 previewGroup으로 (애니메이션용)
function rebuildScene(excludeTest = null) {
  clearGroup(paperGroup); clearGroup(previewGroup); clearGroup(overlayGroup);
  previewGroup.matrix.identity();
  for (const f of facets) {
    if (excludeTest && excludeTest(f)) buildFacetInto(previewGroup, f);
    else buildFacetInto(paperGroup, f);
  }
  refreshSnapCache();
}

// ---------- 스냅 ----------
let snapCache = [];
function refreshSnapCache() {
  snapCache = [];
  const seen = new Set();
  for (const f of facets) {
    const z = f.layer * LAYER_EPS;
    const tp = f.pts.map(p => applyT(f.T, p));
    for (let i = 0; i < tp.length; i++) {
      const a = tp[i], b = tp[(i + 1) % tp.length];
      for (const c of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
        const key = `${Math.round(c.x * 25)},${Math.round(c.y * 25)}`;
        if (!seen.has(key)) { seen.add(key); snapCache.push({ x: c.x, y: c.y, z }); }
      }
    }
  }
}

const SNAP_PX = 20;
function snapPoint(p, e) {
  if (e.shiftKey) return { point: p, snapped: false };
  const rect = canvas.getBoundingClientRect();
  let best = null, bestD = Infinity;
  const v = new THREE.Vector3();
  for (const c of snapCache) {
    v.set(c.x, c.y, c.z).project(camera);
    const sx = (v.x + 1) / 2 * rect.width + rect.left;
    const sy = (-v.y + 1) / 2 * rect.height + rect.top;
    const d = Math.hypot(sx - e.clientX, sy - e.clientY);
    if (d < SNAP_PX && d < bestD) { bestD = d; best = c; }
  }
  return best ? { point: { x: best.x, y: best.y }, snapped: true } : { point: p, snapped: false };
}
function snapAngle(p0, p1) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return p1;
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 12;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) < THREE.MathUtils.degToRad(4)) {
    return { x: p0.x + Math.cos(snapped) * len, y: p0.y + Math.sin(snapped) * len };
  }
  return p1;
}

const snapMarkerMat = new THREE.MeshBasicMaterial({ color: 0x33ff88, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.95 });
const snapMarkerA = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.5, 24), snapMarkerMat);
const snapMarkerB = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.5, 24), snapMarkerMat);
snapMarkerA.renderOrder = snapMarkerB.renderOrder = 6000;
snapMarkerA.visible = snapMarkerB.visible = false;
scene.add(snapMarkerA, snapMarkerB);
function placeMarker(marker, p, on) {
  marker.visible = on;
  if (on) marker.position.set(p.x, p.y, maxLayer() * LAYER_EPS + 0.06);
}
function hideMarkers() { snapMarkerA.visible = snapMarkerB.visible = false; }

// ---------- 선/하이라이트 표시 ----------
function drawLineVisual(p0, p1, solidMat, dashMat) {
  clearLineVisual();
  const zTop = maxLayer() * LAYER_EPS + 0.05;
  const seg = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(p0.x, p0.y, zTop), new THREE.Vector3(p1.x, p1.y, zTop),
  ]);
  const line = new THREE.Line(seg, solidMat);
  line.userData.isLine = true;
  line.renderOrder = 5000;
  overlayGroup.add(line);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const ext = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(p0.x - ux * 200, p0.y - uy * 200, zTop),
    new THREE.Vector3(p1.x + ux * 200, p1.y + uy * 200, zTop),
  ]);
  const dash = new THREE.Line(ext, dashMat);
  dash.computeLineDistances();
  dash.userData.isLine = true;
  dash.renderOrder = 4999;
  overlayGroup.add(dash);
}
function clearLineVisual() {
  for (const c of [...overlayGroup.children]) {
    if (c.userData.isLine) { c.geometry?.dispose(); overlayGroup.remove(c); }
  }
}
function showHighlight(pieces, mat = matHighlight) {
  clearHighlight();
  for (const f of pieces) {
    const geo = facetGeometry(f, f.layer * LAYER_EPS + 0.03);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.isHighlight = true;
    mesh.renderOrder = 4500;
    overlayGroup.add(mesh);
  }
}
function clearHighlight() {
  for (const c of [...overlayGroup.children]) {
    if (c.userData.isHighlight) { c.geometry?.dispose(); overlayGroup.remove(c); }
  }
}

// ---------- 조각 판정 ----------
function pieceAt(p) { // 점 아래 가장 위층 facet의 pieceId (없으면 null)
  let best = null, bestLayer = -Infinity;
  for (const f of facets) {
    const tp = f.pts.map(q => applyT(f.T, q));
    if (pointInConvex(p, tp) && f.layer > bestLayer) { bestLayer = f.layer; best = f.pieceId; }
  }
  return best;
}

// ---------- 접기 연산 ----------
// 조각 pieceId를 직선(L0,u)으로 분할. 나머지 facet은 keep으로.
function splitPiece(L0, u, pieceId) {
  const n = { x: -u.y, y: u.x };
  const pos = [], neg = [], keep = [];
  for (const f of facets) {
    if (f.pieceId !== pieceId) { keep.push(f); continue; }
    const gvals = f.pts.map(p => {
      const tp = applyT(f.T, p);
      return (tp.x - L0.x) * n.x + (tp.y - L0.y) * n.y;
    });
    const pPos = clipPoly(f.pts, gvals, true);
    const pNeg = clipPoly(f.pts, gvals, false);
    if (pPos.length >= 3 && polyArea(pPos) > MIN_AREA) pos.push({ ...f, pts: pPos });
    if (pNeg.length >= 3 && polyArea(pNeg) > MIN_AREA) neg.push({ ...f, pts: pNeg });
  }
  if (pos.length === 0 || neg.length === 0) return null;
  return { pos, neg, keep, n };
}

// 접기 커밋: fold 조각들을 (L0,u) 반사, 층 재배치
function commitFoldPieces(stay, fold, keep, L0, u, dir) {
  const R = reflectAcross(L0, u);
  const stayLayers = stay.map(f => f.layer);
  const foldLayers = fold.map(f => f.layer);
  const maxStay = Math.max(...stayLayers), minStay = Math.min(...stayLayers);
  const maxFold = Math.max(...foldLayers), minFold = Math.min(...foldLayers);

  const out = [...keep, ...stay.map(f => ({ ...f }))];
  for (const f of fold) {
    const layer = dir === 'over'
      ? maxStay + 1 + (maxFold - f.layer)
      : minStay - 1 - (f.layer - minFold);
    out.push({ ...f, T: composeRT(R, f.T), layer });
  }
  const minL = Math.min(...out.map(f => f.layer));
  for (const f of out) f.layer -= minL;
  pushUndo();
  facets = out;
}

// ---------- 접기 제스처 (잡아서 끌기 — 실시간으로 따라 접힘) ----------
// P(잡은 점) → Q(현재 커서): 접는 선 = PQ의 수직이등분선, P쪽 플랩이 커서를 따라 넘어옴
let foldDrag = null;        // { P, pieceId }
let foldAnim = null;        // { t0, fromK, stay, fold, keep, L0, u, dir, sign } — 놓은 뒤 정착 애니메이션
const DRAG_K = 0.93;        // 드래그 중 플랩 각도 (180°보다 살짝 덜 접어 들려 있는 느낌)
let lastPreviewBuild = 0;

function computeFoldPre(P, Q, pieceId) { // 순수 계산 (그리기 없음)
  const dx = Q.x - P.x, dy = Q.y - P.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.6) return null;
  const nrm = { x: dx / len, y: dy / len };           // P→Q 방향 (접는 선의 법선)
  const L0 = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
  const u = { x: -nrm.y, y: nrm.x };                   // 접는 선 방향
  const s = splitPiece(L0, u, pieceId);
  if (!s) return null;
  const gP = (P.x - L0.x) * s.n.x + (P.y - L0.y) * s.n.y;
  return {
    stay: gP >= 0 ? s.neg : s.pos,
    fold: gP >= 0 ? s.pos : s.neg,
    keep: s.keep,
    L0, u,
    sign: gP >= 0 ? 1 : -1,
  };
}

function applyFoldMatrix(pre, k, dir) {
  const zTop = maxLayer() * LAYER_EPS;
  const hingeZ = dir === 'over' ? zTop / 2 + LAYER_EPS * 0.5 : -LAYER_EPS * 0.5;
  const axis = new THREE.Vector3(pre.u.x * pre.sign, pre.u.y * pre.sign, 0).normalize();
  const theta = Math.PI * k * (dir === 'over' ? 1 : -1);
  const M = new THREE.Matrix4()
    .makeTranslation(pre.L0.x, pre.L0.y, hingeZ)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, theta))
    .multiply(new THREE.Matrix4().makeTranslation(-pre.L0.x, -pre.L0.y, -hingeZ));
  previewGroup.matrix.copy(M);
}

// 드래그 중 실시간 미리보기: stay+keep은 고정, fold 플랩은 커서를 따라 접힌 상태로
function renderFoldDragPreview(pre) {
  const now = performance.now();
  if (now - lastPreviewBuild > 24) { // 지오메트리 재생성은 ~40fps로 제한
    lastPreviewBuild = now;
    clearGroup(paperGroup); clearGroup(previewGroup);
    for (const f of [...pre.keep, ...pre.stay]) buildFacetInto(paperGroup, f);
    for (const f of pre.fold) buildFacetInto(previewGroup, f);
  }
  applyFoldMatrix(pre, DRAG_K, foldDir);
  drawLineVisual(
    { x: pre.L0.x - pre.u.x * 6, y: pre.L0.y - pre.u.y * 6 },
    { x: pre.L0.x + pre.u.x * 6, y: pre.L0.y + pre.u.y * 6 },
    matFoldLine, matFoldDash
  );
}

function startFoldSettle(pre) { // 놓는 순간: 현재 각도 → 180° 로 짧게 정착
  clearGroup(paperGroup); clearGroup(previewGroup); clearGroup(overlayGroup);
  previewGroup.matrix.identity();
  for (const f of [...pre.keep, ...pre.stay]) buildFacetInto(paperGroup, f);
  for (const f of pre.fold) buildFacetInto(previewGroup, f);
  applyFoldMatrix(pre, DRAG_K, foldDir);
  foldAnim = { t0: performance.now(), fromK: DRAG_K, ...pre, dir: foldDir };
}

function finishFoldAnim() {
  const a = foldAnim;
  foldAnim = null;
  commitFoldPieces(a.stay, a.fold, a.keep, a.L0, a.u, a.dir);
  rebuildScene();
}

// ---------- 오리기 ----------
function cutAll(L0, u) {
  const n = { x: -u.y, y: u.x };
  const out = [];
  const sidesByPiece = new Map(); // pieceId -> {pos:bool, neg:bool}
  const parts = [];
  for (const f of facets) {
    const gvals = f.pts.map(p => {
      const tp = applyT(f.T, p);
      return (tp.x - L0.x) * n.x + (tp.y - L0.y) * n.y;
    });
    const pPos = clipPoly(f.pts, gvals, true);
    const pNeg = clipPoly(f.pts, gvals, false);
    const hasPos = pPos.length >= 3 && polyArea(pPos) > MIN_AREA;
    const hasNeg = pNeg.length >= 3 && polyArea(pNeg) > MIN_AREA;
    const rec = sidesByPiece.get(f.pieceId) || { pos: false, neg: false };
    rec.pos = rec.pos || hasPos; rec.neg = rec.neg || hasNeg;
    sidesByPiece.set(f.pieceId, rec);
    if (hasPos) parts.push({ ...f, pts: pPos, __side: 1 });
    if (hasNeg) parts.push({ ...f, pts: pNeg, __side: -1 });
  }
  // 실제로 잘린 조각이 있는지 (양쪽에 걸친 piece 존재 여부)
  let anySplit = false;
  for (const rec of sidesByPiece.values()) if (rec.pos && rec.neg) anySplit = true;
  if (!anySplit) return false;
  // 양쪽에 걸친 piece: neg쪽에 새 pieceId 부여
  let nid = nextPieceId();
  const newIdFor = new Map();
  for (const [pid, rec] of sidesByPiece) {
    if (rec.pos && rec.neg) newIdFor.set(pid, nid++);
  }
  for (const p of parts) {
    const mapped = (p.__side === -1 && newIdFor.has(p.pieceId)) ? newIdFor.get(p.pieceId) : p.pieceId;
    const { __side, ...rest } = p;
    out.push({ ...rest, pieceId: mapped });
  }
  pushUndo();
  facets = out;
  return true;
}

// ---------- 옮기기 ----------
let moveDrag = null; // { pieceId, start, cur }

function bakeMove(pieceId, dx, dy) {
  pushUndo();
  // 옮긴 조각을 다른 모든 조각 위로 올림 (집었다 놓는 느낌)
  const others = facets.filter(f => f.pieceId !== pieceId);
  const mine = facets.filter(f => f.pieceId === pieceId);
  const base = others.length ? Math.max(...others.map(f => f.layer)) + 1 : 0;
  const minMine = Math.min(...mine.map(f => f.layer));
  for (const f of mine) {
    f.T = translateT(f.T, dx, dy);
    f.layer = base + (f.layer - minMine);
  }
  const minL = Math.min(...facets.map(f => f.layer));
  for (const f of facets) f.layer -= minL;
}

function rotatePiece(pieceId, deg) {
  const mine = facets.filter(f => f.pieceId === pieceId);
  if (!mine.length) return;
  // 조각 중심 계산
  let cx = 0, cy = 0, cnt = 0;
  for (const f of mine) {
    for (const p of f.pts) {
      const tp = applyT(f.T, p);
      cx += tp.x; cy += tp.y; cnt++;
    }
  }
  const R = rotationAround({ x: cx / cnt, y: cy / cnt }, THREE.MathUtils.degToRad(deg));
  pushUndo();
  for (const f of mine) f.T = composeRT(R, f.T);
}

// ---------- UI ----------
const hint = document.getElementById('hint');
const dirPanel = document.getElementById('dirPanel');
const rotPanel = document.getElementById('rotPanel');
const btnFold = document.getElementById('btnFold');
const btnCut = document.getElementById('btnCut');
const btnMove = document.getElementById('btnMove');
const btnLight = document.getElementById('btnLight');
const dirOverBtn = document.getElementById('dirOver');
const dirUnderBtn = document.getElementById('dirUnder');

function setHint(t) { hint.textContent = t; }

const HINTS = {
  view: '드래그로 회전 · 휠/핀치로 확대축소',
  fold: '접을 부분을 잡고 끌면 따라 접혀요 — 원하는 곳에서 놓기 (모서리 자석) · 우클릭 회전',
  cut: '드래그로 자를 선을 그으세요 · 우클릭 회전',
  move: '조각을 잡아 끌어서 옮기세요 · 우클릭 회전',
};

function setMode(m) {
  if (foldAnim) return; // 접히는 중엔 무시
  mode = m;
  dirPanel.classList.toggle('hidden', m !== 'fold');
  rotPanel.classList.toggle('hidden', m !== 'move');
  btnFold.classList.toggle('active', m === 'fold');
  btnCut.classList.toggle('active', m === 'cut');
  btnMove.classList.toggle('active', m === 'move');
  setControlsForTool(m !== 'view');
  canvas.style.cursor = (m === 'fold' || m === 'move') ? 'grab' : (m === 'cut') ? 'crosshair' : 'default';
  hideMarkers(); clearLineVisual(); clearHighlight();
  foldDrag = null; moveDrag = null;
  setHint(HINTS[m]);
  if (m === 'fold' || m === 'cut') alignTopDown();
}

function toggleTool(m) { setMode(mode === m ? 'view' : m); }
btnFold.addEventListener('click', () => toggleTool('fold'));
btnCut.addEventListener('click', () => toggleTool('cut'));
btnMove.addEventListener('click', () => toggleTool('move'));

document.getElementById('btnUndo').addEventListener('click', () => {
  if (foldAnim) return;
  if (undoStack.length === 0) { setHint('되돌릴 동작이 없어요'); return; }
  facets = undoStack.pop();
  selectedPiece = null;
  rebuildScene();
});

document.getElementById('btnReset').addEventListener('click', () => {
  if (foldAnim) return;
  if (facets.length === 1) return;
  pushUndo();
  facets = [initialFacet()];
  selectedPiece = null;
  rebuildScene();
});

document.getElementById('btnFlip').addEventListener('click', () => startFlip());

btnLight.addEventListener('click', () => {
  lightMode = !lightMode;
  btnLight.classList.toggle('active', lightMode);
  applyMaterialMode();
});

dirOverBtn.addEventListener('click', () => { foldDir = 'over'; dirOverBtn.classList.add('active'); dirUnderBtn.classList.remove('active'); });
dirUnderBtn.addEventListener('click', () => { foldDir = 'under'; dirUnderBtn.classList.add('active'); dirOverBtn.classList.remove('active'); });

document.getElementById('rotCCW').addEventListener('click', () => {
  if (selectedPiece == null) { setHint('먼저 조각을 클릭/드래그해서 선택하세요'); return; }
  rotatePiece(selectedPiece, 15); rebuildScene(); highlightSelected();
});
document.getElementById('rotCW').addEventListener('click', () => {
  if (selectedPiece == null) { setHint('먼저 조각을 클릭/드래그해서 선택하세요'); return; }
  rotatePiece(selectedPiece, -15); rebuildScene(); highlightSelected();
});

function highlightSelected() {
  if (selectedPiece == null) return;
  showHighlight(facets.filter(f => f.pieceId === selectedPiece), matPieceSel);
}

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
    const aspect = frontImg.naturalWidth / frontImg.naturalHeight;
    paperH = BASE_H;
    paperW = Math.min(60, Math.max(5, BASE_H * aspect));
    facets = [initialFacet()];
    undoStack.length = 0;
    selectedPiece = null;
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

// ---------- 포인터 ----------
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

let cutDrag = null; // { p0, p1 }
let lastFoldPreview = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary || foldAnim) return;
  const raw = pointerToTable(e);
  if (!raw) return;

  if (mode === 'fold') {
    const s = snapPoint(raw, e);
    const pid = pieceAt(s.point) ?? pieceAt(raw);
    if (pid == null) return;
    foldDrag = { P: s.point, pieceId: pid };
    placeMarker(snapMarkerA, s.point, s.snapped);
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    canvas.style.cursor = 'grabbing';
  } else if (mode === 'cut') {
    const s = snapPoint(raw, e);
    cutDrag = { p0: s.point, p1: s.point };
    placeMarker(snapMarkerA, s.point, s.snapped);
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  } else if (mode === 'move') {
    const pid = pieceAt(raw);
    if (pid == null) return;
    selectedPiece = pid;
    moveDrag = { pieceId: pid, start: raw, cur: raw };
    rebuildScene(f => f.pieceId === pid); // 잡은 조각을 previewGroup으로
    highlightSelected();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (foldAnim) return;
  const raw = pointerToTable(e);
  if (!raw) return;

  if (mode === 'fold' && foldDrag) {
    const s = snapPoint(raw, e);
    placeMarker(snapMarkerB, s.point, s.snapped);
    const pre = computeFoldPre(foldDrag.P, s.point, foldDrag.pieceId);
    if (pre) {
      renderFoldDragPreview(pre); // 플랩이 커서를 따라 실시간으로 접힘
    } else if (lastFoldPreview) {
      rebuildScene(); clearLineVisual(); // 유효 범위를 벗어나면 원상 표시
    }
    lastFoldPreview = pre;
  } else if (mode === 'fold') {
    const s = snapPoint(raw, e);
    placeMarker(snapMarkerA, s.point, s.snapped);
  } else if (mode === 'cut' && cutDrag) {
    const s = snapPoint(raw, e);
    cutDrag.p1 = s.snapped ? s.point : snapAngle(cutDrag.p0, s.point);
    placeMarker(snapMarkerB, cutDrag.p1, s.snapped);
    drawLineVisual(cutDrag.p0, cutDrag.p1, matCutLine, matCutDash);
  } else if (mode === 'cut') {
    const s = snapPoint(raw, e);
    placeMarker(snapMarkerA, s.point, s.snapped);
  } else if (mode === 'move' && moveDrag) {
    moveDrag.cur = raw;
    const dx = raw.x - moveDrag.start.x, dy = raw.y - moveDrag.start.y;
    previewGroup.matrix.makeTranslation(dx, dy, 1.2); // 살짝 들어올린 느낌
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (mode === 'fold' && foldDrag) {
    const pre = lastFoldPreview;
    foldDrag = null; lastFoldPreview = null;
    hideMarkers(); clearLineVisual(); clearHighlight();
    canvas.style.cursor = 'grab';
    if (pre) startFoldSettle(pre);
    else rebuildScene();
  } else if (mode === 'cut' && cutDrag) {
    const { p0, p1 } = cutDrag;
    cutDrag = null;
    hideMarkers(); clearLineVisual();
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (len < 0.8) return;
    const u = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len };
    if (cutAll(p0, u)) {
      rebuildScene();
      setHint('싹둑! ✋ 옮기기로 조각을 움직여보세요');
    } else {
      setHint('선이 종이를 지나야 잘려요');
    }
  } else if (mode === 'move' && moveDrag) {
    const { pieceId, start, cur } = moveDrag;
    moveDrag = null;
    canvas.style.cursor = 'grab';
    const dx = cur.x - start.x, dy = cur.y - start.y;
    if (Math.hypot(dx, dy) > 0.15) bakeMove(pieceId, dx, dy);
    rebuildScene();
    highlightSelected();
  }
});

// ---------- 디버그/테스트 API ----------
window.__fold = {
  get facets() { return facets; },
  get mode() { return mode; },
  count() { return facets.length; },
  layers() { return facets.map(f => f.layer); },
  pieces() { return [...new Set(facets.map(f => f.pieceId))]; },
  grabFold(px, py, qx, qy, dir = 'over') { // 잡아 끌기 접기 (즉시 커밋)
    const pid = pieceAt({ x: px, y: py });
    if (pid == null) return false;
    const pre = computeFoldPre({ x: px, y: py }, { x: qx, y: qy }, pid);
    if (!pre) return false;
    commitFoldPieces(pre.stay, pre.fold, pre.keep, pre.L0, pre.u, dir);
    rebuildScene();
    return true;
  },
  cut(x1, y1, x2, y2) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const u = { x: (x2 - x1) / len, y: (y2 - y1) / len };
    const ok = cutAll({ x: x1, y: y1 }, u);
    if (ok) rebuildScene();
    return ok;
  },
  movePiece(pid, dx, dy) { bakeMove(pid, dx, dy); rebuildScene(); },
  rotate(pid, deg) { rotatePiece(pid, deg); rebuildScene(); },
  pieceAt(x, y) { return pieceAt({ x, y }); },
  undo() {
    if (!undoStack.length) return false;
    facets = undoStack.pop(); selectedPiece = null; rebuildScene(); return true;
  },
  reset() { pushUndo(); facets = [initialFacet()]; selectedPiece = null; rebuildScene(); },
  setLight(on) { lightMode = on; applyMaterialMode(); },
  camPos() { return camera.position.toArray().map(v => Math.round(v * 10) / 10); },
  flipNow() {
    startFlip();
    if (flipAnim) { setPolar(flipAnim.r, flipAnim.to, flipAnim.theta); flipAnim = null; }
  },
  snapAt(x, y) { return snapCache.filter(c => Math.hypot(c.x - x, c.y - y) < 2); },
};

// ---------- 시작 ----------
rebuildTextures();
rebuildScene();
setMode('view');

function animate() {
  requestAnimationFrame(animate);
  if (flipAnim) {
    const k = Math.min(1, (performance.now() - flipAnim.t0) / 500);
    const e = k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k;
    const phi = flipAnim.from + (flipAnim.to - flipAnim.from) * e;
    setPolar(flipAnim.r, phi, flipAnim.theta);
    if (k >= 1) flipAnim = null;
  }
  if (foldAnim) {
    const t = Math.min(1, (performance.now() - foldAnim.t0) / FOLD_ANIM_MS);
    const k = foldAnim.fromK + (1 - foldAnim.fromK) * t;
    applyFoldMatrix(foldAnim, k, foldAnim.dir);
    if (t >= 1) finishFoldAnim();
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();
