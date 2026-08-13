import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = id => document.getElementById(id);

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MW = 200, MD = 140, MTOP = 60;
const COLS = 150, ROWS = 105;
const CUTTER_R = 13, MARGIN = 6;

const LN = 260, STOCK_LEN = 200, STOCK_R = 60, TOOL_HALF_W = 3.2;

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
      if (Math.random() < 0.45) {
        this.chips.push({
          x: x + (Math.random() - 0.5) * 6,
          y: z + (Math.random() > 0.5 ? 1 : -1) * (r + 3),
          vx: (Math.random() - 0.5) * 60,
          vy: (Math.random() > 0.5 ? 1 : -1) * (20 + Math.random() * 35),
          life: 1.4 + Math.random() * 0.8,
          size: 1 + Math.random() * 2
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
      if (this.autoStep >= this.autoCycle.length) this.running = false;
    } else {
      this.toolX += (dx / dist) * move;
      this.toolZ += (dz / dist) * move;
      if (step.type === "feed" && this.spindleOn) this.cutAt(this.toolX, this.toolZ);
    }
  }

  draw(ctx, w, h, dt) {
    ctx.fillStyle = "#080e14";
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

    // Chuck — bronze/copper metallic
    const chR = STOCK_R * s * 1.2;
    const chX = cx - 14;
    ctx.save(); ctx.translate(chX, cy);
    ctx.rotate(this.chuckAngle);

    // Chuck body
    const cg = ctx.createRadialGradient(0, 0, chR * 0.2, 0, 0, chR);
    cg.addColorStop(0, "#b8860b");
    cg.addColorStop(0.3, "#8B6914");
    cg.addColorStop(0.6, "#6b4e0a");
    cg.addColorStop(0.85, "#4a3508");
    cg.addColorStop(1, "#2a1f05");
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(0, 0, chR, 0, Math.PI * 2); ctx.fill();

    // Chuck rings
    ctx.strokeStyle = "rgba(218,165,32,0.3)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, chR * 0.7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, chR * 0.45, 0, Math.PI * 2); ctx.stroke();

    // Chuck jaws (3 jaws)
    ctx.lineWidth = 2.5;
    for (let j = 0; j < 3; j++) {
      const a = (j / 3) * Math.PI * 2;
      ctx.strokeStyle = "rgba(218,165,32,0.5)";
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * chR * 0.35, Math.sin(a) * chR * 0.35);
      ctx.lineTo(Math.cos(a) * chR * 0.95, Math.sin(a) * chR * 0.95);
      ctx.stroke();
      // Jaw blocks
      const jawX = Math.cos(a) * chR * 0.82;
      const jawY = Math.sin(a) * chR * 0.82;
      ctx.save();
      ctx.translate(jawX, jawY);
      ctx.rotate(a);
      ctx.fillStyle = "#7a6010";
      ctx.fillRect(-8, -4, 16, 8);
      ctx.strokeStyle = "#b8860b";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(-8, -4, 16, 8);
      ctx.restore();
    }

    // Chuck center bore
    ctx.fillStyle = "#1a1205";
    ctx.beginPath(); ctx.arc(0, 0, chR * 0.15, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // Workpiece — warm copper/bronze metallic gradient
    const seg = STOCK_LEN / LN;
    const grad = ctx.createLinearGradient(cx, cy - STOCK_R * s, cx, cy + STOCK_R * s);
    grad.addColorStop(0, "#8B6914");
    grad.addColorStop(0.15, "#c49a2a");
    grad.addColorStop(0.3, "#dab84a");
    grad.addColorStop(0.45, "#e8cc6a");
    grad.addColorStop(0.55, "#e8cc6a");
    grad.addColorStop(0.7, "#dab84a");
    grad.addColorStop(0.85, "#c49a2a");
    grad.addColorStop(1, "#6b4e0a");

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy - this.radii[0] * s);
    for (let i = 0; i < LN; i++) ctx.lineTo(cx + (i + 0.5) * seg * s, cy - this.radii[i] * s);
    ctx.lineTo(cx + STOCK_LEN * s, cy);
    for (let i = LN - 1; i >= 0; i--) ctx.lineTo(cx + (i + 0.5) * seg * s, cy + this.radii[i] * s);
    ctx.closePath(); ctx.fill();

    // Machining rings — concentric ridges where cutting occurred
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - this.radii[0] * s);
    for (let i = 0; i < LN; i++) ctx.lineTo(cx + (i + 0.5) * seg * s, cy - this.radii[i] * s);
    ctx.lineTo(cx + STOCK_LEN * s, cy);
    for (let i = LN - 1; i >= 0; i--) ctx.lineTo(cx + (i + 0.5) * seg * s, cy + this.radii[i] * s);
    ctx.closePath(); ctx.clip();

    // Draw fine concentric rings for machined surfaces
    ctx.strokeStyle = "rgba(139,105,20,0.15)"; ctx.lineWidth = 0.5;
    for (let r = 5; r < STOCK_R; r += 2) {
      let hasCut = false;
      for (let i = 0; i < LN; i++) {
        if (this.radii[i] <= r + 1 && this.radii[i] >= r - 1) { hasCut = true; break; }
      }
      if (!hasCut) continue;
      const ry = r * s;
      ctx.beginPath(); ctx.moveTo(cx, cy - ry); ctx.lineTo(cx + STOCK_LEN * s, cy - ry); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy + ry); ctx.lineTo(cx + STOCK_LEN * s, cy + ry); ctx.stroke();
    }

    // Hatching for metallic look
    ctx.strokeStyle = "rgba(218,184,74,0.06)"; ctx.lineWidth = 0.5;
    for (let d = -400; d < 800; d += 5) {
      ctx.beginPath(); ctx.moveTo(cx + d, cy - 200); ctx.lineTo(cx + d + 200, cy + 200); ctx.stroke();
    }

    // Step edges where radius changed abruptly
    ctx.strokeStyle = "rgba(100,75,10,0.4)"; ctx.lineWidth = 1;
    for (let i = 1; i < LN; i++) {
      const diff = Math.abs(this.radii[i] - this.radii[i-1]);
      if (diff > 1) {
        const px = cx + i * seg * s;
        ctx.beginPath(); ctx.moveTo(px, cy - Math.max(this.radii[i], this.radii[i-1]) * s);
        ctx.lineTo(px, cy + Math.max(this.radii[i], this.radii[i-1]) * s); ctx.stroke();
      }
    }

    ctx.restore();

    // Outline
    ctx.strokeStyle = "#8B6914"; ctx.lineWidth = 1.5;
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

    // Tool — more detailed
    const tx = cx + this.toolX * s;
    const tz = cy - this.toolZ * s;

    // Tool holder
    ctx.fillStyle = "#333";
    ctx.fillRect(tx + 6 * s, tz - 8 * s, 18 * s, 16 * s);
    ctx.strokeStyle = "#555"; ctx.lineWidth = 1;
    ctx.strokeRect(tx + 6 * s, tz - 8 * s, 18 * s, 16 * s);

    // Tool shank
    ctx.fillStyle = "#555";
    ctx.fillRect(tx + 2 * s, tz - 5 * s, 6 * s, 10 * s);

    // Tool insert (cutting tip)
    ctx.fillStyle = "#dd3333";
    ctx.beginPath();
    ctx.moveTo(tx, tz);
    ctx.lineTo(tx + 5 * s, tz - 4 * s);
    ctx.lineTo(tx + 5 * s, tz + 4 * s);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#ff5555"; ctx.lineWidth = 0.5; ctx.stroke();

    // Cutting edge highlight
    ctx.strokeStyle = "#ffaa00"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(tx, tz - 0.5); ctx.lineTo(tx, tz + 0.5); ctx.stroke();

    // Chips — golden metallic
    for (let i = this.chips.length - 1; i >= 0; i--) {
      const c = this.chips[i];
      c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 60 * dt; c.life -= dt;
      const px = cx + c.x * s, py = cy - c.y * s;
      const alpha = Math.min(1, c.life);
      ctx.fillStyle = `rgba(218,184,74,${alpha})`;
      ctx.fillRect(px - c.size / 2, py - c.size / 2, c.size, c.size);
      if (c.life <= 0) this.chips.splice(i, 1);
    }

    // Axis labels
    ctx.fillStyle = "#b8860b"; ctx.font = "bold 11px monospace";
    ctx.fillText("X →", cx + STOCK_LEN * s + 10, cy + 4);
    ctx.fillText("Z ↑", cx - 22, cy - STOCK_R * s * 1.2);
  }
}

