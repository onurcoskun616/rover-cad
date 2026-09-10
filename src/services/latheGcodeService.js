import {
  OPERATION_TYPES,
  isLatheOperation,
  latheThreadMinorDia,
  latheAxialExtent,
  THREAD_HEIGHT_FACTOR,
  LATHE_CHUCK_CLEARANCE_MM,
} from "./stockCamPlanService.js";
import { MATERIAL_CUTTING_DATA } from "./materialCuttingData.js";

// ---------------------------------------------------------------------------
// TORNA (turning) G-code generator — deliberately NOT a FreeCAD job.
//
// FreeCAD's CAM workbench has no official turning support (its lathe
// operations live in an experimental community addon), which is why
// camWizardService.js has long told operators to use the simulator's own
// lathe mode for turned parts. Rather than depend on an addon the operator's
// FreeCAD may not have, the Stock-CAM wizard's turning half generates its
// toolpaths here, in plain deterministic JavaScript, from the same confirmed
// operations list every milling flow already uses. Everything else about the
// wizard is unchanged: the same plan store, the same LLM parameter
// collection, the same history/edit/delete, the same cost + job-sheet + tool
// checklist, the same controller-dialect transform on the way out.
//
// AXIS CONVENTION (stated once, obeyed everywhere below):
//   X is RADIAL and programmed as a DIAMETER — X20 means 20mm diameter,
//     10mm off the spindle axis. Every internal computation here works in
//     RADIUS and converts exactly once, at the moment a line is emitted.
//   Z is AXIAL. Z0 is the RAW stock's right-hand (free) end face — the face
//     the operator physically touches off on. Material extends toward the
//     chuck in the NEGATIVE Z direction, so the chuck sits at Z = -len.
//   Operator-facing parameters (stockCamPlanService.js's lathe registry) are
//     POSITIVE DISTANCES from that end face; the negation happens here, in
//     one place, so a shop owner never has to think in negative numbers.
//
// The output is Fanuc-dialect turning G-code (G18/G97/G94, and G76 for
// threading) — the lingua franca every Fanuc-family control (Haas, Doosan,
// Mazak, Okuma, Mitsubishi) reads directly or with the existing dialect
// transformers' help.
// ---------------------------------------------------------------------------

// Representative carbide-insert TURNING data, one entry per material — the
// same material keys as materialCuttingData.js (and cnc-sim.html's MAT_DB),
// so a plan's own `material` field means the same thing on both machines.
// These are NOT the milling numbers: turning takes a single continuous cut
// with a much stiffer setup, so both the surface speed and the achievable
// depth of cut are considerably higher than an endmill's, and the feed is
// expressed per REVOLUTION (mm/rev, `fn`) rather than per tooth.
//
// Values are typical MIDPOINTS of widely-published general turning ranges
// for uncoated/coated carbide (e.g. steel ~150-250, aluminium ~400-700,
// titanium ~40-80 m/min) — a reasonable, conservative DEFAULT in exactly
// the same spirit as materialCuttingData.js's own milling table, never a
// substitute for the insert manufacturer's own chart for a specific grade.
//
// apRough/apFinish are RADIAL depths of cut (mm on the radius, i.e. half
// the diameter reduction per pass).
export const TURNING_CUTTING_DATA = {
  steel: { label: "Çelik", vc: 200, fnRough: 0.25, fnFinish: 0.10, apRough: 2.0, apFinish: 0.30 },
  aluminum: { label: "Alüminyum", vc: 500, fnRough: 0.30, fnFinish: 0.12, apRough: 2.5, apFinish: 0.30 },
  brass: { label: "Pirinç", vc: 300, fnRough: 0.25, fnFinish: 0.10, apRough: 2.0, apFinish: 0.25 },
  copper: { label: "Bakır", vc: 250, fnRough: 0.25, fnFinish: 0.10, apRough: 2.0, apFinish: 0.25 },
  "cast-iron": { label: "Dökme Demir", vc: 150, fnRough: 0.30, fnFinish: 0.12, apRough: 2.0, apFinish: 0.30 },
  titanium: { label: "Titanyum", vc: 60, fnRough: 0.20, fnFinish: 0.08, apRough: 1.0, apFinish: 0.20 },
  wood: { label: "Ahşap", vc: 600, fnRough: 0.35, fnFinish: 0.15, apRough: 3.0, apFinish: 0.50 },
  plastic: { label: "Plastik", vc: 400, fnRough: 0.30, fnFinish: 0.12, apRough: 2.5, apFinish: 0.40 },
  acrylic: { label: "Akrilik", vc: 300, fnRough: 0.20, fnFinish: 0.08, apRough: 1.5, apFinish: 0.30 },
};

export function turningCuttingData(materialKey) {
  return TURNING_CUTTING_DATA[materialKey] || TURNING_CUTTING_DATA.steel;
}

// Conservative machine envelope defaults. A real shop's numbers differ, but
// these only ever CLAMP a computed value (never raise it), so the worst case
// is a program that cuts a little slower than the material could take.
const SPINDLE_MAX_RPM = 3000;
const SPINDLE_MIN_RPM = 60;
const RAPID_MM_MIN = 8000;      // typical CNC lathe rapid traverse
const TOOL_CHANGE_SEC = 6;      // turret index + settle
const FEED_MIN = 5, FEED_MAX = 3000; // mm/min guard rails

const round3 = (n) => Math.round(n * 1000) / 1000;

// Constant-RPM (G97) is used throughout rather than constant-surface-speed
// (G96): it is supported by every control without exception, it is what
// threading REQUIRES anyway (a G96 thread is scrap), and it keeps the
// mm/min feed words honest. To keep the surface speed near the material's
// recommended Vc regardless, a fresh S word is emitted before EVERY pass,
// computed at that pass's own largest cutting diameter — so a bar being
// turned down speeds up as it gets smaller, which is the whole point of
// G96, achieved deterministically.
export function rpmForDiameter(vc, diaMm) {
  const dia = Math.max(0.5, Number(diaMm) || 0.5);
  const raw = (Number(vc) * 1000) / (Math.PI * dia);
  return Math.min(SPINDLE_MAX_RPM, Math.max(SPINDLE_MIN_RPM, Math.round(raw)));
}

// mm/rev -> mm/min at a given spindle speed. Turning feeds are quoted per
// revolution; the program emits G94 (mm/min) so the numbers stay meaningful
// to the simulator and to any control regardless of its G95 support.
export function feedMmPerMin(fnMmPerRev, rpm) {
  return Math.min(FEED_MAX, Math.max(FEED_MIN, Math.round(Number(fnMmPerRev) * Number(rpm))));
}

