import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = id => document.getElementById(id);

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// Mill workpiece
const MW = 200, MD = 140, MTOP = 60;
const COLS = 150, ROWS = 105;
const CUTTER_R = 13, MARGIN = 6;

// Lathe workpiece
const LN = 260, STOCK_LEN = 200, STOCK_R = 60, TOOL_HALF_W = 3.2;

// Chip pool
const CHIP_POOL = 160;

// ─── LATHE ENGINE ─────────────────────────────────────────────────────────────

class LatheEngine {
  constructor() {
    this.radii = new Float32Array(LN).fill(STOCK_R);
    this.toolX = 0; this.toolZ = STOCK_R + 15;
    this.spindleOn = false; this.spindleRpm = 1200;
    this.feed = 200; this.override = 1;
    this.mode = "MANUAL"; this.alarm = ""; this.emergency = false;
    this.running = false; this.holding = false;
    this.chuckAngle = 0; this.removedPct = 0;
    this.chips = []; this.toolNo = 1;
    this.autoCycle = null; this.autoStep = 0;
    this.jogTarget = null;
  }

  reset() {
    this.radii.fill(STOCK_R);
    this.toolX = 0; this.toolZ = STOCK_R + 15;
    this.removedPct = 0; this.chips = [];
    this.autoCycle = null; this.autoStep = 0;
    this.running = false; this.holding = false;
    this.alarm = "";
  }

  cutAt(x, z) {
    const r = Math.abs(z);
    const seg = STOCK_LEN / LN;
    const i0 = Math.max(0, Math.floor((x - TOOL_HALF_W) / seg));
    const i1 = Math.min(LN - 1, Math.floor((x + TOOL_HALF_W) / seg));
    let cut = false;
    for (let i = i0; i <= i1; i++) {
      if (r < this.radii[i]) { this.radii[i] = Math.max(1, r); cut = true; }
    }
    if (cut) {
      let total = 0;
      for (let i = 0; i < LN; i++) total += (STOCK_R - this.radii[i]);
      this.removedPct = (total / (LN * STOCK_R)) * 100;
      if (Math.random() < 0.35) {
        this.chips.push({
          x: x + (Math.random() - 0.5) * 6,
          y: z + (Math.random() > 0.5 ? 1 : -1) * (r + 3),
          vx: (Math.random() - 0.5) * 50,
          vy: (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 25),
          life: 1.2 + Math.random()
        });
      }
    }
  }

  startCycle() {
    if (this.emergency || this.mode !== "AUTO") return;
    this.spindleOn = true;
    this.running = true; this.holding = false;
    const passes = [];
    for (let r = STOCK_R - 6; r >= 30; r -= 6) {
      passes.push({ type: "rapid", x: 0, z: r + 2 });
      passes.push({ type: "feed", x: STOCK_LEN, z: r });
      passes.push({ type: "rapid", x: STOCK_LEN, z: STOCK_R + 10 });
      passes.push({ type: "rapid", x: 0, z: STOCK_R + 10 });
    }
    passes.push({ type: "rapid", x: 0, z: STOCK_R + 15 });
    this.autoCycle = passes;
    this.autoStep = 0;
  }

  update(dt) {
    if (this.emergency) return;
    if (this.spindleOn) this.chuckAngle += dt * (this.spindleRpm / 60) * Math.PI * 2;

    // Jog interpolation
    if (this.jogTarget) {
      const dx = this.jogTarget.x - this.toolX;
      const dz = this.jogTarget.z - this.toolZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      const spd = 300 * dt;
      if (d < spd) {
        this.toolX = this.jogTarget.x;
        this.toolZ = this.jogTarget.z;
        this.jogTarget = null;
      } else {
        this.toolX += (dx / d) * spd;
        this.toolZ += (dz / d) * spd;
      }
      if (this.spindleOn) this.cutAt(this.toolX, this.toolZ);
    }

    if (!this.running || this.holding || !this.autoCycle) return;
    const step = this.autoCycle[this.autoStep];
    if (!step) { this.running = false; return; }

    const speed = step.type === "rapid" ? 600 : this.feed * this.override;
    const dx = step.x - this.toolX, dz = step.z - this.toolZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const move = (speed / 60) * dt;

    if (dist < move) {
      this.toolX = step.x; this.toolZ = step.z;
      if (step.type === "feed" && this.spindleOn) this.cutAt(this.toolX, this.toolZ);
      this.autoStep++;
      if (this.autoStep >= this.autoCycle.length) { this.running = false; }
    } else {
      this.toolX += (dx / dist) * move;
      this.toolZ += (dz / dist) * move;
      if (step.type === "feed" && this.spindleOn) this.cutAt(this.toolX, this.toolZ);
    }
  }