// ─── MILL 3D ENGINE ───────────────────────────────────────────────────────────

let scene, camera, renderer, controls;
let wpMesh, wpGeo, wpPos, wpPosArr;
let toolGroup, spindleGrp;
let chipPool = [], chipIdx = 0;
let millRunning = false, millHolding = false;
let millSpindleOn = false, millRpm = 6000, millFeed = 400, millOvr = 1;
let millMode = "MANUAL", millAlarm = "", millEmg = false;
let millToolNo = 1, millRemoved = 0;
let millJogTarget = null;
let millAuto = null, millAutoStep = 0;

function initMill() {
  const wrap = $("mill-canvas-wrap");
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080e14);
  scene.fog = new THREE.Fog(0x080e14, 600, 1200);

  camera = new THREE.PerspectiveCamera(38, wrap.clientWidth / (wrap.clientHeight || 500), 1, 5000);
  camera.position.set(240, 180, 260);

  renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(wrap.clientWidth, wrap.clientHeight || 500);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  wrap.replaceChildren(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(MW / 2, MTOP / 2, MD / 2);

  // Lighting — dramatic
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dl = new THREE.DirectionalLight(0xffffff, 1.2);
  dl.position.set(180, 350, 220); dl.castShadow = true;
  dl.shadow.mapSize.set(2048, 2048);
  dl.shadow.camera.left = -200; dl.shadow.camera.right = 200;
  dl.shadow.camera.top = 200; dl.shadow.camera.bottom = -200;
  dl.shadow.bias = -0.001;
  scene.add(dl);
  const fill = new THREE.DirectionalLight(0x4488cc, 0.4);
  fill.position.set(-150, 100, -100);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.3);
  rim.position.set(0, -50, -200);
  scene.add(rim);

  // Machine table — dark industrial
  const tableMat = new THREE.MeshStandardMaterial({ color: 0x1a2636, metalness: 0.7, roughness: 0.35 });
  const table = new THREE.Mesh(new THREE.BoxGeometry(MW + 100, 8, MD + 100), tableMat);
  table.position.set(MW / 2, -6, MD / 2);
  table.receiveShadow = true; table.castShadow = true;
  scene.add(table);

  // T-slot lines
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x0a1220, metalness: 0.8, roughness: 0.3 });
  for (let i = 0; i < 5; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(MW + 80, 0.6, 2.5), slotMat);
    slot.position.set(MW / 2, -1.6, MD * 0.12 + i * MD * 0.19);
    scene.add(slot);
  }

  // Grid
  const grid = new THREE.GridHelper(500, 50, 0x1a2a44, 0x0a1420);
  grid.position.set(MW / 2, -10, MD / 2);
  scene.add(grid);

  // Base plate
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x0e1a28, metalness: 0.6, roughness: 0.5 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(600, 2, 600), baseMat);
  base.position.set(MW / 2, -11, MD / 2);
  base.receiveShadow = true;
  scene.add(base);

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
    color: 0x0891b2,
    metalness: 0.35,
    roughness: 0.45,
    flatShading: true,
    side: THREE.DoubleSide
  });
  wpMesh = new THREE.Mesh(wpGeo, mat);
  wpMesh.castShadow = true; wpMesh.receiveShadow = true;
  scene.add(wpMesh);

  // Side faces
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x067a96, metalness: 0.4, roughness: 0.5 });
  const sideGeos = [
    { w: MW, h: MTOP, px: MW / 2, pz: 0, ry: 0 },
    { w: MW, h: MTOP, px: MW / 2, pz: MD, ry: Math.PI },
    { w: MD, h: MTOP, px: 0, pz: MD / 2, ry: Math.PI / 2 },
    { w: MD, h: MTOP, px: MW, pz: MD / 2, ry: -Math.PI / 2 },
  ];
  for (const sg of sideGeos) {
    const g = new THREE.PlaneGeometry(sg.w, sg.h);
    const m = new THREE.Mesh(g, sideMat);
    m.position.set(sg.px, MTOP / 2, sg.pz);
    m.rotation.y = sg.ry;
    m.castShadow = true;
    scene.add(m);
  }
  // Bottom face
  const botGeo = new THREE.PlaneGeometry(MW, MD);
  const bot = new THREE.Mesh(botGeo, sideMat);
  bot.position.set(MW / 2, 0, MD / 2);
  bot.rotation.x = Math.PI / 2;
  scene.add(bot);
}

