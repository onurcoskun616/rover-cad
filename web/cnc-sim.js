import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ─── G-CODE PARSER ENGINE ──────────────────────────────────────────────────────

function parseGCode(text) {
  const lines = text.split("\n").map((l) => l.replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim()).filter(Boolean);
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].toUpperCase();
    if (!raw || raw.startsWith("%") || raw.startsWith("O")) continue;
    const words = [];
    const re = /([A-Z])([+-]?\d*\.?\d+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) words.push({ letter: m[1], value: parseFloat(m[2]) });
    if (words.length) commands.push({ line: i, raw: lines[i], words });
  }
  return { lines, commands };
}

function buildMoves(commands) {
  let pos = { x: 0, y: 0, z: 0 };
  let mode = 0; // G0=0 G1=1 G2=2 G3=3
  let absolute = true;
  let feed = 100;
  let speed = 1000;
  let tool = 1;
  let metric = true;
  const moves = [];

  for (const cmd of commands) {
    const wm = {};
    const gCodes = [];
    for (const w of cmd.words) {
      if (w.letter === "G") gCodes.push(w.value);
      else wm[w.letter] = w.value;
    }

    let skipMove = false;
    for (const g of gCodes) {
      if (g === 0) mode = 0;
      else if (g === 1) mode = 1;
      else if (g === 2) mode = 2;
      else if (g === 3) mode = 3;
      else if (g === 90) { absolute = true; skipMove = true; }
      else if (g === 91) { absolute = false; skipMove = true; }
      else if (g === 20) { metric = false; skipMove = true; }
      else if (g === 21) { metric = true; skipMove = true; }
      else if (g === 28) {
        moves.push({ type: "rapid", from: { ...pos }, to: { x: 0, y: 0, z: 0 }, feed: 9999, speed, tool, line: cmd.line });
        pos = { x: 0, y: 0, z: 0 };
        skipMove = true;
      }
    }
    if ("F" in wm) feed = wm.F;
    if ("S" in wm) speed = wm.S;
    if ("T" in wm) tool = wm.T;

    if ("M" in wm) {
      const mc = wm.M;
      if (mc === 3 || mc === 4 || mc === 5) {
        moves.push({ type: "mcode", code: mc, speed, line: cmd.line });
      }
      if (mc === 30 || mc === 2) {
        moves.push({ type: "end", line: cmd.line });
      }
      if (!("X" in wm || "Y" in wm || "Z" in wm)) continue;
    }

    const hasXYZ = "X" in wm || "Y" in wm || "Z" in wm;
    if (!hasXYZ) continue;

    const from = { ...pos };
    const scale = metric ? 1 : 25.4;
    if (absolute) {
      if ("X" in wm) pos.x = wm.X * scale;
      if ("Y" in wm) pos.y = wm.Y * scale;
      if ("Z" in wm) pos.z = wm.Z * scale;
    } else {
      if ("X" in wm) pos.x += wm.X * scale;
      if ("Y" in wm) pos.y += wm.Y * scale;
      if ("Z" in wm) pos.z += wm.Z * scale;
    }
    const to = { ...pos };

    if (mode === 0) {
      moves.push({ type: "rapid", from, to, feed: 9999, speed, tool, line: cmd.line });
    } else if (mode === 1) {
      moves.push({ type: "linear", from, to, feed, speed, tool, line: cmd.line });
    } else if (mode === 2 || mode === 3) {
      const cx = "I" in wm ? from.x + wm.I * scale : ("R" in wm ? null : from.x);
      const cy = "J" in wm ? from.y + wm.J * scale : ("R" in wm ? null : from.y);
      let arcCenter = null;
      let radius = null;
      if (cx !== null && cy !== null) {
        arcCenter = { x: cx, y: cy };
        radius = Math.sqrt((from.x - cx) ** 2 + (from.y - cy) ** 2);
      } else if ("R" in wm) {
        radius = Math.abs(wm.R * scale);
        const dx = to.x - from.x, dy = to.y - from.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0 && radius >= d / 2) {
          const h = Math.sqrt(Math.max(0, radius * radius - (d / 2) ** 2));
          const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
          const sign = (mode === 2) !== (wm.R < 0) ? 1 : -1;
          arcCenter = { x: mx + sign * h * (-dy / d), y: my + sign * h * (dx / d) };
        }
      }
      if (arcCenter && radius) {
        const arcPts = interpolateArc(from, to, arcCenter, radius, mode === 2, "Z" in wm ? to.z - from.z : 0);
        for (let i = 1; i < arcPts.length; i++) {
          moves.push({ type: "linear", from: arcPts[i - 1], to: arcPts[i], feed, speed, tool, line: cmd.line });
        }
      } else {
        moves.push({ type: "linear", from, to, feed, speed, tool, line: cmd.line });
      }
    }
  }
  return moves;
}