  draw(ctx, w, h, dt) {
    ctx.fillStyle = "#0a1018";
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.38, cy = h / 2;
    const sx = (w * 0.5) / STOCK_LEN;
    const sy = (h * 0.35) / STOCK_R;
    const s = Math.min(sx, sy);

    // Grid
    ctx.strokeStyle = "#0f1a2a"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= STOCK_LEN; i += 20) {
      const px = cx + i * s;
      ctx.beginPath(); ctx.moveTo(px, cy - STOCK_R * s * 1.4);
      ctx.lineTo(px, cy + STOCK_R * s * 1.4); ctx.stroke();
    }
    for (let r = 0; r <= STOCK_R; r += 10) {
      ctx.beginPath(); ctx.moveTo(cx, cy - r * s); ctx.lineTo(cx + STOCK_LEN * s, cy - r * s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy + r * s); ctx.lineTo(cx + STOCK_LEN * s, cy + r * s); ctx.stroke();
    }

    // Chuck
    const chR = STOCK_R * s * 1.15;
    const chX = cx - 12;
    ctx.save(); ctx.translate(chX, cy);
    ctx.rotate(this.chuckAngle);
    const cg = ctx.createRadialGradient(0, 0, chR * 0.3, 0, 0, chR);
    cg.addColorStop(0, "#3e3e3e"); cg.addColorStop(0.7, "#2a2a2a"); cg.addColorStop(1, "#1a1a1a");
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(0, 0, chR, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#555"; ctx.lineWidth = 1.5;
    for (let j = 0; j < 3; j++) {
      const a = (j / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * chR * 0.4, Math.sin(a) * chR * 0.4);
      ctx.lineTo(Math.cos(a) * chR * 0.92, Math.sin(a) * chR * 0.92);
      ctx.stroke();
    }
    ctx.restore();

    // Workpiece
    const seg = STOCK_LEN / LN;
    const grad = ctx.createLinearGradient(cx, cy - STOCK_R * s, cx, cy + STOCK_R * s);
    grad.addColorStop(0, "#8899aa"); grad.addColorStop(0.3, "#aabbcc");
    grad.addColorStop(0.5, "#ccd8e8"); grad.addColorStop(0.7, "#aabbcc");
    grad.addColorStop(1, "#667788");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy - this.radii[0] * s);
    for (let i = 0; i < LN; i++) ctx.lineTo(cx + (i + 0.5) * seg * s, cy - this.radii[i] * s);
    ctx.lineTo(cx + STOCK_LEN * s, cy);
    for (let i = LN - 1; i >= 0; i--) ctx.lineTo(cx + (i + 0.5) * seg * s, cy + this.radii[i] * s);
    ctx.closePath(); ctx.fill();

    // Hatching
    ctx.save(); ctx.clip();
    ctx.strokeStyle = "rgba(100,140,180,0.08)"; ctx.lineWidth = 0.5;
    for (let d = -400; d < 800; d += 6) {
      ctx.beginPath(); ctx.moveTo(cx + d, cy - 200); ctx.lineTo(cx + d + 200, cy + 200); ctx.stroke();
    }
    ctx.restore();

    // Outline
    ctx.strokeStyle = "#4a6a8a"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - this.radii[0] * s);
    for (let i = 0; i < LN; i++) ctx.lineTo(cx + (i + 0.5) * seg * s, cy - this.radii[i] * s);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + this.radii[0] * s);
    for (let i = 0; i < LN; i++) ctx.lineTo(cx + (i + 0.5) * seg * s, cy + this.radii[i] * s);
    ctx.stroke();

    // Center line
    ctx.strokeStyle = "#1a3058"; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + STOCK_LEN * s, cy); ctx.stroke();
    ctx.setLineDash([]);

    // Tool
    const tx = cx + this.toolX * s;
    const tz = cy - this.toolZ * s;
    ctx.fillStyle = "#dd4444";
    ctx.beginPath();
    ctx.moveTo(tx, tz); ctx.lineTo(tx + 5 * s, tz - 4 * s); ctx.lineTo(tx + 5 * s, tz + 4 * s);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#aa3333";
    ctx.fillRect(tx + 5 * s, tz - 6 * s, 14 * s, 12 * s);

    // Chips
    ctx.fillStyle = "#bbaa66";
    for (let i = this.chips.length - 1; i >= 0; i--) {
      const c = this.chips[i];
      c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 50 * dt; c.life -= dt;
      const px = cx + c.x * s, py = cy - c.y * s;
      ctx.fillRect(px - 1, py - 1, 2, 2);
      if (c.life <= 0) this.chips.splice(i, 1);
    }

    // Axis labels
    ctx.fillStyle = "#5a8ab5"; ctx.font = "11px monospace";
    ctx.fillText("X →", cx + STOCK_LEN * s + 8, cy + 4);
    ctx.fillText("Z ↑", cx - 20, cy - STOCK_R * s * 1.15);
  }
}