function buildTool() {
  if (toolGroup) scene.remove(toolGroup);
  toolGroup = new THREE.Group();
  spindleGrp = new THREE.Group();
  toolGroup.add(spindleGrp);

  // Spindle housing
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.9, roughness: 0.2 });
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(14, 12, 20, 24), housingMat);
  housing.position.y = 50; spindleGrp.add(housing);

  // Holder
  const holderMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.88, roughness: 0.18 });
  const holder = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 14, 24), holderMat);
  holder.position.y = 36; spindleGrp.add(holder);

  // Taper
  const taperMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.75, roughness: 0.25 });
  const taper = new THREE.Mesh(new THREE.CylinderGeometry(7, CUTTER_R + 1, 8, 22), taperMat);
  taper.position.y = 25; spindleGrp.add(taper);

  // Cutter body
  const cutMat = new THREE.MeshStandardMaterial({ color: 0x99aacc, metalness: 0.92, roughness: 0.1 });
  const cutter = new THREE.Mesh(new THREE.CylinderGeometry(CUTTER_R, CUTTER_R * 0.92, 20, 22), cutMat);
  cutter.position.y = 11; spindleGrp.add(cutter);

  // Flutes
  const fluteMat = new THREE.MeshStandardMaterial({ color: 0xddeeff, metalness: 0.95, roughness: 0.06, side: THREE.DoubleSide });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(CUTTER_R * 2.4, 18, 0.5), fluteMat);
    fin.position.y = 11; fin.rotation.y = (i / 4) * Math.PI * 2;
    spindleGrp.add(fin);
  }

  // Tip
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(CUTTER_R * 0.9, 1, 5, 18), cutMat);
  tip.position.y = -1; spindleGrp.add(tip);

  toolGroup.rotation.x = Math.PI;
  toolGroup.position.set(MW / 2, MTOP + 60, MD / 2);
  scene.add(toolGroup);
}