function interpolateArc(from, to, center, radius, cw, dz) {
  let startAngle = Math.atan2(from.y - center.y, from.x - center.x);
  let endAngle = Math.atan2(to.y - center.y, to.x - center.x);
  if (cw) {
    if (endAngle >= startAngle) endAngle -= 2 * Math.PI;
  } else {
    if (endAngle <= startAngle) endAngle += 2 * Math.PI;
  }
  const sweep = Math.abs(endAngle - startAngle);
  const steps = Math.max(8, Math.ceil(sweep / (Math.PI / 36)));
  const pts = [{ ...from }];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const a = startAngle + (endAngle - startAngle) * t;
    pts.push({
      x: center.x + radius * Math.cos(a),
      y: center.y + radius * Math.sin(a),
      z: from.z + dz * t,
    });
  }
  return pts;
}


// ─── DOM REFERENCES ────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const tabFreze = $("tab-freze");
const tabTorna = $("tab-torna");
const viewFreze = $("viewport-freze");
const viewTorna = $("viewport-torna");
const machineLabel = $("cnc-machine-label");
const droX = $("dro-x"), droY = $("dro-y"), droZ = $("dro-z");
const droF = $("dro-f"), droS = $("dro-s"), droT = $("dro-t");
const lcdLines = $("cnc-lcd-lines");
const lcdStatus = $("cnc-lcd-status");
const lcdLineNo = $("cnc-lcd-line");
const modeLabel = $("cnc-mode-label");
const progName = $("cnc-program-name");
const gcodeInput = $("gcode-input");
const gcodeListing = $("gcode-listing");
const gcodeListingLines = $("gcode-listing-lines");
const speedSlider = $("speed-slider"), speedPct = $("speed-pct");
const feedSlider = $("feed-override"), feedPct = $("feed-pct");
const camBtns = { iso: $("cam-iso"), top: $("cam-top"), front: $("cam-front"), right: $("cam-right") };

let machineType = "freze";
let currentMode = "auto";
let simState = "idle"; // idle, running, paused, estop, done
let moves = [];
let moveIndex = 0;
let moveT = 0;
let parsedLines = [];
let lcdElements = [];
let listingElements = [];
let speedMult = 1;
let feedMult = 1;

// ─── THREE.JS SCENE (Milling) ─────────────────────────────────────────────────

let scene, camera, renderer, controls;
let toolGroup, spindleGroup;
let stockMesh, stockHeights;
let stockGX = 0, stockGY = 0;
let stkMinX = 0, stkMinY = 0, stkColW = 1, stkColD = 1;
let stkBaseZ = 0, stkTopZ = 0;
const stkTmp = new THREE.Object3D();
let toolpathGroup = null;
let chipParticles = [];
let cutterRadius = 3;

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1018);

  camera = new THREE.PerspectiveCamera(45, viewFreze.clientWidth / (viewFreze.clientHeight || 450), 1, 5000);
  camera.position.set(200, 150, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(viewFreze.clientWidth, viewFreze.clientHeight || 450);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  viewFreze.replaceChildren(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(100, 200, 150);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
  dir2.position.set(-100, -50, -100);
  scene.add(dir2);

  const grid = new THREE.GridHelper(400, 40, 0x1a2a44, 0x0f1a2a);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);

  buildTool();

  window.addEventListener("resize", onResize);
}