// ─── MILL 3D ENGINE ───────────────────────────────────────────────────────────

let scene, camera, renderer, controls;
let wpMesh, wpGeo, wpPos;
let toolGroup, spindleGrp;
let chipPool = [], chipIdx = 0;
let millRunning = false, millHolding = false;
let millSpindleOn = false, millRpm = 6000, millFeed = 400, millOvr = 1;
let millMode = "MANUAL", millAlarm = "", millEmg = false;
let millToolNo = 1, millRemoved = 0;
let millJogTarget = null;
let millAuto = null, millAutoStep = 0;
let wpPosArr; // position attribute array reference

function initMill() {
  const wrap = $("mill-canvas-wrap");
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1018);

  camera = new THREE.PerspectiveCamera(40, wrap.clientWidth / (wrap.clientHeight || 500), 1, 5000);
  camera.position.set(280, 200, 280);

  renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(wrap.clientWidth, wrap.clientHeight || 500);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  wrap.replaceChildren(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(MW / 2, 0, MD / 2);

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dl = new THREE.DirectionalLight(0xffffff, 0.9);
  dl.position.set(150, 300, 200); dl.castShadow = true;
  dl.shadow.mapSize.set(1024, 1024);
  scene.add(dl);
  scene.add(new THREE.DirectionalLight(0xffffff, 0.3).translateX(-100));

  // Machine table
  const tableMat = new THREE.MeshStandardMaterial({ color: 0x1a2636, metalness: 0.6, roughness: 0.4 });
  const table = new THREE.Mesh(new THREE.BoxGeometry(MW + 80, 6, MD + 80), tableMat);
  table.position.set(MW / 2, -5, MD / 2);
  table.receiveShadow = true;
  scene.add(table);

  // T-slot lines
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x0f1a2a });
  for (let i = 0; i < 5; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(MW + 60, 0.5, 2), slotMat);
    slot.position.set(MW / 2, -1.7, MD * 0.15 + i * MD * 0.175);
    scene.add(slot);
  }

  // Grid
  const grid = new THREE.GridHelper(400, 40, 0x1a2a44, 0x0f1a2a);
  grid.position.set(MW / 2, -8, MD / 2);
  scene.add(grid);

  buildWorkpiece();
  buildTool();
  buildChipPool();

  window.addEventListener("resize", () => {
    const w = wrap.clientWidth, h = wrap.clientHeight || 500;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
}

function buildWorkpiece() {
  if (wpMesh) { scene.remove(wpMesh); wpGeo.dispose(); }
  wpGeo = new THREE.PlaneGeometry(MW, MD, COLS, ROWS);
  wpGeo.rotateX(-Math.PI / 2);
  wpGeo.translate(MW / 2, 0, MD / 2);
  wpPos = wpGeo.attributes.position;
  wpPosArr = wpPos.array;
  for (let i = 0; i < wpPos.count; i++) wpPosArr[i * 3 + 1] = MTOP;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x7a8a9a, metalness: 0.45, roughness: 0.5,
    flatShading: true, side: THREE.DoubleSide
  });
  wpMesh = new THREE.Mesh(wpGeo, mat);
  wpMesh.castShadow = true; wpMesh.receiveShadow = true;
  scene.add(wpMesh);
}

function buildTool() {
  toolGroup = new THREE.Group();
  spindleGrp = new THREE.Group();
  toolGroup.add(spindleGrp);

  const holder = new THREE.Mesh(
    new THREE.CylinderGeometry(8, 8, 12, 20),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.85, roughness: 0.25 })
  );
  holder.position.y = 38; spindleGrp.add(holder);

  const taper = new THREE.Mesh(
    new THREE.CylinderGeometry(6, CUTTER_R, 6, 20),
    new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7, roughness: 0.3 })
  );
  taper.position.y = 29; spindleGrp.add(taper);

  const cutMat = new THREE.MeshStandardMaterial({ color: 0xaabbcc, metalness: 0.9, roughness: 0.12 });
  const cutter = new THREE.Mesh(new THREE.CylinderGeometry(CUTTER_R, CUTTER_R * 0.92, 18, 20), cutMat);
  cutter.position.y = 17; spindleGrp.add(cutter);

  const fluteMat = new THREE.MeshStandardMaterial({ color: 0xddeeff, metalness: 0.95, roughness: 0.08, side: THREE.DoubleSide });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(CUTTER_R * 2.3, 16, 0.4), fluteMat);
    fin.position.y = 17; fin.rotation.y = (i / 4) * Math.PI * 2;
    spindleGrp.add(fin);
  }

  const tip = new THREE.Mesh(new THREE.CylinderGeometry(CUTTER_R * 0.9, 1, 4, 16), cutMat);
  tip.position.y = 6; spindleGrp.add(tip);

  toolGroup.rotation.x = Math.PI;
  toolGroup.position.set(MW / 2, MTOP + 50, MD / 2);
  scene.add(toolGroup);
}