// ---------------------------------------------------------------------------
// Tooling. A lathe turret holds shaped inserts, not diameter-defined cutters,
// so "which tool" is a KIND plus (for the two kinds where size matters) a
// size — never a diameter the way a milling tool is.
// ---------------------------------------------------------------------------

const GROOVE_INSERT_MAX_W = 3; // mm — a common general-purpose grooving insert

export function latheToolFor(op) {
  const p = op.params || {};
  if (op.type === "latheFace") {
    return { kind: "Alın/Dış Tornalama Kalemi", signature: "lathe:turning", label: "Dış tornalama kalemi (80° elmas, alın+boyuna)" };
  }
  if (op.type === "latheTurn" || op.type === "latheTaper") {
    return { kind: "Alın/Dış Tornalama Kalemi", signature: "lathe:turning", label: "Dış tornalama kalemi (80° elmas, alın+boyuna)" };
  }
  if (op.type === "latheGroove") {
    const w = Math.min(Number(p.width) || GROOVE_INSERT_MAX_W, GROOVE_INSERT_MAX_W);
    const width = Math.round(w * 100) / 100;
    return { kind: "Kanal Kalemi", width, signature: `lathe:groove:${width}`, label: `Kanal kalemi (${width}mm uç genişliği)` };
  }
  if (op.type === "latheDrill") {
    const dia = Math.round((Number(p.dia) || 0) * 100) / 100;
    return { kind: "Matkap", dia, signature: `lathe:drill:${dia}`, label: `Ø${dia}mm matkap (punta/eksen delme)` };
  }
  if (op.type === "latheThread") {
    return { kind: "Diş Kalemi", signature: "lathe:thread", label: "Diş açma kalemi (60° metrik, dış vida)" };
  }
  return { kind: "Bilinmeyen", signature: `lathe:${op.type}`, label: op.type };
}

// The order a real turner runs these in, and WHY — this is the "talaşlı
// imalat mühendisi" knowledge the wizard is supposed to carry, not an
// arbitrary sort key:
//   1 face    — establish a true, square Z datum before anything measures from it.
//   2 drill   — bore on the centreline while the bar is still full diameter
//               and maximally rigid, and while the end face is freshly flat
//               so the drill can't walk.
//   3 turn/taper — bring the outside diameters to size.
//   4 groove  — cut relief/run-out grooves into surfaces that are already
//               at their final diameter.
//   5 thread  — always last on a given diameter: the crest is formed from the
//               finished OD, and a later turning pass would shave the thread off.
export const LATHE_OP_ORDER_RANK = Object.freeze({
  latheFace: 1,
  latheDrill: 2,
  latheTurn: 3,
  latheTaper: 3,
  latheGroove: 4,
  latheThread: 5,
});

// Stable sort by that rank: operations of equal rank keep the exact order
// the operator confirmed them in (their relative sequence is the operator's
// own call — two turning steps have a real dependency this function can't
// see), only genuinely mis-ordered STAGES get moved.
export function suggestLatheOrder(operations) {
  return operations
    .map((op, i) => ({ op, i, rank: LATHE_OP_ORDER_RANK[op.type] ?? 99 }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((e) => e.op);
}

export function buildLatheToolChecklist(operations) {
  const order = [];
  const groups = new Map();
  for (const op of operations) {
    const tool = latheToolFor(op);
    if (!groups.has(tool.signature)) {
      groups.set(tool.signature, {
        kind: tool.kind,
        label: tool.label,
        dia: tool.dia ?? null,
        width: tool.width ?? null,
        pitch: op.type === "latheThread" ? Number(op.params.pitch) : null,
        toolNum: null,
        opCount: 0,
      });
      order.push(tool.signature);
    }
    const g = groups.get(tool.signature);
    g.opCount++;
    const toolNum = Number(op.params?.toolNum);
    if (g.toolNum === null && Number.isFinite(toolNum)) g.toolNum = toolNum;
  }
  return order.map((sig) => groups.get(sig));
}

export function countLatheToolChanges(operations) {
  let changes = 0, last = null;
  for (const op of operations) {
    const sig = latheToolFor(op).signature;
    if (last !== null && sig !== last) changes++;
    last = sig;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Workpiece model: a radius-per-Z-slice profile plus, separately, the bore
// radius drilled on the centreline. This is the same simplification the
// simulator itself uses (cnc-sim.html's LatheSim keeps a Float32Array of
// radii), so a program that verifies clean here behaves the same on screen.
//
// It exists for two jobs at once: while the program is being BUILT it tells
// each operation how much material is actually left where it is about to cut
// (so a second turning pass over an already-turned diameter doesn't emit a
// stack of air-cutting passes), and while the program is being CHECKED a
// fresh instance is replayed against the finished move list to prove no
// rapid ever crosses solid metal.
// ---------------------------------------------------------------------------

const SLICE_MM = 0.5;

export class StockProfile {
  constructor(stockDia, stockLen) {
    this.len = Number(stockLen);
    this.n = Math.max(2, Math.ceil(this.len / SLICE_MM) + 1);
    this.r = new Float64Array(this.n).fill(Number(stockDia) / 2);
    this.bore = new Float64Array(this.n); // 0 = solid on the centreline
    this.faceZ = 0;                       // current end face (0 = raw stock face)
  }
  _idx(z) { return Math.min(this.n - 1, Math.max(0, Math.round(-z / SLICE_MM))); }
  radiusAt(z) {
    if (z > this.faceZ + 1e-9) return 0; // past the end face — nothing there
    if (z < -this.len) return 0;
    return this.r[this._idx(z)];
  }
  boreAt(z) {
    if (z > this.faceZ + 1e-9 || z < -this.len) return 0;
    return this.bore[this._idx(z)];
  }
  // Largest remaining radius anywhere in an axial span — what an operation
  // about to cut that span is really starting from.
  maxRadiusIn(zLow, zHigh) {
    const lo = Math.min(zLow, zHigh), hi = Math.max(zLow, zHigh);
    let max = 0;
    for (let z = lo; z <= hi + 1e-9; z += SLICE_MM) max = Math.max(max, this.radiusAt(Math.min(hi, z)));
    return Math.max(max, this.radiusAt(hi));
  }
  // A cutting move sweeps from (r1,z1) to (r2,z2); `widthMm` extends the cut
  // in the -Z direction by the tool's own width (a grooving insert removes a
  // slot as wide as its cutting edge, not a zero-width line).
  cut(r1, z1, r2, z2, widthMm = 0) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(z2 - z1), Math.abs(r2 - r1)) / SLICE_MM));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const z = z1 + (z2 - z1) * t;
      const r = Math.max(0, r1 + (r2 - r1) * t);
      for (let w = 0; w <= widthMm + 1e-9; w += SLICE_MM) {
        const zz = z - Math.min(w, widthMm);
        if (zz > this.faceZ || zz < -this.len) continue;
        const i = this._idx(zz);
        if (this.r[i] > r) this.r[i] = r;
        if (widthMm <= 0) break;
      }
    }
  }
  // Facing removes EVERYTHING to the right of the cut plane, which a
  // radius-per-slice profile can't express as a sweep — so it's applied as
  // its own explicit operation on the model.
  faceOff(zCut) {
    if (zCut >= this.faceZ) return;
    for (let i = 0; i < this.n; i++) {
      const z = -i * SLICE_MM;
      if (z > zCut) { this.r[i] = 0; this.bore[i] = 0; }
    }
    this.faceZ = zCut;
  }
  drill(dia, zFrom, zTo) {
    const r = Number(dia) / 2;
    const lo = Math.min(zFrom, zTo), hi = Math.max(zFrom, zTo);
    for (let z = lo; z <= hi + 1e-9; z += SLICE_MM) {
      if (z > this.faceZ || z < -this.len) continue;
      const i = this._idx(z);
      if (this.bore[i] < r) this.bore[i] = r;
    }
  }
  // Is a tool tip at (r, z) buried in solid metal? Inside an already-drilled
  // bore is NOT solid — that's the whole reason `bore` is tracked separately.
  isInMaterial(r, z, tol) {
    return r < this.radiusAt(z) - tol && r >= this.boreAt(z) - tol;
  }
}