function onResize() {
  if (!renderer) return;
  const w = viewFreze.clientWidth;
  const h = viewFreze.clientHeight || 450;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function buildTool() {
  toolGroup = new THREE.Group();
  spindleGroup = new THREE.Group();
  toolGroup.add(spindleGroup);

  const holderMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.85, roughness: 0.25 });
  const shankMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7, roughness: 0.3 });
  const cutterMat = new THREE.MeshStandardMaterial({ color: 0xaabbcc, metalness: 0.9, roughness: 0.12 });
  const fluteMat = new THREE.MeshStandardMaterial({ color: 0xddeeff, metalness: 0.95, roughness: 0.08, side: THREE.DoubleSide });

  const holder = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 8, 20), holderMat);
  holder.position.y = 30;
  spindleGroup.add(holder);

  const taper = new THREE.Mesh(new THREE.CylinderGeometry(4, 2, 4, 20), shankMat);
  taper.position.y = 24;
  spindleGroup.add(taper);

  const shank = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 10, 16), shankMat);
  shank.position.y = 17;
  spindleGroup.add(shank);

  const cutter = new THREE.Mesh(new THREE.CylinderGeometry(cutterRadius, cutterRadius * 0.9, 12, 16), cutterMat);
  cutter.position.y = 6;
  spindleGroup.add(cutter);

  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(cutterRadius * 2.2, 11, 0.3), fluteMat);
    fin.position.y = 6;
    fin.rotation.y = (i / 4) * Math.PI * 2;
    spindleGroup.add(fin);
  }

  const tip = new THREE.Mesh(new THREE.CylinderGeometry(cutterRadius * 0.9, 0.5, 3, 16), cutterMat);
  tip.position.y = -1;
  spindleGroup.add(tip);

  toolGroup.rotation.x = Math.PI;
  scene.add(toolGroup);
}

function setupFrezeStock(mvs) {
  if (stockMesh) { scene.remove(stockMesh); stockMesh.geometry.dispose(); stockMesh.material.dispose(); stockMesh = null; }
  if (toolpathGroup) { scene.remove(toolpathGroup); toolpathGroup = null; }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const mv of mvs) {
    if (mv.type !== "linear" && mv.type !== "rapid") continue;
    for (const p of [mv.from, mv.to]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  }
  if (!isFinite(minX)) return;

  const pad = Math.max(5, (maxX - minX) * 0.1);
  stkMinX = minX - pad; stkMinY = minY - pad;
  const stkMaxX = maxX + pad, stkMaxY = maxY + pad;

  let feedMinZ = Infinity, feedMaxZ = -Infinity;
  for (const mv of mvs) {
    if (mv.type !== "linear") continue;
    feedMinZ = Math.min(feedMinZ, mv.from.z, mv.to.z);
    feedMaxZ = Math.max(feedMaxZ, mv.from.z, mv.to.z);
  }
  if (!isFinite(feedMinZ)) { feedMinZ = minZ; feedMaxZ = maxZ; }
  stkTopZ = feedMaxZ + 2;
  stkBaseZ = feedMinZ - 3;
  if (stkBaseZ >= stkTopZ) stkBaseZ = stkTopZ - 1;

  const stkW = stkMaxX - stkMinX, stkD = stkMaxY - stkMinY;
  const cellSz = Math.max(cutterRadius * 0.5, 0.8);
  stockGX = Math.min(120, Math.max(10, Math.round(stkW / cellSz)));
  stockGY = Math.min(120, Math.max(10, Math.round(stkD / cellSz)));
  stkColW = stkW / stockGX;
  stkColD = stkD / stockGY;

  stockHeights = new Float32Array(stockGX * stockGY);
  const initH = stkTopZ - stkBaseZ;
  stockHeights.fill(initH);

  const geo = new THREE.BoxGeometry(stkColW * 0.96, stkColD * 0.96, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a8a9a, metalness: 0.4, roughness: 0.5 });
  stockMesh = new THREE.InstancedMesh(geo, mat, stockGX * stockGY);

  for (let gy = 0; gy < stockGY; gy++)
    for (let gx = 0; gx < stockGX; gx++) setCol(gx, gy, initH);
  stockMesh.instanceMatrix.needsUpdate = true;
  scene.add(stockMesh);

  // Draw toolpath lines
  toolpathGroup = new THREE.Group();
  const feedPts = [], rapidPts = [];
  for (const mv of mvs) {
    if (mv.type !== "linear" && mv.type !== "rapid") continue;
    const a = new THREE.Vector3(mv.from.x, mv.from.y, mv.from.z);
    const b = new THREE.Vector3(mv.to.x, mv.to.y, mv.to.z);
    if (mv.type === "rapid") rapidPts.push(a, b);
    else feedPts.push(a, b);
  }
  if (feedPts.length) {
    const g = new THREE.BufferGeometry().setFromPoints(feedPts);
    toolpathGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x22d3ee, opacity: 0.6, transparent: true })));
  }
  if (rapidPts.length) {
    const g = new THREE.BufferGeometry().setFromPoints(rapidPts);
    toolpathGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xf59e0b, opacity: 0.25, transparent: true })));
  }
  scene.add(toolpathGroup);

  // Center camera
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (feedMinZ + feedMaxZ) / 2;
  const radius = Math.max(stkW, stkD, feedMaxZ - feedMinZ) * 1.5;
  camera.position.set(cx + radius, cy + radius * 0.7, cz + radius);
  controls.target.set(cx, cy, cz);
  controls.update();
}

