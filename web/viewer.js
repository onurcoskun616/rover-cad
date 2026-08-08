import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function initViewer(container) {
  const width = container.clientWidth;
  const height = container.clientHeight || 400;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x152238);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
  camera.position.set(100, 100, 100);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.replaceChildren(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 1, 1);
  scene.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
  dirLight2.position.set(-1, -1, -1);
  scene.add(dirLight2);

  let currentMesh = null;
  let currentToolpath = null;
  let frameCb = null;
  let lastT = performance.now();

  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    if (frameCb) frameCb(dt);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener("resize", () => {
    const w = container.clientWidth;
    const h = container.clientHeight || 400;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  return {
    scene,
    camera,
    controls,
    getCurrentMesh: () => currentMesh,
    setCurrentMesh: (m) => {
      currentMesh = m;
    },
    getToolpath: () => currentToolpath,
    setToolpath: (t) => {
      currentToolpath = t;
    },
    setFrameCb: (cb) => {
      frameCb = cb;
    },
  };
}

// Animate a tool travelling along the CAM toolpath. Draws the full path
// (cyan cutting / faint orange rapids) plus a moving tool (cone) that follows
// the ordered points. Returns a controller: play/pause/setSpeed/seek + an
// onUpdate({progress, op}) callback for the timeline and operation label.
// `data` is { toolpaths: [{ op, points: [[x,y,z,rapid], ...] }, ...] }.

function generateGcode(data) {
  const lines = [];
  const seqToLine = [];
  lines.push("G90 G21");
  const paths = (data && data.toolpaths) || [];
  for (const p of paths) {
    lines.push(`(--- ${(p.op || "OP").toUpperCase()} ---)`);
    const pts = p.points || [];
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const rapid = pt[3] === 1;
      const cmd = rapid ? "G0" : "G1";
      const feed = rapid ? "" : " F500";
      lines.push(`${cmd} X${pt[0].toFixed(3)} Y${pt[1].toFixed(3)} Z${pt[2].toFixed(3)}${feed}`);
      seqToLine.push(lines.length - 1);
    }
  }
  lines.push("M30");
  return { lines, seqToLine };
}