// ---------------------------------------------------------------------------
// Program builder. Collects BOTH the emitted text and a structured move list:
// the text is what the machine runs, the move list is what the safety checker
// and the time estimate read — so those two can never disagree with the
// program the way two independently-written models would.
// ---------------------------------------------------------------------------

const Z_FACE_CLEAR = 2;   // mm of air beyond the current end face (Z+)
const X_CLEAR_EXTRA = 6;  // mm added to the stock DIAMETER for a fully-clear X

class LatheProgram {
  constructor(stock) {
    this.stockDia = Number(stock.dia);
    this.stockR = this.stockDia / 2;
    this.stockLen = Number(stock.len);
    this.xClearDia = this.stockDia + X_CLEAR_EXTRA;
    this.lines = [];
    this.moves = [];
    this.cur = { xDia: null, z: null };
    this.lastFeed = null;
    this.lastRpm = null;
    this.toolChanges = 0;
    this.profile = new StockProfile(this.stockDia, this.stockLen);
  }

  get faceZ() { return this.profile.faceZ; }

  comment(text) { this.lines.push(`(${text})`); return this; }
  raw(line) { this.lines.push(line); return this; }

  // `xDia` is always a DIAMETER (see the axis-convention note at the top).
  _move(kind, xDia, z, feed, extra) {
    const gWord = kind === "rapid" ? "G0" : "G1";
    const sameX = this.cur.xDia !== null && Math.abs(xDia - this.cur.xDia) <= 1e-6;
    const sameZ = this.cur.z !== null && Math.abs(z - this.cur.z) <= 1e-6;
    // A move that changes neither axis is dropped rather than emitted as a
    // bare G-word, which some controls read as "repeat the previous motion".
    if (sameX && sameZ) return this;
    let line = gWord;
    if (!sameX) line += ` X${round3(xDia).toFixed(3)}`;
    if (!sameZ) line += ` Z${round3(z).toFixed(3)}`;
    if (kind === "feed" && feed && (this.lastFeed === null || feed !== this.lastFeed)) {
      line += ` F${round3(feed).toFixed(3)}`;
      this.lastFeed = feed;
    }
    this.lines.push(line);
    const rec = { type: kind, x: xDia, z, feed: kind === "feed" ? (feed || this.lastFeed) : null, ...(extra || {}) };
    this.moves.push(rec);
    if (kind === "feed" && this.cur.xDia !== null) {
      // A drilling move runs INSIDE the part on the centreline: it opens a
      // bore, it does not shave the outside diameter down to nothing. Feeding
      // it through the outer-profile model (as any other cut) would wipe the
      // whole drilled length to Ø0 and make every later operation believe
      // there was no material left to cut.
      if (rec.boreDia) this.profile.drill(rec.boreDia, this.cur.z, z);
      else this.profile.cut(this.cur.xDia / 2, this.cur.z, xDia / 2, z, rec.widthMm || 0);
    }
    this.cur = { xDia, z };
    if (rec.faceCut) this.profile.faceOff(z);
    return this;
  }

  rapid(xDia, z) { return this._move("rapid", xDia, z, null, null); }
  feed(xDia, z, f, extra) { return this._move("feed", xDia, z, f, extra); }

  // Records a threading cycle's cutting time without emitting motion words —
  // a G76 block's parameter words are nothing like a linear move's.
  recordThreadPasses(lengthMm, passes, threadFeedMmMin) {
    this.moves.push({ type: "thread", lengthMm: Math.abs(lengthMm) * passes, feed: threadFeedMmMin });
  }

  toolChange(toolNum, label) {
    this.toolChanges++;
    // Turning tool words carry the offset register too: T0101 = turret 1,
    // wear/geometry offset 1 — the universal Fanuc-family convention.
    this.raw(`T${String(toolNum).padStart(2, "0")}${String(toolNum).padStart(2, "0")} (${label})`);
    this.lastFeed = null; // a turret index invalidates the control's modal feed
    this.lastRpm = null;
    return this;
  }

  spindle(rpm) {
    if (this.lastRpm === rpm) return this;
    this.raw(`G97 S${rpm} M3`);
    this.lastRpm = rpm;
    return this;
  }

  // Park fully clear in BOTH axes, X first. Every operation starts and ends
  // here, so none of them ever inherits wherever the previous one stopped.
  parkClear() {
    if (this.cur.xDia !== null && Math.abs(this.cur.xDia - this.xClearDia) > 1e-6) this.rapid(this.xClearDia, this.cur.z);
    else if (this.cur.xDia === null) this.rapid(this.xClearDia, this.faceZ + Z_FACE_CLEAR + 3);
    this.rapid(this.xClearDia, this.faceZ + Z_FACE_CLEAR + 3);
    return this;
  }