function setCol(ix, iy, h) {
  if (h < 0.01) h = 0.01;
  stkTmp.position.set(stkMinX + (ix + 0.5) * stkColW, stkMinY + (iy + 0.5) * stkColD, stkBaseZ + h / 2);
  stkTmp.scale.set(1, 1, h);
  stkTmp.updateMatrix();
  stockMesh.setMatrixAt(iy * stockGX + ix, stkTmp.matrix);
}

function cutFreze(tx, ty, tz) {
  if (!stockMesh || tz >= stkTopZ) return;
  const ch = Math.max(0.01, tz - stkBaseZ);
  const r = cutterRadius;
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
          setCol(ix, iy, ch);
          dirty = true;
        }
      }
    }
  }
  if (dirty) {
    stockMesh.instanceMatrix.needsUpdate = true;
    spawnChip3D(tx, ty, tz);
  }
}

function resetFrezeStock() {
  if (!stockMesh) return;
  const initH = stkTopZ - stkBaseZ;
  stockHeights.fill(initH);
  for (let gy = 0; gy < stockGY; gy++)
    for (let gx = 0; gx < stockGX; gx++) setCol(gx, gy, initH);
  stockMesh.instanceMatrix.needsUpdate = true;
}

// Chip particles (3D) — shared geometry/material to avoid GC pressure
const chipGeo = new THREE.BoxGeometry(1, 0.3, 1);
const chipMat = new THREE.MeshStandardMaterial({ color: 0xbbaa77, metalness: 0.6, roughness: 0.4 });
function spawnChip3D(x, y, z) {
  if (chipParticles.length > 40) return;
  if (Math.random() > 0.1) return;
  const m = new THREE.Mesh(chipGeo, chipMat);
  const s = 0.5 + Math.random();
  m.scale.set(s, 1, 0.5 + Math.random());
  m.position.set(x + (Math.random() - 0.5) * 3, y + (Math.random() - 0.5) * 3, z);
  m.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 5 + Math.random() * 15);
  m.userData.life = 1.5 + Math.random();
  scene.add(m);
  chipParticles.push(m);
}

function updateChips(dt) {
  for (let i = chipParticles.length - 1; i >= 0; i--) {
    const c = chipParticles[i];
    c.userData.vel.z -= 60 * dt;
    c.position.addScaledVector(c.userData.vel, dt);
    c.rotation.x += dt * 5;
    c.rotation.z += dt * 3;
    c.userData.life -= dt;
    if (c.userData.life <= 0 || c.position.z < stkBaseZ - 20) {
      scene.remove(c);
      chipParticles.splice(i, 1);
    }
  }
}


// ─── CANVAS 2D (Lathe) ────────────────────────────────────────────────────────

const LATHE_N = 300;
const LATHE_LEN = 200;
const LATHE_MAX_R = 60;
let latheRadii = new Float32Array(LATHE_N);
let latheChuckAngle = 0;
let latheToolX = 0, latheToolZ = LATHE_MAX_R + 10;
let latheChips = [];

function resetLathe() {
  latheRadii.fill(LATHE_MAX_R);
  latheToolX = 0;
  latheToolZ = LATHE_MAX_R + 10;
  latheChips = [];
}

function cutLathe(x, z) {
  const r = Math.abs(z);
  const segLen = LATHE_LEN / LATHE_N;
  const toolW = 3;
  const i0 = Math.max(0, Math.floor((x - toolW / 2) / segLen));
  const i1 = Math.min(LATHE_N - 1, Math.floor((x + toolW / 2) / segLen));
  let cut = false;
  for (let i = i0; i <= i1; i++) {
    if (r < latheRadii[i]) {
      latheRadii[i] = Math.max(0.5, r);
      cut = true;
    }
  }
  if (cut && Math.random() < 0.3) {
    latheChips.push({
      x: x + (Math.random() - 0.5) * 5,
      y: z + (Math.random() > 0.5 ? 1 : -1) * (r + 2),
      vx: (Math.random() - 0.5) * 40,
      vy: (Math.random() > 0.5 ? 1 : -1) * (10 + Math.random() * 20),
      life: 1 + Math.random(),
    });
  }
}