function buildChipPool() {
  const geo = new THREE.BoxGeometry(1.4, 0.4, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x0891b2, metalness: 0.5, roughness: 0.4, emissive: 0x033040, emissiveIntensity: 0.2 });
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
  c.position.set(x + (Math.random() - 0.5) * 10, y, z + (Math.random() - 0.5) * 10);
  const s = 0.6 + Math.random() * 1.5;
  c.scale.set(s, 1, 0.5 + Math.random());
  c.userData.vx = (Math.random() - 0.5) * 40;
  c.userData.vy = 10 + Math.random() * 25;
  c.userData.vz = (Math.random() - 0.5) * 40;
  c.userData.life = 1.8 + Math.random();
}

function carve(tx, ty, tz) {
  if (ty >= MTOP) return;
  const r2 = CUTTER_R * CUTTER_R;
  const colW = MW / COLS, rowD = MD / ROWS;
  const ci0 = Math.max(1, Math.floor((tx - CUTTER_R) / colW));
  const ci1 = Math.min(COLS - 1, Math.floor((tx + CUTTER_R) / colW));
  const ri0 = Math.max(1, Math.floor((tz - CUTTER_R) / rowD));
  const ri1 = Math.min(ROWS - 1, Math.floor((tz + CUTTER_R) / rowD));
  let dirty = false, chipCount = 0;
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
        if (chipCount < 3 && Math.random() < 0.15) { spawnChip(vx, ty, vz); chipCount++; }
      }
    }
  }
  if (dirty) {
    wpPos.needsUpdate = true;
    wpGeo.computeVertexNormals();
    let cnt = 0, total = 0;
    for (let i = 0; i < wpPos.count; i++) {
      total++;
      if (wpPosArr[i * 3 + 1] < MTOP - 0.1) cnt++;
    }
    millRemoved = (cnt / total) * 100;
  }
}