export function loadSimulation(viewer, data, { onUpdate } = {}) {
  // Reuse the static path rendering, then overlay a moving tool.
  loadToolpath(viewer, data);
  const group = viewer.getToolpath();

  const { lines: gcodeLines, seqToLine } = generateGcode(data);

  // Flatten all operations, in order, into one point sequence carrying the op
  // name and cumulative distance so we can interpolate at any progress value.
  // The tool is parented to the toolpath group, so it uses raw (local) coords
  // that line up with the drawn path (the group itself is offset to origin).
  const seq = [];
  const paths = (data && data.toolpaths) || [];
  for (const p of paths) {
    for (const pt of p.points || []) {
      seq.push({ v: new THREE.Vector3(pt[0], pt[1], pt[2]), op: p.op, rapid: pt[3] === 1 });
    }
  }

  const cum = [0];
  let total = 0;
  for (let i = 1; i < seq.length; i++) {
    total += seq[i].v.distanceTo(seq[i - 1].v);
    cum.push(total);
  }

  // Realistic CNC end mill tool model with holder, shank, and fluted cutter.
  const span = total > 0 ? total : 10;
  const toolLen = Math.max(4, span * 0.02);
  const toolR = toolLen * 0.35;

  const tool = new THREE.Group();
  const spindle = new THREE.Group();
  tool.add(spindle);

  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.85, roughness: 0.25 });
  const midMetal = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.7, roughness: 0.3 });
  const shankMetal = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.6, roughness: 0.3 });
  const cutterMetal = new THREE.MeshStandardMaterial({ color: 0xaabbcc, metalness: 0.9, roughness: 0.12 });
  const fluteMat = new THREE.MeshStandardMaterial({ color: 0xddeeff, metalness: 0.95, roughness: 0.08, side: THREE.DoubleSide });

  const hR = toolR * 1.6;
  const sR = toolR * 0.55;
  const cR = sR;
  const hH = toolLen * 0.22;
  const tH = toolLen * 0.10;
  const sH = toolLen * 0.28;
  const cH = toolLen * 0.35;
  const tipH = toolLen * 0.05;

  let yOff = toolLen / 2;

  const holder = new THREE.Mesh(new THREE.CylinderGeometry(hR, hR, hH, 24), darkMetal);
  holder.position.y = yOff - hH / 2; yOff -= hH;
  spindle.add(holder);

  const taper = new THREE.Mesh(new THREE.CylinderGeometry(hR * 0.85, sR, tH, 24), midMetal);
  taper.position.y = yOff - tH / 2; yOff -= tH;
  spindle.add(taper);

  const shankMesh = new THREE.Mesh(new THREE.CylinderGeometry(sR, sR, sH, 20), shankMetal);
  shankMesh.position.y = yOff - sH / 2; yOff -= sH;
  spindle.add(shankMesh);

  const cutter = new THREE.Mesh(new THREE.CylinderGeometry(cR, cR * 0.92, cH, 20), cutterMetal);
  cutter.position.y = yOff - cH / 2;
  spindle.add(cutter);

  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(cR * 2.15, cH * 0.92, cR * 0.08),
      fluteMat,
    );
    fin.position.y = cutter.position.y;
    fin.rotation.y = (i / 4) * Math.PI * 2;
    spindle.add(fin);
  }
  yOff -= cH;

  const tipMesh = new THREE.Mesh(new THREE.CylinderGeometry(cR * 0.92, cR * 0.3, tipH, 20), cutterMetal);
  tipMesh.position.y = yOff - tipH / 2;
  spindle.add(tipMesh);

  tool.rotation.x = Math.PI;
  if (seq.length) tool.position.copy(seq[0].v);
  if (group) group.add(tool);
  else viewer.scene.add(tool);

  // --- Material removal simulation (heightmap columns) ---
  let stockMesh = null;
  let stockHeights = null;
  let stockGX = 0, stockGY = 0;
  let stkMinX = 0, stkMinY = 0, stkColW = 1, stkColD = 1;
  let stkBaseZ = 0, stkTopZ = 0;
  const stkTmp = new THREE.Object3D();

  if (seq.length > 1) {
    const sb = new THREE.Box3();
    let fMinZ = Infinity, fMaxZ = -Infinity;
    for (const s of seq) {
      sb.expandByPoint(s.v);
      if (!s.rapid) { fMinZ = Math.min(fMinZ, s.v.z); fMaxZ = Math.max(fMaxZ, s.v.z); }
    }
    if (!isFinite(fMinZ)) { fMinZ = sb.min.z; fMaxZ = sb.max.z; }

    if (fMaxZ - fMinZ >= 0.1) {
      const pad = Math.max(1, (sb.max.x - sb.min.x) * 0.08);
      stkMinX = sb.min.x - pad;
      stkMinY = sb.min.y - pad;
      const stkMaxX = sb.max.x + pad;
      const stkMaxY = sb.max.y + pad;
      stkTopZ = fMaxZ + pad * 0.15;
      stkBaseZ = fMinZ - pad * 0.3;
      if (stkBaseZ >= stkTopZ) stkBaseZ = stkTopZ - 1;

      const stkW = stkMaxX - stkMinX;
      const stkD = stkMaxY - stkMinY;
      const cellTarget = Math.max(cR * 0.6, 0.5);
      stockGX = Math.min(80, Math.max(10, Math.round(stkW / cellTarget)));
      stockGY = Math.min(80, Math.max(10, Math.round(stkD / cellTarget)));
      stkColW = stkW / stockGX;
      stkColD = stkD / stockGY;

      stockHeights = new Float32Array(stockGX * stockGY);
      const initH = stkTopZ - stkBaseZ;
      stockHeights.fill(initH);

      const sGeo = new THREE.BoxGeometry(stkColW * 0.97, stkColD * 0.97, 1);
      const sMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.45, roughness: 0.5 });
      stockMesh = new THREE.InstancedMesh(sGeo, sMat, stockGX * stockGY);

      for (let gy = 0; gy < stockGY; gy++)
        for (let gx = 0; gx < stockGX; gx++) setStockCol(gx, gy, initH);
      stockMesh.instanceMatrix.needsUpdate = true;

      if (group) group.add(stockMesh);
      else viewer.scene.add(stockMesh);
    }
  }

  function setStockCol(ix, iy, h) {
    if (h < 0.01) h = 0.01;
    stkTmp.position.set(
      stkMinX + (ix + 0.5) * stkColW,
      stkMinY + (iy + 0.5) * stkColD,
      stkBaseZ + h / 2,
    );
    stkTmp.scale.set(1, 1, h);
    stkTmp.updateMatrix();
    stockMesh.setMatrixAt(iy * stockGX + ix, stkTmp.matrix);
  }

  function cutStock(tx, ty, tz) {
    if (!stockMesh || tz >= stkTopZ) return;
    const ch = Math.max(0.01, tz - stkBaseZ);
    const r = cR;
    const x0 = Math.max(0, Math.floor((tx - r - stkMinX) / stkColW));
    const x1 = Math.min(stockGX - 1, Math.floor((tx + r - stkMinX) / stkColW));
    const y0 = Math.max(0, Math.floor((ty - r - stkMinY) / stkColD));
    const y1 = Math.min(stockGY - 1, Math.floor((ty + r - stkMinY) / stkColD));
    let dirty = false;
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const cx = stkMinX + (ix + 0.5) * stkColW;
        const cy = stkMinY + (iy + 0.5) * stkColD;
        const dx = cx - tx, dy = cy - ty;
        if (dx * dx + dy * dy <= r * r) {
          const idx = iy * stockGX + ix;
          if (ch < stockHeights[idx]) {
            stockHeights[idx] = ch;
            setStockCol(ix, iy, ch);
            dirty = true;
          }
        }
      }
    }
    if (dirty) stockMesh.instanceMatrix.needsUpdate = true;
  }

  function resetStock() {
    if (!stockMesh) return;
    const initH = stkTopZ - stkBaseZ;
    stockHeights.fill(initH);
    for (let gy = 0; gy < stockGY; gy++)
      for (let gx = 0; gx < stockGX; gx++) setStockCol(gx, gy, initH);
    stockMesh.instanceMatrix.needsUpdate = true;
  }

  let distance = 0;
  let playing = false;
  let speed = 1;
  const baseMmPerSec = span / 15; // ~15s for a full pass at 1x

  function posAt(d) {
    if (seq.length === 0) return { v: new THREE.Vector3(), op: "", idx: 0 };
    if (d <= 0) return { v: seq[0].v, op: seq[0].op, idx: 0 };
    if (d >= total) return { v: seq[seq.length - 1].v, op: seq[seq.length - 1].op, idx: seq.length - 1 };
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo] || 1;
    const t = (d - cum[lo]) / segLen;
    const v = seq[lo].v.clone().lerp(seq[hi].v, t);
    return { v, op: seq[hi].op, idx: hi };
  }

  function apply() {
    const { v, op, idx } = posAt(distance);
    tool.position.copy(v);
    const lineIndex = (seqToLine && seqToLine[idx]) ?? 0;
    const rapid = seq[idx]?.rapid ?? false;
    if (!rapid) cutStock(v.x, v.y, v.z);
    if (onUpdate) onUpdate({
      progress: total > 0 ? distance / total : 0,
      op,
      x: v.x, y: v.y, z: v.z,
      f: rapid ? 9999 : 500,
      lineIndex,
    });
  }
  apply();

  viewer.setFrameCb((dt) => {
    spindle.rotation.y += dt * 15;
    if (!playing || total === 0) return;
    distance += baseMmPerSec * speed * dt;
    if (distance >= total) {
      distance = total;
      playing = false;
    }
    apply();
  });

  return {
    play() {
      if (distance >= total) { distance = 0; resetStock(); }
      playing = true;
    },
    pause() {
      playing = false;
    },
    isPlaying: () => playing,
    setSpeed(m) {
      speed = m;
    },
    seek(t01) {
      distance = Math.max(0, Math.min(1, t01)) * total;
      apply();
    },
    gcodeLines,
  };
}