  // Safe approach to a given axial position: travel in Z at the fully-clear
  // diameter, THEN come in radially. Both legs are provably outside the
  // workpiece envelope, so no operation has to reason about what the
  // operations before it left behind.
  approach(z) {
    this.rapid(this.xClearDia, this.cur.z === null ? this.faceZ + Z_FACE_CLEAR + 3 : this.cur.z);
    this.rapid(this.xClearDia, z);
    return this;
  }
}

// Replays a generated move list against a FRESH workpiece model. Returns
// operator-facing Turkish problem strings; empty means the program never
// rapids into metal and never reaches past the end of the bar.
export function checkLatheMoves(moves, stock) {
  const problems = [];
  const profile = new StockProfile(Number(stock.dia), Number(stock.len));
  const len = Number(stock.len);
  let cur = null;
  for (const m of moves) {
    if (m.type === "thread") continue; // no linear geometry of its own
    const r = m.x / 2;
    if (m.z < -len - 1e-6) {
      problems.push(
        `Program stok boyunun ötesine gidiyor (Z${round3(m.z)}, stok boyu ${len}mm) — ayna/punta çarpışma riski.`,
      );
      break;
    }
    if (r < -1e-6 && m.type === "rapid") {
      problems.push(`Hızlı hareket eksen merkezinin ötesine geçiyor (X${round3(m.x)}).`);
      break;
    }
    if (cur) {
      if (m.type === "rapid") {
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(m.z - cur.z), Math.abs(r - cur.r)) / SLICE_MM));
        let hit = null;
        for (let s = 0; s <= steps && !hit; s++) {
          const t = s / steps;
          const z = cur.z + (m.z - cur.z) * t;
          const rr = cur.r + (r - cur.r) * t;
          if (profile.isInMaterial(rr, z, 0.05)) hit = { z, r: rr };
        }
        if (hit) {
          problems.push(
            `Hızlı hareket (G0) malzemenin içinden geçiyor: Z${round3(hit.z)} konumunda takım Ø${round3(hit.r * 2)}, ` +
            `orada malzeme Ø${round3(profile.radiusAt(hit.z) * 2)}.`,
          );
          break;
        }
      } else if (m.boreDia) {
        profile.drill(m.boreDia, cur.z, m.z); // see LatheProgram._move's own note
      } else {
        profile.cut(cur.r, cur.z, r, m.z, m.widthMm || 0);
      }
    }
    if (m.faceCut) profile.faceOff(m.z);
    cur = { r, z: m.z };
  }
  return problems;
}

// Cycle-time estimate from the very move list the program emits: cutting
// moves at their own feed, rapids at the machine's traverse rate, plus a
// fixed turret-index allowance per tool change. Same role FreeCAD's
// EST_MINUTES plays for milling plans, so cost + job sheet read identically.
export function estimateLatheMinutes(moves, toolChanges) {
  let minutes = 0;
  let cur = null;
  for (const m of moves) {
    if (m.type === "thread") {
      minutes += m.lengthMm / Math.max(1, m.feed);
      continue;
    }
    const r = m.x / 2;
    if (cur) {
      const dist = Math.hypot(r - cur.r, m.z - cur.z);
      minutes += dist / (m.type === "rapid" ? RAPID_MM_MIN : Math.max(1, m.feed));
    }
    cur = { r, z: m.z };
  }
  return Math.round((minutes + (toolChanges * TOOL_CHANGE_SEC) / 60) * 100) / 100;
}

// ---------------------------------------------------------------------------
// The operations themselves.
//
// Every one follows the same production discipline:
//   * ROUGH then FINISH. Roughing runs at the material's roughing feed and
//     stops a finish allowance short; a single finishing pass at the finish
//     feed and a fresh spindle speed takes it to size. That separation is
//     what actually produces a to-size, decent-surface part rather than one
//     hogging pass that leaves the tool pressure baked into the diameter.
//   * A fresh S word per pass, computed at that pass's own cutting diameter
//     (see rpmForDiameter) — constant-RPM programming that still tracks the
//     material's recommended surface speed.
//   * Every rapid either travels at the fully-clear diameter or moves
//     radially outward through metal the same pass just removed. The
//     StockProfile replay in checkLatheMoves proves this rather than trusting
//     it.
//   * Axial distances the operator gave are measured from the CURRENT end
//     face (prog.faceZ), not from the raw stock's face: once a facing
//     operation has taken 2mm off, "alından 20mm" means 20mm from the face
//     that now exists, which is what the operator means and what they will
//     measure with a caliper.
// ---------------------------------------------------------------------------

function coolantFor(materialKey) {
  const c = MATERIAL_CUTTING_DATA[materialKey]?.coolant;
  const dry = /kuru/i.test(c?.type || "");
  return { on: dry ? null : "M8", off: "M9", note: c?.type || null, dry };
}

function opFace(prog, p, ctx) {
  const d = ctx.data;
  const depth = Number(p.depth);
  const zTop = prog.faceZ;
  const xStart = prog.stockDia + 2;
  const finishAllow = Math.min(d.apFinish, depth * 0.5);
  const roughTo = Math.max(0, depth - finishAllow);

  const passes = [];
  let cut = 0;
  while (cut < roughTo - 1e-6) {
    cut = Math.min(roughTo, cut + d.apRough);
    passes.push({ depth: cut, finish: false });
  }
  passes.push({ depth, finish: true });

  // Facing sweeps from the OD to the centre, so the surface speed at the OD
  // is the limit — one speed for the whole operation, computed there.
  const rpm = rpmForDiameter(d.vc, prog.stockDia);
  prog.spindle(rpm);
  prog.approach(zTop + Z_FACE_CLEAR);

  for (const pass of passes) {
    const zc = zTop - pass.depth;
    const f = feedMmPerMin(pass.finish ? d.fnFinish : d.fnRough, rpm);
    prog.rapid(xStart, zc);
    // The finishing pass runs a whisker past centre so no pip is left
    // standing on the axis; roughing stops at the centre.
    prog.feed(pass.finish ? -0.8 : 0, zc, f, pass.finish ? { faceCut: true } : null);
    prog.rapid(xStart, zc); // retract radially through the air this pass just made
  }
  return { label: `Alın Tornalama: ${depth}mm (${passes.length - 1} kaba + 1 ince paso)` };
}