function buildChipPool() {
  const geo = new THREE.BoxGeometry(1.2, 0.3, 0.8);
  const mat = new THREE.MeshStandardMaterial({ color: 0xbbaa77, metalness: 0.6, roughness: 0.4 });
  for (let i = 0; i < CHIP_POOL; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.userData = { vx: 0, vy: 0, vz: 0, life: 0 };
    scene.add(m);
    chipPool.push(m);
  }
}

function spawnChip(x, y, z) {
  const c = chipPool[chipIdx % CHIP_POOL];
  chipIdx++;
  c.visible = true;
  c.position.set(x + (Math.random() - 0.5) * 8, y, z + (Math.random() - 0.5) * 8);
  const s = 0.6 + Math.random() * 1.2;
  c.scale.set(s, 1, 0.5 + Math.random());
  c.userData.vx = (Math.random() - 0.5) * 30;
  c.userData.vy = 8 + Math.random() * 18;
  c.userData.vz = (Math.random() - 0.5) * 30;
  c.userData.life = 1.5 + Math.random();
}

function carve(tx, ty, tz) {
  if (ty >= MTOP) return;
  const r2 = CUTTER_R * CUTTER_R;
  const colW = MW / COLS, rowD = MD / ROWS;
  const ci0 = Math.max(1, Math.floor((tx - CUTTER_R) / colW));
  const ci1 = Math.min(COLS - 1, Math.floor((tx + CUTTER_R) / colW));
  const ri0 = Math.max(1, Math.floor((tz - CUTTER_R) / rowD));
  const ri1 = Math.min(ROWS - 1, Math.floor((tz + CUTTER_R) / rowD));
  let dirty = false, chipSpawned = false;
  for (let ri = ri0; ri <= ri1; ri++) {
    for (let ci = ci0; ci <= ci1; ci++) {
      const idx = ri * (COLS + 1) + ci;
      const vx = wpPosArr[idx * 3];
      const vz = wpPosArr[idx * 3 + 2];
      const dx = vx - tx, dz2 = vz - tz;
      if (dx * dx + dz2 * dz2 > r2) continue;
      if (vx < MARGIN || vx > MW - MARGIN || vz < MARGIN || vz > MD - MARGIN) continue;
      if (wpPosArr[idx * 3 + 1] > ty) {
        wpPosArr[idx * 3 + 1] = ty;
        dirty = true;
        if (!chipSpawned && Math.random() < 0.12) { spawnChip(vx, ty, vz); chipSpawned = true; }
      }
    }
  }
  if (dirty) {
    wpPos.needsUpdate = true;
    wpGeo.computeVertexNormals();
    let cnt = 0, total = 0;
    for (let i = 0; i < wpPos.count; i++) {
      total++;
      if (wpPosArr[i * 3 + 1] < MTOP) cnt++;
    }
    millRemoved = (cnt / total) * 100;
  }
}

function updateMill(dt) {
  if (millEmg) return;
  if (millSpindleOn) spindleGrp.rotation.y += dt * (millRpm / 60) * Math.PI * 0.5;

  // Jog
  if (millJogTarget) {
    const p = toolGroup.position;
    const dx = millJogTarget.x - p.x;
    const dy = millJogTarget.y - p.y;
    const dz = millJogTarget.z - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const spd = 300 * dt;
    if (d < spd) {
      p.set(millJogTarget.x, millJogTarget.y, millJogTarget.z);
      millJogTarget = null;
    } else {
      p.x += (dx / d) * spd; p.y += (dy / d) * spd; p.z += (dz / d) * spd;
    }
    if (millSpindleOn) carve(p.x, p.y, p.z);
  }

  // Auto cycle
  if (!millRunning || millHolding || !millAuto) return;
  const step = millAuto[millAutoStep];
  if (!step) { millRunning = false; return; }

  const speed = step.type === "rapid" ? 800 : millFeed * millOvr;
  const p = toolGroup.position;
  const dx = step.x - p.x, dy = step.y - p.y, dz = step.z - p.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const move = (speed / 60) * dt;

  if (dist < move) {
    p.set(step.x, step.y, step.z);
    if (step.type === "feed" && millSpindleOn) carve(p.x, p.y, p.z);
    millAutoStep++;
    if (millAutoStep >= millAuto.length) millRunning = false;
  } else {
    p.x += (dx / dist) * move; p.y += (dy / dist) * move; p.z += (dz / dist) * move;
    if (step.type === "feed" && millSpindleOn) carve(p.x, p.y, p.z);
  }

  // Chips update
  for (const c of chipPool) {
    if (!c.visible) continue;
    c.userData.vy -= 50 * dt;
    c.position.x += c.userData.vx * dt;
    c.position.y += c.userData.vy * dt;
    c.position.z += c.userData.vz * dt;
    c.rotation.x += dt * 6; c.rotation.z += dt * 4;
    c.userData.life -= dt;
    if (c.userData.life <= 0 || c.position.y < -30) c.visible = false;
  }
}