function drawLathe(ctx, w, h, dt) {
  ctx.fillStyle = "#0a1018";
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.42, cy = h / 2;
  const scaleX = (w * 0.55) / LATHE_LEN;
  const scaleY = (h * 0.35) / LATHE_MAX_R;
  const scale = Math.min(scaleX, scaleY);

  // Grid
  ctx.strokeStyle = "#0f1a2a";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= LATHE_LEN; i += 20) {
    const sx = cx + i * scale;
    ctx.beginPath(); ctx.moveTo(sx, cy - LATHE_MAX_R * scale * 1.3); ctx.lineTo(sx, cy + LATHE_MAX_R * scale * 1.3); ctx.stroke();
  }
  for (let r = 0; r <= LATHE_MAX_R; r += 10) {
    ctx.beginPath(); ctx.moveTo(cx, cy - r * scale); ctx.lineTo(cx + LATHE_LEN * scale, cy - r * scale); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + r * scale); ctx.lineTo(cx + LATHE_LEN * scale, cy + r * scale); ctx.stroke();
  }

  // Chuck
  latheChuckAngle += dt * 8;
  const chuckX = cx - 10;
  const chuckR = LATHE_MAX_R * scale * 1.1;
  ctx.save();
  ctx.translate(chuckX, cy);
  ctx.rotate(latheChuckAngle);
  const chuckGrad = ctx.createRadialGradient(0, 0, chuckR * 0.3, 0, 0, chuckR);
  chuckGrad.addColorStop(0, "#3a3a3a");
  chuckGrad.addColorStop(0.7, "#2a2a2a");
  chuckGrad.addColorStop(1, "#1a1a1a");
  ctx.fillStyle = chuckGrad;
  ctx.beginPath(); ctx.arc(0, 0, chuckR, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#555";
  ctx.lineWidth = 1;
  for (let j = 0; j < 3; j++) {
    const a = (j / 3) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * chuckR * 0.5, Math.sin(a) * chuckR * 0.5);
    ctx.lineTo(Math.cos(a) * chuckR * 0.95, Math.sin(a) * chuckR * 0.95);
    ctx.stroke();
  }
  ctx.restore();

  // Workpiece profile (upper + lower)
  const segLen = LATHE_LEN / LATHE_N;
  const grad = ctx.createLinearGradient(cx, cy - LATHE_MAX_R * scale, cx, cy + LATHE_MAX_R * scale);
  grad.addColorStop(0, "#8899aa");
  grad.addColorStop(0.3, "#aabbcc");
  grad.addColorStop(0.5, "#ccd8e8");
  grad.addColorStop(0.7, "#aabbcc");
  grad.addColorStop(1, "#667788");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx, cy - latheRadii[0] * scale);
  for (let i = 0; i < LATHE_N; i++) {
    ctx.lineTo(cx + (i + 0.5) * segLen * scale, cy - latheRadii[i] * scale);
  }
  ctx.lineTo(cx + LATHE_LEN * scale, cy);
  for (let i = LATHE_N - 1; i >= 0; i--) {
    ctx.lineTo(cx + (i + 0.5) * segLen * scale, cy + latheRadii[i] * scale);
  }
  ctx.closePath();
  ctx.fill();

  // Profile outline
  ctx.strokeStyle = "#4a6a8a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy - latheRadii[0] * scale);
  for (let i = 0; i < LATHE_N; i++) ctx.lineTo(cx + (i + 0.5) * segLen * scale, cy - latheRadii[i] * scale);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy + latheRadii[0] * scale);
  for (let i = 0; i < LATHE_N; i++) ctx.lineTo(cx + (i + 0.5) * segLen * scale, cy + latheRadii[i] * scale);
  ctx.stroke();

  // Center line
  ctx.strokeStyle = "#1a3058";
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + LATHE_LEN * scale, cy); ctx.stroke();
  ctx.setLineDash([]);

  // Tool
  const tx = cx + latheToolX * scale;
  const tz = cy - latheToolZ * scale;
  ctx.fillStyle = "#dd4444";
  ctx.beginPath();
  ctx.moveTo(tx, tz);
  ctx.lineTo(tx + 4 * scale, tz - 3 * scale);
  ctx.lineTo(tx + 4 * scale, tz + 3 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#aa3333";
  ctx.fillRect(tx + 4 * scale, tz - 5 * scale, 12 * scale, 10 * scale);

  // Chips
  ctx.fillStyle = "#bbaa66";
  for (let i = latheChips.length - 1; i >= 0; i--) {
    const c = latheChips[i];
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.vy += 40 * dt;
    c.life -= dt;
    const sx = cx + c.x * scale, sy = cy - c.y * scale;
    ctx.fillRect(sx - 1, sy - 1, 2, 2);
    if (c.life <= 0) latheChips.splice(i, 1);
  }

  // Axis labels
  ctx.fillStyle = "#5a8ab5";
  ctx.font = "10px monospace";
  ctx.fillText("X →", cx + LATHE_LEN * scale + 8, cy + 3);
  ctx.fillText("Z ↑", cx - 18, cy - LATHE_MAX_R * scale * 1.1);
}