function opTurn(prog, p, ctx) {
  const d = ctx.data;
  const targetR = Number(p.targetDia) / 2;
  const startZ = Number(p.startZ) || 0;
  const length = Number(p.length);
  const zStart = prog.faceZ - startZ;
  const zEnd = prog.faceZ - (startZ + length);
  const fromFace = startZ <= 0.05;

  const startR = prog.profile.maxRadiusIn(zEnd, zStart);
  if (startR <= targetR + 1e-6) {
    ctx.warnings.push(
      `Çap Düşürme (Ø${p.targetDia}): bu bölge zaten Ø${round3(startR * 2)} veya daha küçük — talaş kalmadığı için atlandı.`,
    );
    return { label: `Çap Düşürme: Ø${p.targetDia} (atlandı, talaş yok)`, skipped: true };
  }

  const finishAllow = Math.min(d.apFinish, (startR - targetR) * 0.5);
  const roughTo = targetR + finishAllow;
  const passes = [];
  let r = startR;
  while (r > roughTo + 1e-6) {
    r = Math.max(roughTo, r - d.apRough);
    passes.push({ r, finish: false });
  }
  passes.push({ r: targetR, finish: true });

  prog.approach(fromFace ? prog.faceZ + Z_FACE_CLEAR : zStart);
  let rPrev = startR;
  for (const pass of passes) {
    const rpm = rpmForDiameter(d.vc, pass.r * 2);
    const f = feedMmPerMin(pass.finish ? d.fnFinish : d.fnRough, rpm);
    prog.spindle(rpm);
    if (fromFace) {
      // Enter from beyond the end face: pure air, no entry burr, no shock.
      prog.rapid(pass.r * 2, prog.faceZ + Z_FACE_CLEAR);
      prog.feed(pass.r * 2, zEnd, f);
    } else {
      // A step partway along the bar has no free end to enter from, so the
      // pass starts with a radial plunge at its shoulder, fed (never rapid)
      // and at the gentler finishing feed since the whole nose is engaged.
      prog.rapid(rPrev * 2 + 4, zStart);
      prog.feed(pass.r * 2, zStart, feedMmPerMin(d.fnFinish, rpm));
      prog.feed(pass.r * 2, zEnd, f);
    }
    prog.rapid(pass.r * 2 + 4, zEnd);
    prog.rapid(pass.r * 2 + 4, fromFace ? prog.faceZ + Z_FACE_CLEAR : zStart);
    rPrev = pass.r;
  }
  return { label: `Çap Düşürme: Ø${round3(startR * 2)} → Ø${p.targetDia}, boy ${length}mm (${passes.length - 1} kaba + 1 ince paso)` };
}

function opTaper(prog, p, ctx) {
  const d = ctx.data;
  const rA0 = Number(p.startDia) / 2;
  const rB0 = Number(p.endDia) / 2;
  const startZ = Number(p.startZ) || 0;
  const length = Number(p.length);
  const zStart = prog.faceZ - startZ;
  const zEnd = prog.faceZ - (startZ + length);
  const fromFace = startZ <= 0.05;

  const startR = prog.profile.maxRadiusIn(zEnd, zStart);
  const minTarget = Math.min(rA0, rB0);
  if (startR <= minTarget + 1e-6) {
    ctx.warnings.push(`Konik Tornalama: bu bölgede kaldırılacak talaş kalmamış — atlandı.`);
    return { label: "Konik Tornalama (atlandı, talaş yok)", skipped: true };
  }
  const finishAllow = Math.min(d.apFinish, (startR - minTarget) * 0.5);
  const nRough = Math.max(0, Math.ceil((startR - minTarget - finishAllow) / d.apRough));

  // Roughing a cone = the same cone offset progressively outward, each pass
  // clipped to whatever raw diameter still exists (so the early passes just
  // graze air where the cone is already below the stock).
  const passes = [];
  for (let i = 1; i <= nRough; i++) {
    const offset = finishAllow + (nRough - i) * d.apRough;
    passes.push({ rA: Math.min(startR, rA0 + offset), rB: Math.min(startR, rB0 + offset), finish: false });
  }
  passes.push({ rA: rA0, rB: rB0, finish: true });

  prog.approach(fromFace ? prog.faceZ + Z_FACE_CLEAR : zStart);
  let rPrevMax = startR;
  for (const pass of passes) {
    const big = Math.max(pass.rA, pass.rB);
    const rpm = rpmForDiameter(d.vc, big * 2);
    const f = feedMmPerMin(pass.finish ? d.fnFinish : d.fnRough, rpm);
    prog.spindle(rpm);
    if (fromFace) {
      prog.rapid(pass.rA * 2, prog.faceZ + Z_FACE_CLEAR);
      prog.feed(pass.rA * 2, zStart, f);       // air, down to the cone's big end
    } else {
      prog.rapid(rPrevMax * 2 + 4, zStart);
      prog.feed(pass.rA * 2, zStart, feedMmPerMin(d.fnFinish, rpm));
    }
    prog.feed(pass.rB * 2, zEnd, f);           // the cone itself, one straight move
    prog.rapid(big * 2 + 4, zEnd);
    prog.rapid(big * 2 + 4, fromFace ? prog.faceZ + Z_FACE_CLEAR : zStart);
    rPrevMax = big;
  }
  return { label: `Konik Tornalama: Ø${p.startDia} → Ø${p.endDia}, boy ${length}mm (${passes.length - 1} kaba + 1 ince paso)` };
}