function millStartCycle() {
  if (millEmg || millMode !== "AUTO") return;
  millSpindleOn = true; millRunning = true; millHolding = false;
  const passes = [];
  const depths = [46, 34];
  const step = CUTTER_R * 1.6;
  for (const y of depths) {
    passes.push({ type: "rapid", x: MARGIN, y: MTOP + 5, z: MARGIN });
    passes.push({ type: "rapid", x: MARGIN, y: y, z: MARGIN });
    let dir = 1;
    for (let z = MARGIN; z <= MD - MARGIN; z += step) {
      const zz = Math.min(z, MD - MARGIN);
      if (dir === 1) {
        passes.push({ type: "feed", x: MARGIN, y, z: zz });
        passes.push({ type: "feed", x: MW - MARGIN, y, z: zz });
      } else {
        passes.push({ type: "feed", x: MW - MARGIN, y, z: zz });
        passes.push({ type: "feed", x: MARGIN, y, z: zz });
      }
      dir *= -1;
    }
  }
  passes.push({ type: "rapid", x: MW / 2, y: MTOP + 50, z: MD / 2 });
  millAuto = passes; millAutoStep = 0;
}

// ─── LCD SYNC ─────────────────────────────────────────────────────────────────

function syncMillLCD() {
  const p = toolGroup ? toolGroup.position : { x: 0, y: 0, z: 0 };
  $("ml-x").textContent = p.x.toFixed(3);
  $("ml-y").textContent = p.z.toFixed(3);
  $("ml-z").textContent = p.y.toFixed(3);
  $("ml-actf").textContent = `ACT.F ${Math.round(millRunning ? millFeed * millOvr : 0)}`;
  $("ml-rpm").textContent = `S ${millSpindleOn ? millRpm : 0}`;
  $("ml-tool").textContent = `T${String(millToolNo).padStart(2, "0")}`;
  $("ml-ovr").textContent = `OVR ${Math.round(millOvr * 100)}%`;
  $("ml-removed").textContent = `REMOVED ${millRemoved.toFixed(1)}%`;
  $("ml-mode").textContent = millMode;
  $("ml-alarm").textContent = millAlarm || "READY";
  $("ml-run").textContent = millEmg ? "EMG" : millRunning ? (millHolding ? "HOLD" : "RUN") : "STOP";

  // Stats overlay
  $("m-stat-pos").textContent = `X ${p.x.toFixed(3)} Y ${p.z.toFixed(3)} Z ${p.y.toFixed(3)}`;
  $("m-stat-tool").textContent = `tool_selected = ${millToolNo}`;
  $("m-stat-cut").textContent = `cutting_status = ${millRunning && !millHolding ? 1 : 0}`;
}

function syncLatheLCD(L) {
  $("lcd-x").textContent = L.toolX.toFixed(3);
  $("lcd-z").textContent = L.toolZ.toFixed(3);
  $("lcd-actf").textContent = `ACT.F ${L.running ? Math.round(L.feed * L.override) : 0} MM/M`;
  $("lcd-rpm").textContent = `S ${L.spindleOn ? L.spindleRpm : 0} RPM`;
  $("lcd-tool").textContent = `T${String(L.toolNo).padStart(2, "0")}00`;
  $("lcd-ovr").textContent = `OVR ${Math.round(L.override * 100)}%`;
  $("lcd-removed").textContent = `REMOVED ${L.removedPct.toFixed(1)}%`;
  $("lcd-mode").textContent = L.mode;
  $("lcd-alarm").textContent = L.alarm || "READY";
  $("lcd-run").textContent = L.emergency ? "EMG" : L.running ? (L.holding ? "HOLD" : "RUN") : "STOP";
}