// ─── LCD & LISTING ─────────────────────────────────────────────────────────────

function populateLCD(lines) {
  lcdLines.innerHTML = "";
  lcdElements = [];
  const show = lines.slice(0, 200);
  for (let i = 0; i < show.length; i++) {
    const div = document.createElement("div");
    div.className = "cnc-lcd-line";
    div.textContent = show[i];
    lcdLines.appendChild(div);
    lcdElements.push(div);
  }
}

function populateListing(lines) {
  gcodeListingLines.innerHTML = "";
  listingElements = [];
  for (let i = 0; i < lines.length; i++) {
    const div = document.createElement("div");
    div.className = "cnc-listing-line";
    div.innerHTML = `<span class="ln">${i + 1}</span>${escapeHtml(lines[i])}`;
    gcodeListingLines.appendChild(div);
    listingElements.push(div);
  }
  gcodeListing.hidden = false;
}

let lastHighlightedLine = -1;
function highlightLine(lineIdx) {
  if (lineIdx === lastHighlightedLine) return;
  lastHighlightedLine = lineIdx;
  for (const el of lcdElements) el.classList.remove("active");
  for (const el of listingElements) el.classList.remove("active");
  if (lineIdx >= 0 && lineIdx < lcdElements.length) {
    lcdElements[lineIdx].classList.add("active");
    lcdElements[lineIdx].scrollIntoView({ block: "nearest" });
  }
  if (lineIdx >= 0 && lineIdx < listingElements.length) {
    listingElements[lineIdx].classList.add("active");
    listingElements[lineIdx].scrollIntoView({ block: "nearest" });
  }
  lcdLineNo.textContent = `N${lineIdx}`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


// ─── SIMULATION LOOP ──────────────────────────────────────────────────────────

let lastTime = 0;
function animationLoop(time) {
  requestAnimationFrame(animationLoop);
  const dt = Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;

  if (machineType === "freze") {
    if (spindleGroup && simState === "running") spindleGroup.rotation.y += dt * 15;
    updateChips(dt);
    controls.update();
    renderer.render(scene, camera);
  } else {
    const canvas = viewTorna;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== canvas.clientWidth * dpr || canvas.height !== canvas.clientHeight * dpr) {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.scale(dpr, dpr);
    }
    drawLathe(ctx, canvas.clientWidth, canvas.clientHeight, simState === "running" ? dt : 0);
  }

  if (simState === "running") stepSim(dt);
}

function stepSim(dt) {
  if (moveIndex >= moves.length) {
    simState = "done";
    lcdStatus.textContent = "BİTTİ";
    return;
  }
  const mv = moves[moveIndex];
  if (mv.type === "mcode" || mv.type === "end") {
    highlightLine(mv.line);
    if (mv.type === "end") { simState = "done"; lcdStatus.textContent = "BİTTİ"; return; }
    moveIndex++;
    return;
  }
  if (mv.type !== "linear" && mv.type !== "rapid") { moveIndex++; return; }

  const f = mv.type === "rapid" ? 5000 : (mv.feed * feedMult);
  const mmPerSec = (f / 60) * speedMult;
  const dx = mv.to.x - mv.from.x, dy = mv.to.y - mv.from.y, dz = mv.to.z - mv.from.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.001) { moveIndex++; return; }

  const totalTime = dist / mmPerSec;
  moveT += dt;
  const t = Math.min(1, moveT / totalTime);

  const px = mv.from.x + dx * t;
  const py = mv.from.y + dy * t;
  const pz = mv.from.z + dz * t;

  if (machineType === "freze") {
    toolGroup.position.set(px, py, pz);
    if (mv.type === "linear") cutFreze(px, py, pz);
  } else {
    latheToolX = px;
    latheToolZ = pz;
    if (mv.type === "linear") cutLathe(px, pz);
  }

  droX.textContent = px.toFixed(3);
  droY.textContent = py.toFixed(3);
  droZ.textContent = pz.toFixed(3);
  droF.textContent = String(Math.round(mv.type === "rapid" ? 9999 : mv.feed));
  droS.textContent = String(Math.round(mv.speed));
  droT.textContent = String(mv.tool).padStart(2, "0");
  highlightLine(mv.line);

  if (t >= 1) { moveIndex++; moveT = 0; }
}