function updateMill(dt) {
  if (millEmg) return;
  if (millSpindleOn) spindleGrp.rotation.y += dt * (millRpm / 60) * Math.PI * 0.5;

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
}

function updateChips(dt) {
  for (const c of chipPool) {
    if (!c.visible) continue;
    c.userData.vy -= 60 * dt;
    c.position.x += c.userData.vx * dt;
    c.position.y += c.userData.vy * dt;
    c.position.z += c.userData.vz * dt;
    c.rotation.x += dt * 8; c.rotation.z += dt * 5;
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
  const safeY = MTOP + 8;
  const x0 = -MARGIN, x1 = MW + MARGIN;
  const z0 = MARGIN, z1 = MD - MARGIN;
  for (const y of depths) {
    passes.push({ type: "rapid", x: x0, y: safeY, z: z0 });
    passes.push({ type: "rapid", x: x0, y, z: z0 });
    let dir = 1;
    for (let z = z0; z <= z1; z += step) {
      const zz = Math.min(z, z1);
      if (dir === 1) {
        passes.push({ type: "feed", x: x0, y, z: zz });
        passes.push({ type: "feed", x: x1, y, z: zz });
      } else {
        passes.push({ type: "feed", x: x1, y, z: zz });
        passes.push({ type: "feed", x: x0, y, z: zz });
      }
      dir *= -1;
    }
  }
  passes.push({ type: "rapid", x: MW / 2, y: MTOP + 60, z: MD / 2 });
  millAuto = passes; millAutoStep = 0;
}

// ─── LCD SYNC ─────────────────────────────────────────────────────────────────

function syncMillLCD() {
  const p = toolGroup ? toolGroup.position : { x: 0, y: 0, z: 0 };
  $("ml-x").textContent = p.x.toFixed(3);
  $("ml-y").textContent = p.z.toFixed(3);
  $("ml-z").textContent = p.y.toFixed(3);
  $("ml-actf").textContent = `ACT.F ${Math.round(millRunning && !millHolding ? millFeed * millOvr : 0)}`;
  $("ml-rpm").textContent = `S ${millSpindleOn ? millRpm : 0}`;
  $("ml-tool").textContent = `T${String(millToolNo).padStart(2, "0")}`;
  $("ml-ovr").textContent = `OVR ${Math.round(millOvr * 100)}%`;
  $("ml-removed").textContent = `REMOVED ${millRemoved.toFixed(1)}%`;
  $("ml-mode").textContent = millMode;
  $("ml-alarm").textContent = millAlarm || (millEmg ? "EMG STOP" : "READY");
  $("ml-alarm").style.color = millAlarm || millEmg ? "#ff4444" : "#59c98e";
  $("ml-run").textContent = millEmg ? "EMG" : millRunning ? (millHolding ? "HOLD" : "RUN") : "STOP";
  $("ml-run").style.color = millRunning && !millHolding ? "#5be08a" : "#59c98e";

  $("m-stat-pos").textContent = `X ${p.x.toFixed(3)} Y ${p.z.toFixed(3)} Z ${p.y.toFixed(3)}`;
  $("m-stat-tool").textContent = `tool_selected = ${millToolNo}`;
  $("m-stat-cut").textContent = `cutting_status = ${millRunning && !millHolding ? 1 : 0}`;
}

function syncLatheLCD(L) {
  $("lcd-x").textContent = L.toolX.toFixed(3);
  $("lcd-z").textContent = L.toolZ.toFixed(3);
  $("lcd-actf").textContent = `ACT.F ${L.running && !L.holding ? Math.round(L.feed * L.override) : 0} MM/M`;
  $("lcd-rpm").textContent = `S ${L.spindleOn ? L.spindleRpm : 0} RPM`;
  $("lcd-tool").textContent = `T${String(L.toolNo).padStart(2, "0")}00`;
  $("lcd-ovr").textContent = `OVR ${Math.round(L.override * 100)}%`;
  $("lcd-removed").textContent = `REMOVED ${L.removedPct.toFixed(1)}%`;
  $("lcd-mode").textContent = L.mode;
  $("lcd-alarm").textContent = L.alarm || (L.emergency ? "EMG STOP" : "READY");
  $("lcd-alarm").style.color = L.alarm || L.emergency ? "#ff4444" : "#59c98e";
  $("lcd-run").textContent = L.emergency ? "EMG" : L.running ? (L.holding ? "HOLD" : "RUN") : "STOP";
  $("lcd-run").style.color = L.running && !L.holding ? "#5be08a" : "#59c98e";
}

// ─── MDI KEYPAD — Full Fanuc ──────────────────────────────────────────────────

function buildMillKeypad(container, inputs) {
  const keys = [
    "7","8","9","X","Y","Z",
    "4","5","6","G","M","S",
    "1","2","3","F","H","T",
    "0",".","+/-","EOB","INP","CAN"
  ];
  container.innerHTML = "";
  for (const k of keys) {
    const btn = document.createElement("button");
    const isLetter = /^[A-Z]$/.test(k);
    const isFunc = ["EOB","INP","CAN"].includes(k);
    btn.className = `mdi-key h-7 text-[10px] ${isLetter ? "!bg-gradient-to-b !from-amber-100 !to-amber-300 !text-amber-900" : isFunc ? "!bg-gradient-to-b !from-zinc-300 !to-zinc-500 !text-zinc-900 !text-[8px]" : ""}`;
    btn.textContent = k;
    btn.addEventListener("click", () => keyAction(k, inputs));
    container.appendChild(btn);
  }
}

function buildLatheKeypad(rowContainer, fnContainer, inputs) {
  const keys = [
    "O","N","G","7","8","9",
    "X","Z","F","4","5","6",
    "M","S","T","1","2","3",
    "U","W",".","0","+/-","EOB"
  ];
  rowContainer.innerHTML = "";
  for (const k of keys) {
    const btn = document.createElement("button");
    const isLetter = /^[A-Z]$/.test(k);
    const isFunc = k === "EOB";
    btn.className = `mdi-key h-7 text-[10px] ${isLetter ? "!bg-gradient-to-b !from-amber-100 !to-amber-300 !text-amber-900" : isFunc ? "!bg-gradient-to-b !from-zinc-300 !to-zinc-500 !text-zinc-900 !text-[8px]" : ""}`;
    btn.textContent = k;
    btn.addEventListener("click", () => keyAction(k, inputs));
    rowContainer.appendChild(btn);
  }

  // Function keys
  const fnKeys = [
    "POS","PROG","SET","SHIFT","CAN","INPUT",
    "SYSTEM","MSG","GRAPH","ALTER","INSERT","DELETE"
  ];
  fnContainer.innerHTML = "";
  for (const k of fnKeys) {
    const btn = document.createElement("button");
    btn.className = "mdi-key h-6 text-[7px] !bg-gradient-to-b !from-zinc-200 !to-zinc-400 !text-zinc-800 font-bold";
    btn.textContent = k;
    btn.addEventListener("click", () => keyAction(k, inputs));
    fnContainer.appendChild(btn);
  }
}

function keyAction(k, inputs) {
  const focused = document.activeElement;
  const isInput = focused && focused.tagName === "INPUT" && inputs.includes(focused);
  if (!isInput && inputs.length > 0) inputs[0].focus();
  const target = isInput ? focused : inputs[0];
  if (!target) return;

  if (k === "DEL" || k === "DELETE") target.value = target.value.slice(0, -1);
  else if (k === "CLR" || k === "CAN") target.value = "";
  else if (k === "ENT" || k === "INPUT" || k === "INP") target.blur();
  else if (k === "+/-") {
    target.value = target.value.startsWith("-") ? target.value.slice(1) : "-" + target.value;
  }
  else if (k === "EOB" || k.length > 1) { /* functional keys — no character input */ }
  else target.value += k;
}

// ─── CAMERA VIEWS ─────────────────────────────────────────────────────────────

function setMillCamera(view) {
  if (!camera || !controls) return;
  const t = controls.target;
  const d = 240;
  switch (view) {
    case "iso":
      camera.position.set(t.x + d, t.y + d * 0.75, t.z + d);
      break;
    case "top":
      camera.position.set(t.x, t.y + d * 1.2, t.z + 0.01);
      break;
    case "front":
      camera.position.set(t.x, t.y + d * 0.15, t.z + d);
      break;
    case "right":
      camera.position.set(t.x + d, t.y + d * 0.15, t.z);
      break;
  }
  camera.lookAt(t); controls.update();
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
    updateChips(dt);
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
  $("tab-mill").addEventListener("click", () => setTab("mill"));
  $("tab-lathe").addEventListener("click", () => setTab("lathe"));

  // ── MILL ──

  const mmManual = $("mmode-manual"), mmAuto = $("mmode-auto");
  function setMillMode(m) {
    millMode = m;
    mmManual.className = `rounded py-2 text-[10px] font-bold ${m === "MANUAL" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
    mmAuto.className = `rounded py-2 text-[10px] font-bold ${m === "AUTO" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  }
  mmManual.addEventListener("click", () => setMillMode("MANUAL"));
  mmAuto.addEventListener("click", () => setMillMode("AUTO"));
  setMillMode("MANUAL");

  $("mrng-rpm").addEventListener("input", e => { millRpm = +e.target.value; $("mlbl-rpm").textContent = `${millRpm} rpm`; });
  $("mrng-feed").addEventListener("input", e => { millFeed = +e.target.value; $("mlbl-feed").textContent = `${millFeed} mm/m`; });
  $("mrng-ovr").addEventListener("input", e => { millOvr = +e.target.value; $("mlbl-ovr").textContent = `${Math.round(millOvr * 100)}%`; });

  $("mtool-minus").addEventListener("click", () => { millToolNo = Math.max(1, millToolNo - 1); $("mlbl-tool").textContent = `T${String(millToolNo).padStart(2, "0")}`; });
  $("mtool-plus").addEventListener("click", () => { millToolNo = Math.min(20, millToolNo + 1); $("mlbl-tool").textContent = `T${String(millToolNo).padStart(2, "0")}`; });

  document.querySelectorAll(".mjog").forEach(btn => {
    btn.addEventListener("click", () => {
      if (millMode !== "MANUAL" || millEmg) return;
      const axis = btn.dataset.a, dir = +btn.dataset.d;
      const step = 10;
      const p = toolGroup.position;
      millJogTarget = {
        x: axis === "x" ? p.x + dir * step : p.x,
        y: axis === "y" ? p.y + dir * step : p.y,
        z: axis === "z" ? p.z + dir * step : p.z
      };
    });
  });

  $("me-go").addEventListener("click", () => {
    if (millMode !== "MANUAL" || millEmg) return;
    const x = parseFloat($("me-x").value) || toolGroup.position.x;
    const y = parseFloat($("me-y").value) || toolGroup.position.y;
    const z = parseFloat($("me-z").value) || toolGroup.position.z;
    millJogTarget = { x, y, z };
  });

  $("mbtn-spindle").addEventListener("click", () => {
    if (millEmg) return;
    millSpindleOn = !millSpindleOn;
    $("mspindle-icon").className = millSpindleOn ? "text-base animate-spin-slow" : "text-base";
    $("mspindle-label").textContent = millSpindleOn ? "SPINDLE ON" : "SPINDLE OFF";
    $("mbtn-spindle").className = `flex flex-col items-center gap-1 rounded py-2 text-[10px] font-bold ${millSpindleOn ? "bg-emerald-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  });

  $("mbtn-cycle").addEventListener("click", () => millStartCycle());
  $("mbtn-hold").addEventListener("click", () => { if (millRunning) millHolding = !millHolding; });

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

  const resetMillWp = () => {
    buildWorkpiece();
    millRunning = false; millAutoStep = 0; millAuto = null;
    millRemoved = 0;
    toolGroup.position.set(MW / 2, MTOP + 60, MD / 2);
  };
  $("mbtn-newp").addEventListener("click", resetMillWp);

  $("m-play").addEventListener("click", () => millStartCycle());
  $("m-pause").addEventListener("click", () => { if (millRunning) millHolding = !millHolding; });
  $("m-stop").addEventListener("click", () => { millRunning = false; millAuto = null; millAutoStep = 0; });
  $("m-new").addEventListener("click", resetMillWp);

  document.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => setMillCamera(btn.dataset.view));
  });

  $("m-wire").addEventListener("click", () => {
    if (wpMesh) wpMesh.material.wireframe = !wpMesh.material.wireframe;
  });

  buildMillKeypad($("mmdi"), [$("me-x"), $("me-y"), $("me-z")]);

  // ── LATHE ──

  const lmManual = $("mode-manual"), lmAuto = $("mode-auto");
  function setLatheMode(m) {
    lathe.mode = m;
    lmManual.className = `rounded py-2 text-[10px] font-bold ${m === "MANUAL" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
    lmAuto.className = `rounded py-2 text-[10px] font-bold ${m === "AUTO" ? "bg-cyan-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  }
  lmManual.addEventListener("click", () => setLatheMode("MANUAL"));
  lmAuto.addEventListener("click", () => setLatheMode("AUTO"));
  setLatheMode("MANUAL");

  $("rng-rpm").addEventListener("input", e => { lathe.spindleRpm = +e.target.value; $("lbl-rpm").textContent = `${lathe.spindleRpm} rpm`; });
  $("rng-feed").addEventListener("input", e => { lathe.feed = +e.target.value; $("lbl-feed").textContent = `${lathe.feed} mm/m`; });
  $("rng-ovr").addEventListener("input", e => { lathe.override = +e.target.value; $("lbl-ovr").textContent = `${Math.round(lathe.override * 100)}%`; });

  $("tool-minus").addEventListener("click", () => { lathe.toolNo = Math.max(1, lathe.toolNo - 1); $("lbl-tool").textContent = `T${String(lathe.toolNo).padStart(2, "0")}`; });
  $("tool-plus").addEventListener("click", () => { lathe.toolNo = Math.min(20, lathe.toolNo + 1); $("lbl-tool").textContent = `T${String(lathe.toolNo).padStart(2, "0")}`; });

  document.querySelectorAll(".jog").forEach(btn => {
    btn.addEventListener("click", () => {
      if (lathe.mode !== "MANUAL" || lathe.emergency) return;
      lathe.jogTarget = { x: lathe.toolX + (+btn.dataset.dx) * 5, z: lathe.toolZ + (+btn.dataset.dz) * 5 };
    });
  });

  $("btn-goto").addEventListener("click", () => {
    if (lathe.mode !== "MANUAL" || lathe.emergency) return;
    const x = parseFloat($("edit-x").value);
    const z = parseFloat($("edit-z").value);
    lathe.jogTarget = { x: isNaN(x) ? lathe.toolX : x, z: isNaN(z) ? lathe.toolZ : z };
  });

  $("btn-spindle").addEventListener("click", () => {
    if (lathe.emergency) return;
    lathe.spindleOn = !lathe.spindleOn;
    $("spindle-icon").className = lathe.spindleOn ? "text-base animate-spin-slow" : "text-base";
    $("spindle-label").textContent = lathe.spindleOn ? "SPINDLE ON" : "SPINDLE OFF";
    $("btn-spindle").className = `flex flex-col items-center gap-1 rounded py-2 text-[10px] font-bold ${lathe.spindleOn ? "bg-emerald-600 text-white" : "bg-zinc-700 hover:bg-zinc-600"}`;
  });

  $("btn-cycle").addEventListener("click", () => lathe.startCycle());
  $("btn-hold").addEventListener("click", () => { if (lathe.running) lathe.holding = !lathe.holding; });

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

  buildLatheKeypad($("mdi-rows"), $("mdi-fn"), [$("edit-x"), $("edit-z")]);

  // Mute
  const muteBtn = $("m-mute");
  if (muteBtn) {
    let muted = false;
    muteBtn.addEventListener("click", () => { muted = !muted; muteBtn.textContent = muted ? "🔇" : "🔊"; });
  }
}

// ─── CAM INTEGRATION ──────────────────────────────────────────────────────────

function checkCamData() {
  const raw = sessionStorage.getItem("rover_cnc_gcode");
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (!data.gcode) return;
    if (data.machineType === "torna") setTab("lathe");
    else setTab("mill");
  } catch {}
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

initMill();
setTab("mill");
wireEvents();
checkCamData();
requestAnimationFrame(loop);
