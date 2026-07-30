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
  };
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
