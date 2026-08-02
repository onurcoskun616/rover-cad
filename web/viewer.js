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

  function animate() {
    requestAnimationFrame(animate);
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