// ─── MDI KEYPAD ───────────────────────────────────────────────────────────────

function buildKeypad(container, axes) {
  const keys = ["7","8","9","4","5","6","1","2","3",".","0","+/-","DEL","ENT","CLR"];
  container.innerHTML = "";
  for (const k of keys) {
    const btn = document.createElement("button");
    btn.className = "mdi-key h-7 text-[10px]";
    btn.textContent = k;
    btn.addEventListener("click", () => {
      const focused = document.activeElement;
      if (focused && focused.tagName === "INPUT" && axes.some(a => a === focused)) {
        if (k === "DEL") focused.value = focused.value.slice(0, -1);
        else if (k === "CLR") focused.value = "";
        else if (k === "ENT") focused.blur();
        else if (k === "+/-") {
          if (focused.value.startsWith("-")) focused.value = focused.value.slice(1);
          else focused.value = "-" + focused.value;
        }
        else focused.value += k;
      }
    });
    container.appendChild(btn);
  }
}

// ─── TAB SWITCHING ────────────────────────────────────────────────────────────

let currentTab = "mill";

function setTab(tab) {
  currentTab = tab;
  $("view-mill").style.display = tab === "mill" ? "flex" : "none";
  $("view-lathe").style.display = tab === "lathe" ? "flex" : "none";
  $("tab-mill").className = `px-4 py-1.5 text-[12px] font-bold ${tab === "mill" ? "bg-cyan-600 text-white" : "bg-zinc-700 text-zinc-400 hover:bg-zinc-600"}`;
  $("tab-lathe").className = `px-4 py-1.5 text-[12px] font-bold ${tab === "lathe" ? "bg-cyan-600 text-white" : "bg-zinc-700 text-zinc-400 hover:bg-zinc-600"}`;
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

const lathe = new LatheEngine();
let lastT = 0, fpsFrames = 0, fpsTime = 0, fpsVal = 0;

function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min((t - lastT) / 1000, 0.05);
  lastT = t;

  fpsFrames++; fpsTime += dt;
  if (fpsTime >= 0.5) { fpsVal = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }

  if (currentTab === "mill") {
    updateMill(dt);
    // Update chips
    for (const c of chipPool) {
      if (!c.visible) continue;
      c.userData.vy -= 50 * dt;
      c.position.x += c.userData.vx * dt;
      c.position.y += c.userData.vy * dt;
      c.position.z += c.userData.vz * dt;
      c.rotation.x += dt * 6; c.rotation.z += dt * 4;
      c.userData.life -= dt;
      if (c.userData.life <= 0 || c.position.y < -30) c.visible = false;
    }
    controls.update();
    renderer.render(scene, camera);
    syncMillLCD();
    $("m-stat-fps").textContent = `FPS: ${fpsVal}`;
  } else {
    lathe.update(dt);
    const cv = $("lathe-canvas");
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== cv.clientWidth * dpr || cv.height !== cv.clientHeight * dpr) {
      cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    lathe.draw(ctx, cv.clientWidth, cv.clientHeight, dt);
    syncLatheLCD(lathe);
    const hud = $("hud");
    if (hud) hud.textContent = `X ${lathe.toolX.toFixed(1)}  Z ${lathe.toolZ.toFixed(1)}  ${lathe.spindleOn ? "◎ " + lathe.spindleRpm + " rpm" : "OFF"}  FPS ${fpsVal}`;
  }
}

// ─── EVENT WIRING ─────────────────────────────────────────────────────────────

