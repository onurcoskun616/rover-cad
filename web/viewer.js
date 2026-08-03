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
export function loadSimulation(viewer, data, { onUpdate } = {}) {
  // Reuse the static path rendering, then overlay a moving tool.
  loadToolpath(viewer, data);
  const group = viewer.getToolpath();

  // Flatten all operations, in order, into one point sequence carrying the op
  // name and cumulative distance so we can interpolate at any progress value.
  // The tool is parented to the toolpath group, so it uses raw (local) coords
  // that line up with the drawn path (the group itself is offset to origin).
  const seq = [];
  const paths = (data && data.toolpaths) || [];
  for (const p of paths) {
    for (const pt of p.points || []) {
      seq.push({ v: new THREE.Vector3(pt[0], pt[1], pt[2]), op: p.op });
    }
  }

  const cum = [0];
  let total = 0;
  for (let i = 1; i < seq.length; i++) {
    total += seq[i].v.distanceTo(seq[i - 1].v);
    cum.push(total);
  }

  // Tool marker: a small cone pointing down (-Z), sized to the scene.
  const span = total > 0 ? total : 10;
  const toolLen = Math.max(4, span * 0.02);
  const toolR = toolLen * 0.35;
  const tool = new THREE.Mesh(
    new THREE.ConeGeometry(toolR, toolLen, 20),
    new THREE.MeshStandardMaterial({ color: 0xff4d4d, metalness: 0.2, roughness: 0.5 }),
  );
  tool.rotation.x = Math.PI; // point tip toward -Z (into the work)
  if (seq.length) tool.position.copy(seq[0].v);
  // Parent to the toolpath group so it shares the group's offset and is
  // disposed together on the next load.
  if (group) group.add(tool);
  else viewer.scene.add(tool);

  let distance = 0;
  let playing = false;
  let speed = 1;
  const baseMmPerSec = span / 15; // ~15s for a full pass at 1x

  function posAt(d) {
    if (seq.length === 0) return { v: new THREE.Vector3(), op: "" };
    if (d <= 0) return { v: seq[0].v, op: seq[0].op };
    if (d >= total) return { v: seq[seq.length - 1].v, op: seq[seq.length - 1].op };
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
    return { v, op: seq[hi].op };
  }

  function apply() {
    const { v, op } = posAt(distance);
    tool.position.copy(v);
    if (onUpdate) onUpdate({ progress: total > 0 ? distance / total : 0, op });
  }
  apply();

  viewer.setFrameCb((dt) => {
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
      if (distance >= total) distance = 0;
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