function opGroove(prog, p, ctx) {
  const d = ctx.data;
  const width = Number(p.width);
  const depth = Number(p.depth);
  const posZ = Number(p.posZ) || 0;
  const zNear = prog.faceZ - posZ;
  const zFar = prog.faceZ - (posZ + width);
  const insertW = Math.min(width, GROOVE_INSERT_MAX_W);

  const surfaceR = prog.profile.maxRadiusIn(zFar, zNear);
  const targetR = surfaceR - depth;
  if (targetR < 0.5) {
    ctx.problems.push(
      `Kanal derinliği (${depth}mm) bu bölgedeki gerçek çapa (Ø${round3(surfaceR * 2)}) göre çok fazla — ` +
      `kanal dibinde ${round3(targetR * 2)}mm çap kalıyor.`,
    );
    return { label: "Kanal Açma (geçersiz)", skipped: true };
  }

  // A grooving insert cuts on its full width, so a groove wider than the
  // insert is made from several overlapping plunges (75% step-over leaves no
  // uncut ridge) plus a finishing sweep along the floor.
  const positions = [];
  let zp = zNear;
  while (zp - insertW > zFar + 1e-6) {
    positions.push(zp);
    zp -= insertW * 0.75;
  }
  positions.push(zFar + insertW);

  const rpm = rpmForDiameter(d.vc * 0.7, surfaceR * 2); // grooving runs slower than turning
  const fPlunge = feedMmPerMin(d.fnFinish, rpm);        // a plunging insert is fully engaged
  const clearDia = surfaceR * 2 + 3;
  const peckStep = Math.min(2, depth);

  prog.spindle(rpm);
  for (const pos of positions) {
    prog.approach(pos);
    prog.rapid(clearDia, pos);
    let r = surfaceR;
    while (r > targetR + 1e-6) {
      const rNext = Math.max(targetR, r - peckStep);
      if (r < surfaceR - 1e-6) prog.rapid((r + 0.5) * 2, pos); // back down to just above the floor
      prog.feed(rNext * 2, pos, fPlunge, { widthMm: insertW });
      prog.rapid(clearDia, pos); // full radial retract clears the chip
      r = rNext;
    }
  }
  if (width > insertW + 1e-6) {
    // Clean the floor in one continuous pass so it isn't left as a row of
    // plunge scallops.
    const fFinish = feedMmPerMin(d.fnFinish * 0.8, rpm);
    prog.approach(zNear);
    prog.rapid(clearDia, zNear);
    prog.feed(targetR * 2, zNear, fFinish, { widthMm: insertW });
    prog.feed(targetR * 2, zFar + insertW, fFinish, { widthMm: insertW });
    prog.rapid(clearDia, zFar + insertW);
  }
  return {
    label: `Kanal Açma: ${width}mm genişlik, ${depth}mm derinlik (Ø${round3(targetR * 2)} dip), ${positions.length} dalma`,
  };
}

function opDrill(prog, p, ctx) {
  const d = ctx.data;
  const dia = Number(p.dia);
  const depth = Number(p.depth);
  const zTop = prog.faceZ;

  // A twist drill's speed comes from ITS diameter, not the workpiece's, and
  // its feed is quoted per revolution as a fraction of that diameter —
  // ~0.02·D is the standard general-purpose starting point.
  // A drill is far less rigid and far worse at shedding heat than a turning
  // insert, and plenty of shops still put HSS drills in the tailstock, so
  // drilling runs at a fraction of the material's turning speed and is
  // additionally capped outright.
  const rpm = Math.min(1800, rpmForDiameter(d.vc * 0.3, dia));
  const fn = Math.min(0.30, Math.max(0.03, 0.015 * dia));
  const f = feedMmPerMin(fn, rpm);
  // Peck drilling with a full retract each time: on a lathe the hole is
  // horizontal, so chips do not fall out on their own and a long drill packs
  // and snaps without it.
  const peck = Math.min(3 * dia, 20);

  if (depth / dia > 5) {
    ctx.warnings.push(
      `Ø${dia}mm matkapla ${depth}mm derinlik (${round3(depth / dia)}×D) — derin delik. Program gagalamalı (peck) ` +
      `üretildi; yine de bol soğutma ve gerekiyorsa ön delme önerilir.`,
    );
  }

  prog.spindle(rpm);
  prog.approach(zTop + Z_FACE_CLEAR + 1);
  prog.rapid(0, zTop + Z_FACE_CLEAR + 1);
  prog.rapid(0, zTop + 1);
  let cut = 0;
  while (cut < depth - 1e-6) {
    const next = Math.min(depth, cut + peck);
    prog.feed(0, zTop - next, f, { boreDia: dia });
    prog.rapid(0, zTop + 1);
    if (next < depth - 1e-6) prog.rapid(0, zTop - (next - 1));
    cut = next;
  }
  prog.rapid(0, zTop + Z_FACE_CLEAR + 1);
  prog.rapid(prog.xClearDia, zTop + Z_FACE_CLEAR + 1);
  return { label: `Eksenden Delme: Ø${dia}mm × ${depth}mm derinlik (gagalama ${round3(peck)}mm)` };
}

// Number of infeed passes a constant-CHIP-AREA thread schedule needs to
// reach full depth from a given first-pass depth: successive depths follow
// h·√(i/n), so the passes remove equal chip area rather than an ever-
// increasing one. Plus a spring pass at final depth.
export function threadPassCount(threadHeight, firstCut) {
  return Math.max(2, Math.ceil((threadHeight / firstCut) ** 2) + 1);
}