// Render a CAM toolpath preview: cutting moves in cyan, rapids faint orange.
// `data` is { toolpaths: [{ op, points: [[x,y,z,rapid], ...] }, ...] }.
export function loadToolpath(viewer, data) {
  const mesh = viewer.getCurrentMesh();
  if (mesh) {
    viewer.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    viewer.setCurrentMesh(null);
  }
  const prev = viewer.getToolpath();
  if (prev) {
    viewer.scene.remove(prev);
    prev.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  const group = new THREE.Group();
  const feedPts = [];
  const rapidPts = [];
  const box = new THREE.Box3();
  const paths = (data && data.toolpaths) || [];
  for (const p of paths) {
    const pts = p.points || [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const va = new THREE.Vector3(a[0], a[1], a[2]);
      const vb = new THREE.Vector3(b[0], b[1], b[2]);
      box.expandByPoint(va);
      box.expandByPoint(vb);
      if (b[3] === 1) rapidPts.push(va, vb);
      else feedPts.push(va, vb);
    }
  }

  function addSegments(points, color, opacity) {
    if (!points.length) return;
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const m = new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
    });
    group.add(new THREE.LineSegments(g, m));
  }
  addSegments(feedPts, 0x22d3ee, 1.0);
  addSegments(rapidPts, 0xf59e0b, 0.35);

  const center = new THREE.Vector3();
  box.getCenter(center);
  group.position.sub(center);
  viewer.scene.add(group);
  viewer.setToolpath(group);

  const size = new THREE.Vector3();
  box.getSize(size);
  const radius = Math.max(size.length() / 2, 10);
  viewer.camera.position.set(radius * 2.2, radius * 1.6, radius * 2.2);
  viewer.camera.lookAt(0, 0, 0);
  viewer.controls.target.set(0, 0, 0);
  viewer.controls.update();
}

export function loadStl(viewer, url) {
  const loader = new STLLoader();
  loader.load(
    url,
    (geometry) => {
      const existing = viewer.getCurrentMesh();
      if (existing) {
        viewer.scene.remove(existing);
        existing.geometry.dispose();
        existing.material.dispose();
      }

      geometry.center();
      geometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({
        color: 0x2563eb,
        metalness: 0.15,
        roughness: 0.55,
      });
      const mesh = new THREE.Mesh(geometry, material);
      viewer.scene.add(mesh);
      viewer.setCurrentMesh(mesh);

      geometry.computeBoundingSphere();
      const radius = geometry.boundingSphere?.radius || 50;
      viewer.camera.position.set(radius * 2.2, radius * 1.6, radius * 2.2);
      viewer.camera.lookAt(0, 0, 0);
      viewer.controls.target.set(0, 0, 0);
      viewer.controls.update();
    },
    undefined,
    (err) => {
      console.error("STL dosyası yüklenemedi:", err);
    },
  );
}