// ─── CONTROLS ──────────────────────────────────────────────────────────────────

function loadGCode(text) {
  const parsed = parseGCode(text);
  parsedLines = parsed.lines;
  const built = buildMoves(parsed.commands);
  moves = built;
  moveIndex = 0;
  moveT = 0;
  simState = "idle";
  lcdStatus.textContent = "HAZIR";

  populateLCD(parsedLines);
  populateListing(parsedLines);

  if (machineType === "freze") {
    setupFrezeStock(built);
    if (built.length) toolGroup.position.set(built[0].from.x, built[0].from.y, built[0].from.z);
  } else {
    resetLathe();
  }

  droX.textContent = "0.000"; droY.textContent = "0.000"; droZ.textContent = "0.000";
  droF.textContent = "0"; droS.textContent = "0"; droT.textContent = "01";

  $("btn-estop").classList.remove("engaged");
}

function cycleStart() {
  if (simState === "estop") return;
  if (simState === "done") {
    moveIndex = 0; moveT = 0;
    if (machineType === "freze") resetFrezeStock();
    else resetLathe();
  }
  simState = "running";
  lcdStatus.textContent = "ÇALIŞIYOR";
}

function feedHold() {
  if (simState === "running") {
    simState = "paused";
    lcdStatus.textContent = "DURAKLATILDI";
  }
}

function resetSim() {
  simState = "idle";
  moveIndex = 0;
  moveT = 0;
  lcdStatus.textContent = "HAZIR";
  if (machineType === "freze") resetFrezeStock();
  else resetLathe();
  droX.textContent = "0.000"; droY.textContent = "0.000"; droZ.textContent = "0.000";
}

function estop() {
  const btn = $("btn-estop");
  if (simState === "estop") {
    simState = "idle";
    btn.classList.remove("engaged");
    lcdStatus.textContent = "HAZIR";
  } else {
    simState = "estop";
    btn.classList.add("engaged");
    lcdStatus.textContent = "ACİL DURDURMA";
  }
}

function switchMachine(type) {
  machineType = type;
  tabFreze.classList.toggle("active", type === "freze");
  tabTorna.classList.toggle("active", type === "torna");
  viewFreze.hidden = type !== "freze";
  viewTorna.hidden = type !== "torna";
  machineLabel.textContent = type === "freze" ? "FANUC 0i-MF — Freze" : "FANUC 0i-TF — Torna";

  const camRow = document.querySelector(".cnc-camera-btns");
  if (camRow) camRow.style.display = type === "freze" ? "flex" : "none";

  simState = "idle";
  moves = [];
  moveIndex = 0;
  moveT = 0;
  lcdStatus.textContent = "HAZIR";
  populateLCD([]);
  gcodeListingLines.innerHTML = "";
  gcodeListing.hidden = true;
  droX.textContent = "0.000"; droY.textContent = "0.000"; droZ.textContent = "0.000";
}

function setMode(mode) {
  currentMode = mode;
  $("mode-auto").classList.toggle("active", mode === "auto");
  $("mode-mdi").classList.toggle("active", mode === "mdi");
  $("mode-manual").classList.toggle("active", mode === "manual");
  modeLabel.textContent = mode.toUpperCase();
}

function setCamera(view) {
  if (!camera || !controls) return;
  Object.values(camBtns).forEach((b) => b.classList.remove("active"));
  camBtns[view]?.classList.add("active");
  const t = controls.target;
  const d = 250;
  switch (view) {
    case "iso": camera.position.set(t.x + d, t.y + d * 0.7, t.z + d); break;
    case "top": camera.position.set(t.x, t.y, t.z + d); break;
    case "front": camera.position.set(t.x, t.y - d, t.z + d * 0.3); break;
    case "right": camera.position.set(t.x + d, t.y, t.z + d * 0.3); break;
  }
  camera.lookAt(t);
  controls.update();
}