function wireEvents() {
  // Tab switching
  $("tab-mill").addEventListener("click", () => setTab("mill"));
  $("tab-lathe").addEventListener("click", () => setTab("lathe"));

  // ── MILL EVENTS ──

  // Mode
  const mmManual = $("mmode-manual"), mmAuto = $("mmode-auto");
  function setMillMode(m) {
    millMode = m;
    mmManual.className = `rounded py-2 text-[10px] font-bold ${m === "MANUAL" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
    mmAuto.className = `rounded py-2 text-[10px] font-bold ${m === "AUTO" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  }
  mmManual.addEventListener("click", () => setMillMode("MANUAL"));
  mmAuto.addEventListener("click", () => setMillMode("AUTO"));
  setMillMode("MANUAL");

  // Spindle / Feed / Override sliders
  $("mrng-rpm").addEventListener("input", e => { millRpm = +e.target.value; $("mlbl-rpm").textContent = `${millRpm} rpm`; });
  $("mrng-feed").addEventListener("input", e => { millFeed = +e.target.value; $("mlbl-feed").textContent = `${millFeed} mm/m`; });
  $("mrng-ovr").addEventListener("input", e => { millOvr = +e.target.value; $("mlbl-ovr").textContent = `${Math.round(millOvr * 100)}%`; });

  // Tool selector
  $("mtool-minus").addEventListener("click", () => { millToolNo = Math.max(1, millToolNo - 1); $("mlbl-tool").textContent = `T${String(millToolNo).padStart(2, "0")}`; });
  $("mtool-plus").addEventListener("click", () => { millToolNo = Math.min(20, millToolNo + 1); $("mlbl-tool").textContent = `T${String(millToolNo).padStart(2, "0")}`; });

  // Jog buttons
  document.querySelectorAll(".mjog").forEach(btn => {
    btn.addEventListener("click", () => {
      if (millMode !== "MANUAL" || millEmg) return;
      const axis = btn.dataset.a, dir = +btn.dataset.d;
      const step = 10;
      const p = toolGroup.position;
      const nx = axis === "x" ? p.x + dir * step : p.x;
      const ny = axis === "y" ? p.y + dir * step : p.y;
      const nz = axis === "z" ? p.z + dir * step : p.z;
      millJogTarget = { x: nx, y: ny, z: nz };
    });
  });

  // MDI go
  $("me-go").addEventListener("click", () => {
    if (millMode !== "MANUAL" || millEmg) return;
    const x = parseFloat($("me-x").value) || toolGroup.position.x;
    const y = parseFloat($("me-y").value) || toolGroup.position.y;
    const z = parseFloat($("me-z").value) || toolGroup.position.z;
    millJogTarget = { x, y, z };
  });

  // Spindle toggle
  $("mbtn-spindle").addEventListener("click", () => {
    if (millEmg) return;
    millSpindleOn = !millSpindleOn;
    $("mspindle-icon").className = millSpindleOn ? "text-base animate-spin-slow" : "text-base";
    $("mspindle-label").textContent = millSpindleOn ? "SPINDLE ON" : "SPINDLE OFF";
    $("mbtn-spindle").className = `flex flex-col items-center gap-1 rounded py-2 text-[10px] font-bold ${millSpindleOn ? "bg-emerald-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  });

  // Cycle start / hold
  $("mbtn-cycle").addEventListener("click", () => millStartCycle());
  $("mbtn-hold").addEventListener("click", () => {
    if (millRunning) { millHolding = !millHolding; }
  });

  // Emergency
  $("mbtn-emg").addEventListener("click", () => {
    millEmg = true; millRunning = false; millSpindleOn = false;
    millAlarm = "EMG STOP";
  });
  $("mbtn-reset").addEventListener("click", () => {
    millEmg = false; millAlarm = ""; millHolding = false;
    $("mspindle-icon").className = "text-base";
    $("mspindle-label").textContent = "SPINDLE OFF";
    $("mbtn-spindle").className = "flex flex-col items-center gap-1 rounded bg-zinc-700 py-2 text-[10px] font-bold hover:bg-zinc-600";
  });
  $("mbtn-newp").addEventListener("click", () => {
    buildWorkpiece();
    millRunning = false; millAutoStep = 0; millAuto = null;
    millRemoved = 0;
    toolGroup.position.set(MW / 2, MTOP + 50, MD / 2);
  });

  // Viewport buttons
  $("m-play").addEventListener("click", () => millStartCycle());
  $("m-pause").addEventListener("click", () => { if (millRunning) millHolding = !millHolding; });
  $("m-stop").addEventListener("click", () => {
    millRunning = false; millAuto = null; millAutoStep = 0;
  });
  $("m-new").addEventListener("click", () => {
    buildWorkpiece();
    millRunning = false; millAutoStep = 0; millAuto = null;
    millRemoved = 0;
    toolGroup.position.set(MW / 2, MTOP + 50, MD / 2);
  });

  // Camera views
  document.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = controls.target;
      const d = 280;
      switch (btn.dataset.view) {
        case "iso": camera.position.set(t.x + d, t.y + d * 0.7, t.z + d); break;
        case "top": camera.position.set(t.x, t.y + d, t.z); break;
        case "front": camera.position.set(t.x, t.y, t.z + d); break;
        case "right": camera.position.set(t.x + d, t.y, t.z); break;
      }
      camera.lookAt(t); controls.update();
    });
  });

  // Wireframe toggle
  $("m-wire").addEventListener("click", () => {
    if (wpMesh) wpMesh.material.wireframe = !wpMesh.material.wireframe;
  });

  // Mill MDI keypad
  buildKeypad($("mmdi"), [$("me-x"), $("me-y"), $("me-z")]);

  // ── LATHE EVENTS ──

  // Mode
  const lmManual = $("mode-manual"), lmAuto = $("mode-auto");
  function setLatheMode(m) {
    lathe.mode = m;
    lmManual.className = `rounded py-2 text-[10px] font-bold ${m === "MANUAL" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
    lmAuto.className = `rounded py-2 text-[10px] font-bold ${m === "AUTO" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  }
  lmManual.addEventListener("click", () => setLatheMode("MANUAL"));
  lmAuto.addEventListener("click", () => setLatheMode("AUTO"));
  setLatheMode("MANUAL");

  // Spindle / Feed / Override
  $("rng-rpm").addEventListener("input", e => { lathe.spindleRpm = +e.target.value; $("lbl-rpm").textContent = `${lathe.spindleRpm} rpm`; });
  $("rng-feed").addEventListener("input", e => { lathe.feed = +e.target.value; $("lbl-feed").textContent = `${lathe.feed} mm/m`; });
  $("rng-ovr").addEventListener("input", e => { lathe.override = +e.target.value; $("lbl-ovr").textContent = `${Math.round(lathe.override * 100)}%`; });

  // Tool selector
  $("tool-minus").addEventListener("click", () => { lathe.toolNo = Math.max(1, lathe.toolNo - 1); $("lbl-tool").textContent = `T${String(lathe.toolNo).padStart(2, "0")}`; });
  $("tool-plus").addEventListener("click", () => { lathe.toolNo = Math.min(20, lathe.toolNo + 1); $("lbl-tool").textContent = `T${String(lathe.toolNo).padStart(2, "0")}`; });

  // Jog
  document.querySelectorAll(".jog").forEach(btn => {
    btn.addEventListener("click", () => {
      if (lathe.mode !== "MANUAL" || lathe.emergency) return;
      const dx = +btn.dataset.dx * 5;
      const dz = +btn.dataset.dz * 5;
      lathe.jogTarget = { x: lathe.toolX + dx, z: lathe.toolZ + dz };
    });
  });

  // MDI go
  $("btn-goto").addEventListener("click", () => {
    if (lathe.mode !== "MANUAL" || lathe.emergency) return;
    const x = parseFloat($("edit-x").value);
    const z = parseFloat($("edit-z").value);
    lathe.jogTarget = { x: isNaN(x) ? lathe.toolX : x, z: isNaN(z) ? lathe.toolZ : z };
  });

  // Spindle toggle
  $("btn-spindle").addEventListener("click", () => {
    if (lathe.emergency) return;
    lathe.spindleOn = !lathe.spindleOn;
    $("spindle-icon").className = lathe.spindleOn ? "text-base animate-spin-slow" : "text-base";
    $("spindle-label").textContent = lathe.spindleOn ? "SPINDLE ON" : "SPINDLE OFF";
    $("btn-spindle").className = `flex flex-col items-center gap-1 rounded py-2 text-[10px] font-bold ${lathe.spindleOn ? "bg-emerald-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  });

  // Cycle / Hold
  $("btn-cycle").addEventListener("click", () => lathe.startCycle());
  $("btn-hold").addEventListener("click", () => {
    if (lathe.running) lathe.holding = !lathe.holding;
  });

  // Emergency
  $("btn-emg").addEventListener("click", () => {
    lathe.emergency = true; lathe.running = false; lathe.spindleOn = false;
    lathe.alarm = "EMG STOP";
  });
  $("btn-reset").addEventListener("click", () => {
    lathe.emergency = false; lathe.alarm = ""; lathe.holding = false;
    $("spindle-icon").className = "text-base";
    $("spindle-label").textContent = "SPINDLE OFF";
    $("btn-spindle").className = "flex flex-col items-center gap-1 rounded bg-zinc-700 py-2 text-[10px] font-bold hover:bg-zinc-600";
  });
  $("btn-new").addEventListener("click", () => lathe.reset());

  // Lathe MDI keypad
  buildKeypad($("mdi-rows"), [$("edit-x"), $("edit-z")]);

  // Mute button (placeholder)
  const muteBtn = $("m-mute");
  if (muteBtn) {
    let muted = false;
    muteBtn.addEventListener("click", () => {
      muted = !muted;
      muteBtn.textContent = muted ? "🔇" : "🔊";
    });
  }
}

// ─── CAM INTEGRATION ──────────────────────────────────────────────────────────

function checkCamData() {
  const raw = sessionStorage.getItem("rover_cnc_gcode");
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (!data.gcode) return;
    if (data.machineType === "torna") {
      setTab("lathe");
    } else {
      setTab("mill");
    }
  } catch {}
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

initMill();
setTab("mill");
wireEvents();
checkCamData();
requestAnimationFrame(loop);