function opThread(prog, p, ctx) {
  const major = Number(p.majorDia);
  const pitch = Number(p.pitch);
  const startZ = Number(p.startZ) || 0;
  const length = Number(p.length);
  const zStart = prog.faceZ - startZ;
  const zEnd = prog.faceZ - (startZ + length);

  const h = THREAD_HEIGHT_FACTOR * pitch;            // radial thread height
  const minorDia = latheThreadMinorDia(major, pitch);
  const surfaceDia = prog.profile.maxRadiusIn(zEnd, zStart) * 2;
  if (Math.abs(surfaceDia - major) > 0.35) {
    ctx.warnings.push(
      `Diş açılacak bölgenin çapı şu an Ø${round3(surfaceDia)}, diş dış çapı ise Ø${major} — ` +
      `dişin tepesi doğru çıkmaz. Bu bölgeyi önce Ø${major}mm'ye tornalayın (Çap Düşürme işlemi), sonra diş açın.`,
    );
  }

  // Threading MUST run at constant RPM (G97): a G96 thread changes lead as
  // the speed changes and comes out scrap. It also runs well below turning
  // speed — the tool cannot be lifted mid-thread, so the control needs time
  // to decelerate at the run-out.
  const rpm = Math.min(1000, Math.max(100, rpmForDiameter(ctx.data.vc * 0.5, major)));
  const threadFeed = pitch * rpm; // mm/min equivalent of one lead per rev
  const firstCut = Math.min(0.5, Math.max(0.1, h / Math.sqrt(6)));
  const passes = threadPassCount(h, firstCut);
  // Run-in: the tool has to be up to a synchronised speed before it reaches
  // the first full thread, and it needs somewhere to pull out.
  const zApproach = zStart + Math.max(2 * pitch, 2);
  const xApproach = major + 4;

  prog.approach(zApproach);
  prog.rapid(xApproach, zApproach);
  prog.spindle(rpm);

  const hMicrons = Math.round(h * 1000);
  const qMicrons = Math.round(firstCut * 1000);
  // Fanuc's two-block G76: the first block is the cycle's own parameters
  // (P = 01 finishing pass, 10 = 1.0×pitch pull-out chamfer, 60 = tool
  // included angle; Q = minimum infeed in microns; R = finish allowance mm),
  // the second is the thread's geometry (X = minor/root diameter, Z = the
  // end of the thread, P = thread height in microns, Q = first infeed in
  // microns, F = pitch = lead).
  const cycleLines = [
    "G76 P011060 Q50 R0.05",
    `G76 X${round3(minorDia).toFixed(3)} Z${round3(zEnd).toFixed(3)} P${hMicrons} Q${qMicrons} F${round3(pitch).toFixed(3)}`,
  ];

  if (ctx.threadingSupported) {
    prog.comment(`M${major} x ${pitch} DIS VIDA - dis yuksekligi ${round3(h)}mm, dis dibi Ø${round3(minorDia)}`);
    cycleLines.forEach((l) => prog.raw(l));
    prog.recordThreadPasses(length + 2 * pitch, passes, threadFeed);
  } else {
    prog.comment(`!!! BU KONTROLCU DIS CEKME CEVRIMI DESTEKLEMIYOR - ASAGIDAKI BLOK DEVRE DISI !!!`);
    cycleLines.forEach((l) => prog.comment(l));
    ctx.problems.push(
      `Seçili kontrolcü torna diş çekme çevrimini (G76) desteklemiyor — diş açma işlemi G-code'a ` +
      `yorum satırı olarak yazıldı, ÇALIŞTIRILMAZ. Diş açma çevrimi olan bir kontrolcü seçin.`,
    );
  }

  // The equal-chip-area G92 schedule, written as comments: a control without
  // G76 can run the thread by uncommenting these, and a shop that prefers
  // G92 can see exactly what depths the G76 above is going to take.
  prog.comment(`G92 ALTERNATIFI (kontrolcunuzde G76 yoksa asagidaki ${passes} pasoyu kullanin):`);
  for (let i = 1; i <= passes - 1; i++) {
    const depth = h * Math.sqrt(i / (passes - 1));
    prog.comment(`G92 X${round3(major - 2 * depth).toFixed(3)} Z${round3(zEnd).toFixed(3)} F${round3(pitch).toFixed(3)}`);
  }
  prog.comment(`G92 X${round3(minorDia).toFixed(3)} Z${round3(zEnd).toFixed(3)} F${round3(pitch).toFixed(3)} (perdah/yaylanma pasosu)`);

  prog.rapid(prog.xClearDia, zApproach);
  return {
    label: `Diş Açma: M${major} × ${pitch}, boy ${length}mm — diş dibi Ø${round3(minorDia)}, ${passes} paso`,
  };
}

const OP_BUILDERS = {
  latheFace: opFace,
  latheTurn: opTurn,
  latheTaper: opTaper,
  latheGroove: opGroove,
  latheDrill: opDrill,
  latheThread: opThread,
};

export function isLatheGenerationSupported(type) {
  return Object.prototype.hasOwnProperty.call(OP_BUILDERS, type);
}

// ---------------------------------------------------------------------------
// Controller support. Turning cycles are far less portable than milling
// motion, so what a given control can actually run is stated explicitly here
// rather than assumed.
// ---------------------------------------------------------------------------

const FANUC_TURNING_FAMILY = /fanuc|haas|doosan|mazak|mazatrol|okuma|osp|mitsubishi|meldas|linuxcnc|mach/;

export function latheControllerSupport(postName) {
  const p = String(postName || "").toLowerCase().trim();
  if (!p || p.includes("grbl")) {
    return {
      threading: false,
      // Bu uyarının konusu tamamen diş çekmedir: diş içermeyen bir torna
      // programı GRBL'de sorunsuz çalışır, o yüzden uyarı sadece planda
      // gerçekten bir diş işlemi varken gösterilir.
      threadWarningOnly: true,
      warning:
        "GRBL bir freze/router kontrolcüsüdür — torna diş çekme çevrimi (G76) ve mil-eksen senkronizasyonu yoktur. " +
        "Tornalama/kanal/delme hareketleri normal G0/G1 olarak üretildi ve çalışır, ancak diş açma işlemi ÇALIŞMAZ.",
    };
  }
  if (p.includes("siemens") || p.includes("sinumerik")) {
    return {
      threading: true,
      warning:
        "Sinumerik torna diş çevrimini kendi CYCLE97 komutuyla yapar — üretilen G76 bloğu Fanuc biçimindedir, " +
        "tezgaha yüklemeden önce diş bloğunu CYCLE97'ye çevirmeniz gerekir.",
    };
  }
  if (p.includes("heidenhain") || p.includes("klartext")) {
    return {
      threading: true,
      warning:
        "Heidenhain Klartext torna için farklı bir söz dizimi kullanır — üretilen program Fanuc torna dilindedir, " +
        "tezgahınız ISO/G-code modunu desteklemiyorsa elle uyarlanması gerekir.",
    };
  }
  if (FANUC_TURNING_FAMILY.test(p)) return { threading: true, warning: null };
  return {
    threading: true,
    warning:
      `"${postName}" için torna lehçe dönüşümü yok — üretilen G-code Fanuc torna dilindedir, ` +
      "makineye yüklemeden önce kontrol edin.",
  };
}

// ---------------------------------------------------------------------------
// The whole program, built fresh from a plan's confirmed operations — same
// "rebuild everything, never patch" discipline the milling side follows.
// ---------------------------------------------------------------------------