// ─── DEMO PROGRAMS ─────────────────────────────────────────────────────────────

const DEMO_FREZE = `( Demo: Freze - Kare Cep + Kontur )
G90 G21
G28

( Kare cep - kaba )
G00 X10 Y10 Z5
G01 Z-2 F200
G01 X60 F350
G01 Y50
G01 X10
G01 Y10
G01 X15 Y15
G01 X55
G01 Y45
G01 X15
G01 Y15
G01 Z-4 F200
G01 X55 F350
G01 Y45
G01 X15
G01 Y15
G01 X20 Y20
G01 X50
G01 Y40
G01 X20
G01 Y20

( Daire kontur )
G00 Z5
G00 X35 Y60
G01 Z-3 F200
G02 X35 Y60 I0 J-15 F300

( Çapraz oluk )
G00 Z5
G00 X5 Y5
G01 Z-1.5 F200
G01 X65 Y55 F400

G00 Z20
G28
M30`;

const DEMO_TORNA = `( Demo: Torna - Kademeli Mil )
G90 G21
G28

( Dis torna - 1. kademe )
G00 X200 Z65
G01 Z55 F150
G00 Z65
G00 X200 Z55
G01 X0 Z55 F100

G00 X200 Z65
G01 Z50 F150
G00 Z65
G00 X200 Z50
G01 X0 Z50 F100

G00 X200 Z65
G01 Z45 F150
G00 Z65
G00 X200 Z45
G01 X0 Z45 F100

( 2. kademe )
G00 X100 Z40
G01 X0 Z40 F100

G00 X100 Z40
G01 Z35 F150
G00 Z40
G00 X100 Z35
G01 X0 Z35 F100

G00 X100 Z40
G01 Z30 F150
G00 Z40
G00 X100 Z30
G01 X0 Z30 F100

( 3. kademe - ince )
G00 X60 Z25
G01 X0 Z25 F80

G00 X60 Z25
G01 Z20 F120
G00 Z25
G00 X60 Z20
G01 X0 Z20 F80

( Konik geçiş )
G00 X200 Z70
G01 X100 Z120 F150
G01 X60 Z150 F120

G00 Z200
G28
M30`;


// ─── EVENT WIRING ──────────────────────────────────────────────────────────────

tabFreze.addEventListener("click", () => switchMachine("freze"));
tabTorna.addEventListener("click", () => switchMachine("torna"));

$("btn-load-gcode").addEventListener("click", () => { loadGCode(gcodeInput.value); });
$("btn-demo-freze").addEventListener("click", () => { switchMachine("freze"); gcodeInput.value = DEMO_FREZE; loadGCode(DEMO_FREZE); });
$("btn-demo-torna").addEventListener("click", () => { switchMachine("torna"); gcodeInput.value = DEMO_TORNA; loadGCode(DEMO_TORNA); });

$("btn-cycle-start").addEventListener("click", cycleStart);
$("btn-feed-hold").addEventListener("click", feedHold);
$("btn-reset").addEventListener("click", resetSim);
$("btn-estop").addEventListener("click", estop);

$("mode-auto").addEventListener("click", () => setMode("auto"));
$("mode-mdi").addEventListener("click", () => setMode("mdi"));
$("mode-manual").addEventListener("click", () => setMode("manual"));

speedSlider.addEventListener("input", () => { speedMult = speedSlider.value / 100; speedPct.textContent = `${speedSlider.value}%`; });
feedSlider.addEventListener("input", () => { feedMult = feedSlider.value / 100; feedPct.textContent = `${feedSlider.value}%`; });

Object.entries(camBtns).forEach(([view, btn]) => btn.addEventListener("click", () => setCamera(view)));

// Check for G-code from CAM workflow via sessionStorage
const camData = sessionStorage.getItem("rover_cnc_gcode");
if (camData) {
  try {
    const data = JSON.parse(camData);
    if (data.gcode) {
      gcodeInput.value = data.gcode;
      if (data.machineType === "torna") switchMachine("torna");
      else switchMachine("freze");
      loadGCode(data.gcode);
    }
  } catch {}
}


// ─── INIT ──────────────────────────────────────────────────────────────────────

initThree();
requestAnimationFrame(animationLoop);
