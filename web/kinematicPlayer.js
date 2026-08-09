import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const PART_COLORS = [0x2563eb, 0x16a34a, 0xd97706, 0x9333ea, 0xdc2626, 0x0891b2];

function loadStlAsync(url) {
  return new Promise((resolve, reject) => {
    new STLLoader().load(url, resolve, undefined, reject);
  });
}

/**
 * Load a kinematic simulation into the Three.js viewer.
 *
 * @param {object} viewer        - viewer instance from initViewer
 * @param {{name:string, url:string}[]} partUrls - per-part STL URLs
 * @param {object} kinData       - parsed kinematics.json
 * @param {{onUpdate?, onCollision?}} opts
 * @returns {Promise<{play,pause,isPlaying,setSpeed,seek,reset}>}
 */
export async function loadKinematicSim(viewer, partUrls, kinData, opts = {}) {
  const { onUpdate, onCollision } = opts;

  // --- clear previous scene objects ---
  const oldMesh = viewer.getCurrentMesh();
  if (oldMesh) {
    viewer.scene.remove(oldMesh);
    oldMesh.geometry?.dispose();
    oldMesh.material?.dispose();
    viewer.setCurrentMesh(null);
  }
  const oldTp = viewer.getToolpath();
  if (oldTp) {
    oldTp.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    viewer.scene.remove(oldTp);
    viewer.setToolpath(null);
  }

  // --- load all parts ---
  const rootGroup = new THREE.Group();
  rootGroup.name = "kinematic_root";
  const meshes = {};
  const origMaterials = {};
  const box = new THREE.Box3();

  for (let i = 0; i < partUrls.length; i++) {
    const { name, url } = partUrls[i];
    const geo = await loadStlAsync(url);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: PART_COLORS[i % PART_COLORS.length],
      metalness: 0.15,
      roughness: 0.55,
      transparent: name === "Block",
      opacity: name === "Block" ? 0.3 : 1.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    origMaterials[name] = mat;
    meshes[name] = mesh;
    rootGroup.add(mesh);
    box.expandByObject(mesh);
  }

  viewer.scene.add(rootGroup);
  viewer.setCurrentMesh(rootGroup);

  // camera
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const radius = size.length() / 2 || 50;
  viewer.camera.position.set(
    center.x + radius * 1.8,
    center.y + radius * 1.4,
    center.z + radius * 1.8,
  );
  viewer.camera.lookAt(center);
  viewer.controls.target.copy(center);
  viewer.controls.update();

  // --- build kinematic structures ---
  const joints = kinData.joints || [];
  const constraints = kinData.constraints || [];
  const collisionPairs = kinData.collision_pairs || [];

  // pivot groups for Revolute joints
  const pivots = {};
  for (const j of joints) {
    if (j.type === "Revolute" && meshes[j.child]) {
      const mesh = meshes[j.child];
      const origin = new THREE.Vector3(...j.origin);
      const pivot = new THREE.Group();
      pivot.name = `pivot_${j.name}`;
      rootGroup.remove(mesh);
      pivot.position.copy(origin);
      mesh.position.sub(origin);
      pivot.add(mesh);
      rootGroup.add(pivot);
      pivots[j.name] = { pivot, joint: j, mesh };
    }
  }

  // CrankSlider constraint setup: wrap rod in its own pivot group
  const crankSliders = [];
  for (const c of constraints) {
    if (c.type !== "CrankSlider") continue;
    const rodMesh = meshes[c.rod_part];
    const sliderMesh = meshes[c.slider_part];
    if (!rodMesh || !sliderMesh) continue;

    const rodOrigin = new THREE.Vector3(...c.rod_origin);
    const rodPivot = new THREE.Group();
    rodPivot.name = `pivot_rod_${c.rod_part}`;
    rootGroup.remove(rodMesh);
    rodPivot.position.copy(rodOrigin);
    rodMesh.position.sub(rodOrigin);
    rodPivot.add(rodMesh);
    rootGroup.add(rodPivot);

    const sliderOrigin = new THREE.Vector3(...c.slider_origin);
    const sliderAxis = new THREE.Vector3(...c.slider_axis).normalize();

    crankSliders.push({
      crankJoint: c.crank_joint,
      crankRadius: c.crank_radius,
      rodPivot,
      rodMesh,
      rodLength: c.rod_length,
      rodOrigin,
      sliderMesh,
      sliderAxis,
      sliderOrigin,
      sliderInitialPos: sliderMesh.position.clone(),
    });
  }

  // --- simulation state ---
  let angle = 0;
  let playing = false;
  let speed = 1;
  let collided = false;
  const collisionMat = new THREE.MeshStandardMaterial({
    color: 0xff0000, metalness: 0.15, roughness: 0.55,
  });

  function solve() {
    // driven revolute joints
    for (const j of joints) {
      if (j.type === "Revolute" && j.driven && pivots[j.name]) {
        const { pivot } = pivots[j.name];
        const ax = new THREE.Vector3(...j.axis).normalize();
        pivot.setRotationFromAxisAngle(ax, (angle * Math.PI) / 180);
      }
    }

    // CrankSlider constraints
    for (const cs of crankSliders) {
      const crankPivotData = pivots[cs.crankJoint];
      if (!crankPivotData) continue;
      const j = crankPivotData.joint;
      const crankOrigin = new THREE.Vector3(...j.origin);
      const r = cs.crankRadius;
      const L = cs.rodLength;
      const theta = (angle * Math.PI) / 180;

      // crank pin world position
      const pinX = crankOrigin.x + r * Math.cos(theta);
      const pinY = crankOrigin.y + r * Math.sin(theta);
      const pinZ = crankOrigin.z;

      // piston position along slider axis (assumes axis-aligned, typically X)
      const offAxis = r * Math.sin(theta); // perpendicular component
      const along = r * Math.cos(theta) + Math.sqrt(Math.max(0, L * L - offAxis * offAxis));
      const pistonDelta = crankOrigin.x + along - cs.sliderOrigin.x;

      cs.sliderMesh.position.copy(cs.sliderInitialPos);
      cs.sliderMesh.position.addScaledVector(cs.sliderAxis, pistonDelta);

      // connecting rod: position at crank pin, rotate to match
      cs.rodPivot.position.set(pinX, pinY, pinZ);
      const pistonWorldX = cs.sliderOrigin.x + pistonDelta;
      const rodAngle = Math.atan2(pinY - 0, pistonWorldX - pinX);
      // rod rotates in the same plane as the crank
      const ax = new THREE.Vector3(...(j.axis || [0, 0, 1])).normalize();
      cs.rodPivot.setRotationFromAxisAngle(ax, -rodAngle);
    }

    // collision detection (AABB)
    const collisions = [];
    const b1 = new THREE.Box3();
    const b2 = new THREE.Box3();
    for (const [nameA, nameB] of collisionPairs) {
      const mA = meshes[nameA];
      const mB = meshes[nameB];
      if (!mA || !mB) continue;
      b1.setFromObject(mA);
      b2.setFromObject(mB);
      if (b1.intersectsBox(b2)) {
        collisions.push([nameA, nameB]);
      }
    }

    if (collisions.length > 0 && !collided) {
      collided = true;
      for (const [a, b] of collisions) {
        if (meshes[a]) meshes[a].material = collisionMat;
        if (meshes[b]) meshes[b].material = collisionMat;
      }
      playing = false;
      if (onCollision) onCollision(collisions);
    }

    if (onUpdate) {
      onUpdate({ angle: angle % 360, playing, collided });
    }
  }

  solve();

  viewer.setFrameCb((dt) => {
    if (!playing) return;
    const driven = joints.find((j) => j.driven);
    const spd = (driven?.speed ?? 180) * speed;
    angle += spd * dt;
    solve();
  });

  return {
    play() {
      if (collided) return;
      playing = true;
    },
    pause() {
      playing = false;
    },
    isPlaying: () => playing,
    setSpeed(m) {
      speed = m;
    },
    seek(deg) {
      angle = deg;
      solve();
    },
    reset() {
      angle = 0;
      playing = false;
      collided = false;
      for (const [name, mat] of Object.entries(origMaterials)) {
        if (meshes[name]) meshes[name].material = mat;
      }
      solve();
    },
  };
}