export function buildLatheProgram(plan, options = {}) {
  const stock = plan.stock;
  const material = plan.material || "steel";
  const data = turningCuttingData(material);
  const support = latheControllerSupport(options.postProcessor);
  const cool = coolantFor(material);
  // `verifyOnly` builds the program purely to prove its GEOMETRY is safe --
  // which controller the operator will finally pick isn't known when an
  // operation is confirmed (they choose it at export), so a controller's
  // missing threading cycle must not make a perfectly valid operation
  // un-confirmable. Controller capability is judged once, at export.
  const ctx = {
    data,
    material,
    warnings: [],
    problems: [],
    threadingSupported: options.verifyOnly ? true : support.threading !== false,
  };
  const hasThread = plan.operations.some((op) => op.type === "latheThread");
  if (support.warning && !options.verifyOnly && (!support.threadWarningOnly || hasThread)) {
    ctx.warnings.push(support.warning);
  }

  const prog = new LatheProgram(stock);
  const matLabel = MATERIAL_CUTTING_DATA[material]?.label || material;

  prog.comment("ROVER TORNA PROGRAMI - Topkapi AI Stok-CAM");
  prog.comment(`Malzeme: ${matLabel} | Stok: O${round3(stock.dia)} x ${round3(stock.len)} mm`);
  prog.comment("Sifir noktasi: X0 = mil ekseni (CAP modu), Z0 = ham stogun sag alin yuzeyi");
  prog.comment("Malzeme -Z yonunde uzanir; ayna Z-" + round3(stock.len) + " tarafindadir");
  prog.comment(`Kesme verisi: Vc ${data.vc} m/dak, kaba ${data.fnRough} mm/dev, ince ${data.fnFinish} mm/dev`);
  if (cool.note) prog.comment(`Sogutma: ${cool.note}`);
  prog.raw("G21 (MM)");
  prog.raw("G18 (XZ DUZLEMI)");
  prog.raw("G40 (TAKIM UCU YARICAP TELAFISI IPTAL)");
  prog.raw("G94 (MM/DAK ILERLEME)");
  prog.raw("G97 (SABIT DEVIR)");

  // Turret numbers are assigned per distinct tool, in order of first use.
  const turretBySignature = new Map();
  let lastSignature = null;

  plan.operations.forEach((op, index) => {
    const def = OPERATION_TYPES[op.type];
    if (!isLatheOperation(op.type) || !isLatheGenerationSupported(op.type)) {
      ctx.problems.push(`'${def?.label || op.type}' torna programında üretilemiyor.`);
      return;
    }
    const tool = latheToolFor(op);
    if (!turretBySignature.has(tool.signature)) turretBySignature.set(tool.signature, turretBySignature.size + 1);
    const turret = turretBySignature.get(tool.signature);

    const opLabel = `${op.type.toUpperCase()}_${index}`;
    prog.raw("");
    prog.comment(`BEGIN OPERATION: ${opLabel}`);
    prog.parkClear();
    if (tool.signature !== lastSignature) {
      prog.toolChange(turret, tool.label);
      lastSignature = tool.signature;
    }
    if (cool.on) prog.raw(cool.on);
    else prog.comment("KURU KESIM - sogutma sivisi KULLANMAYIN");

    const info = OP_BUILDERS[op.type](prog, op.params, ctx);
    // The human-readable summary goes in right after the BEGIN marker, where
    // an operator reading the file finds it before the motion it describes.
    const markerIdx = prog.lines.lastIndexOf(`(BEGIN OPERATION: ${opLabel})`);
    prog.lines.splice(markerIdx + 1, 0, `(${info.label})`);
    if (op.note) prog.lines.splice(markerIdx + 2, 0, `(NOT: ${op.note})`);

    prog.raw("M9");
    prog.comment(`END OPERATION: ${opLabel}`);

    // Cutting close to the jaws is a real shop hazard rather than a geometry
    // error, so it is raised as a warning the operator can judge, not a
    // refusal — a short part in a collet is legitimately machined much
    // nearer the chuck than a long bar hanging out of a 3-jaw.
    const reach = latheAxialExtent(op.type, op.params) + Math.abs(prog.faceZ);
    if (reach > Number(stock.len) - LATHE_CHUCK_CLEARANCE_MM) {
      ctx.warnings.push(
        `${def.label}: kesme aynaya ${round3(Number(stock.len) - reach)}mm kadar yaklaşıyor. ` +
        `Parçanın aynadan yeterince çıktığından ve takımın ayna ağızlarına çarpmayacağından emin olun.`,
      );
    }
  });

  prog.raw("");
  prog.parkClear();
  prog.raw("M9");
  prog.raw("M5");
  prog.raw("M30");

  // Tool-nose radius compensation (G41/G42) is deliberately NOT used: it
  // needs the insert's real nose radius and orientation from the control's
  // own offset table, which this generator has no way to know. On cylinders
  // and faces that costs nothing (the nose touches the surface at its
  // tangent either way), but on a TAPER the programmed path is the nose
  // CENTRE, so the cone comes out up to one nose radius undersize. Said
  // plainly rather than silently, and only when the plan actually contains
  // an angled surface.
  if (plan.operations.some((op) => op.type === "latheTaper")) {
    ctx.warnings.push(
      "Konik yüzeylerde takım ucu yarıçap telafisi (G41/G42) kullanılmadı — uç yarıçapı kadar " +
      "(tipik 0.4–0.8mm) sapma olabilir. Hassas konik gerekiyorsa tezgahta uç yarıçapı telafisini devreye alın " +
      "veya son ölçüye göre çapı düzeltin.",
    );
  }

  // The move list the program actually emitted is replayed against a fresh
  // workpiece model — the program is never trusted just because it was
  // generated by code that meant well.
  const safetyProblems = checkLatheMoves(prog.moves, stock);
  const problems = [...ctx.problems, ...safetyProblems];
  const estimatedMinutes = estimateLatheMinutes(prog.moves, prog.toolChanges);

  return {
    ok: problems.length === 0,
    problems,
    warnings: ctx.warnings,
    gcode: prog.lines.join("\n") + "\n",
    moves: prog.moves,
    estimatedMinutes,
    toolChanges: prog.toolChanges,
    tools: [...turretBySignature.entries()].map(([signature, turret]) => ({ signature, turret })),
  };
}

/**
 * Turning's answer to verifyStockPlan(): the same contract (ok / error /
 * estimatedMinutes) so the route layer's confirm/edit/reorder flow doesn't
 * care which machine a plan is for — but computed here, in-process, with no
 * FreeCAD round trip at all. That also means a turning plan can never hit
 * the FreeCAD MCP addon's own GUI-dispatch timeout.
 */
export function verifyLathePlan(plan) {
  if (!plan.operations.length) return { ok: false, error: "Planda henuz onaylanmis islem yok." };
  let result;
  try {
    result = buildLatheProgram(plan, { verifyOnly: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!result.ok) {
    return { ok: false, error: `Güvenlik kontrolü başarısız: ${result.problems.join(" | ")}` };
  }
  return { ok: true, estimatedMinutes: result.estimatedMinutes, warnings: result.warnings };
}

// A plain .gcode file carries no stock information, but the simulator needs
// it to draw the bar the toolpath is meant to cut. Same trick the milling
// side already uses (see prependStockHeaderComment): one ordinary
// parenthesised comment, ignored by every real control, read by
// cnc-sim.html's parseRoverLatheStockHeader. Its presence is ALSO how the
// simulator knows this file uses the ISO turning Z direction (0 at the face,
// negative into the part) rather than its own internal, opposite convention.
export function latheStockHeaderComment(stock) {
  return `(ROVER_LATHE_STOCK D${round3(stock.dia).toFixed(3)} L${round3(stock.len).toFixed(3)})`;
}
