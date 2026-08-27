import { randomUUID } from "node:crypto";

// In-memory store for the menu-driven, stock-based CAM plan feature: unlike
// CAM Asistanı's wizard (which starts from an uploaded STEP file and asks
// "how do we machine THIS model"), this starts from a bare stock block and
// lets the operator build up a job one operation at a time — pick a type
// from a fixed menu, the LLM asks for whatever parameters are still needed,
// the operator confirms a visual preview, and only THEN does it become part
// of the plan. See PLAN.md discussion: nothing enters `operations` without
// passing both automatic validation (this file) and operator confirmation
// (the route layer) — there is no such thing as a "pending but recorded"
// operation.
//
// A plan is edited like a real CAD/CAM feature tree: replacing an earlier
// operation never patches downstream state — the caller (Faz 4/5) always
// rebuilds the whole FreeCAD job fresh from the current `operations` array
// and re-runs every safety check, so a plan's operations list is the single
// source of truth for both what gets drawn (sticker preview) and what gets
// machined (FreeCAD Path op) — never two independently-computed values.

const plans = new Map(); // planKey -> plan

const PLAN_TTL_MS = 2 * 60 * 60 * 1000; // 2h idle timeout, mirrors jobStore's cleanup pattern

// ---------------------------------------------------------------------------
// Operation type registry — one entry per menu choice. `params` describes
// what a complete operation needs; `bounds(params, stock)` returns the
// operation's axis-aligned XY footprint (or null for whole-part operations
// like face/contour/chamfer, which have no separate footprint to check).
// Field names match the client-side deterministic generators in
// web/cnc-sim.html (tpMillDrill, tpMillRectPocket, ...) so later phases can
// share the exact same parameter shapes between the sticker preview and the
// real FreeCAD generator.
// ---------------------------------------------------------------------------

function centeredBounds(x, y, halfW, halfH) {
  return { xMin: x - halfW, xMax: x + halfW, yMin: y - halfH, yMax: y + halfH };
}

// Exact axis-aligned bounding box of a `sl`(length) x `sw`(width) rectangle
// centered at (x,y) and rotated by dirAngle degrees around its center.
function rotatedSlotBounds(x, y, sl, sw, dirAngle) {
  const rad = ((dirAngle || 0) * Math.PI) / 180;
  const hx = sl / 2, hy = sw / 2;
  const bx = hx * Math.abs(Math.cos(rad)) + hy * Math.abs(Math.sin(rad));
  const by = hx * Math.abs(Math.sin(rad)) + hy * Math.abs(Math.cos(rad));
  return centeredBounds(x, y, bx, by);
}

// Bounding box of an (rows x cols) hole grid centered at (x,y), expanded by
// each hole's own radius -- mirrors drillGridOpPy's exact same layout math
// (stockCamGenerateService.js), so the bounds check and the real toolpath
// never disagree about where the outermost holes land.
function gridBounds(x, y, rows, cols, spacingX, spacingY, dia) {
  const totalW = Math.max(0, (cols || 1) - 1) * (spacingX || 0);
  const totalH = Math.max(0, (rows || 1) - 1) * (spacingY || 0);
  return centeredBounds(x, y, totalW / 2 + dia / 2, totalH / 2 + dia / 2);
}

// Conservative bounding box of a bolt-circle hole pattern: the circle the
// hole centers sit on (radius) plus each hole's own radius (dia/2).
function circlePatternBounds(x, y, radius, dia) {
  return centeredBounds(x, y, radius + dia / 2, radius + dia / 2);
}

export const OPERATION_TYPES = Object.freeze({
  drill: {
    label: "Delik Delme",
    params: [
      { name: "dia", label: "Çap", unit: "mm", type: "number", min: 0.5, max: 200 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    bounds: (p) => centeredBounds(p.x, p.y, p.dia / 2, p.dia / 2),
  },
  rectPocket: {
    label: "Dikdörtgen Cep",
    params: [
      { name: "pw", label: "Genişlik (X)", unit: "mm", type: "number", min: 1, max: 2000 },
      { name: "pl", label: "Uzunluk (Y)", unit: "mm", type: "number", min: 1, max: 2000 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    bounds: (p) => centeredBounds(p.x, p.y, p.pw / 2, p.pl / 2),
  },
  circPocket: {
    label: "Daire Cep",
    params: [
      { name: "dia", label: "Çap", unit: "mm", type: "number", min: 1, max: 2000 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    bounds: (p) => centeredBounds(p.x, p.y, p.dia / 2, p.dia / 2),
  },
  hexPocket: {
    label: "Altıgen Cep",
    params: [
      { name: "dia", label: "Çap", unit: "mm", type: "number", min: 1, max: 2000 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    // Bounding circle of the hexagon (dia = across-corner diameter) — a
    // conservative, exact-enough footprint for the stock-bounds check.
    bounds: (p) => centeredBounds(p.x, p.y, p.dia / 2, p.dia / 2),
  },
  slot: {
    label: "Kanal",
    params: [
      { name: "sw", label: "Genişlik", unit: "mm", type: "number", min: 0.5, max: 500 },
      { name: "sl", label: "Uzunluk", unit: "mm", type: "number", min: 1, max: 2000 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
      { name: "dirAngle", label: "Yön Açısı", unit: "derece", type: "number", default: 0, min: -360, max: 360 },
    ],
    bounds: (p) => rotatedSlotBounds(p.x, p.y, p.sl, p.sw, p.dirAngle || 0),
  },
  drillGrid: {
    label: "Delik Izgarası",
    params: [
      { name: "dia", label: "Çap", unit: "mm", type: "number", min: 0.5, max: 200 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "rows", label: "Satır Sayısı", unit: "", type: "number", min: 1, max: 50 },
      { name: "cols", label: "Sütun Sayısı", unit: "", type: "number", min: 1, max: 50 },
      { name: "spacingX", label: "X Aralığı", unit: "mm", type: "number", min: 0, max: 2000 },
      { name: "spacingY", label: "Y Aralığı", unit: "mm", type: "number", min: 0, max: 2000 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    bounds: (p) => gridBounds(p.x, p.y, p.rows, p.cols, p.spacingX, p.spacingY, p.dia),
  },
  drillCircle: {
    label: "Delik Çemberi",
    params: [
      { name: "dia", label: "Çap", unit: "mm", type: "number", min: 0.5, max: 200 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "count", label: "Delik Sayısı", unit: "", type: "number", min: 2, max: 200 },
      { name: "radius", label: "Dağılım Yarıçapı", unit: "mm", type: "number", min: 0.1, max: 2000 },
      { name: "startAngle", label: "Başlangıç Açısı", unit: "derece", type: "number", default: 0, min: -360, max: 360 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    bounds: (p) => circlePatternBounds(p.x, p.y, p.radius, p.dia),
  },
  face: {
    label: "Yüzey Düzeltme",
    params: [
      { name: "depth", label: "Talaş Derinliği", unit: "mm", type: "number", min: 0.05, max: 50 },
    ],
    bounds: () => null, // whole top surface — no separate XY footprint to check
  },
  contour: {
    label: "Kontur Kesme",
    params: [
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
    ],
    bounds: () => null, // outer profile of the part — footprint == stock/part outline
  },
  chamfer: {
    label: "Pah Kırma",
    params: [
      { name: "depth", label: "Pah Miktarı", unit: "mm", type: "number", min: 0.1, max: 50 },
    ],
    bounds: () => null, // runs along part edges — no separate XY footprint
  },
});

export function listOperationTypes() {
  return Object.entries(OPERATION_TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    params: def.params,
  }));
}

// ---------------------------------------------------------------------------
// Validation: numeric ranges from the registry + the operation's XY
// footprint against the plan's stock. Depth is checked against stock height
// for every type (even whole-part ones) since none of them can cut deeper
// than the material is thick. Returns a list of Turkish, operator-facing
// problem strings; empty means the operation is safe to preview/confirm.
// ---------------------------------------------------------------------------

export function validateOperationParams(type, params, stock) {
  const def = OPERATION_TYPES[type];
  if (!def) return [`Bilinmeyen işlem tipi: ${type}`];
  const problems = [];

  for (const field of def.params) {
    let v = params?.[field.name];
    // A field with its own `default` (e.g. slot's dirAngle=0) is genuinely
    // optional -- the LLM step layer (stockCamStepService.js) already fills
    // it in before a normal wizard confirm reaches here, but a caller that
    // skips that layer shouldn't be rejected for omitting an optional value.
    if ((v === undefined || v === null || v === "") && field.default !== undefined) {
      v = field.default;
    }
    if (v === undefined || v === null || v === "") {
      problems.push(`${field.label} belirtilmedi.`);
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      problems.push(`${field.label} geçerli bir sayı değil: ${v}`);
      continue;
    }
    if (field.min !== undefined && n < field.min) {
      problems.push(`${field.label} çok küçük (min ${field.min}${field.unit ? field.unit : ""}): ${n}`);
    }
    if (field.max !== undefined && n > field.max) {
      problems.push(`${field.label} çok büyük (maks ${field.max}${field.unit ? field.unit : ""}): ${n}`);
    }
  }
  if (problems.length) return problems; // don't attempt bounds checks on bad numbers

  const w = Number(stock?.w), d = Number(stock?.d), h = Number(stock?.h);
  if (!Number.isFinite(w) || !Number.isFinite(d) || !Number.isFinite(h)) {
    return ["Stok boyutları geçersiz — önce stok boyutunu ayarlayın."];
  }

  const depth = Number(params.depth);
  if (Number.isFinite(depth) && depth > h + 1e-6) {
    problems.push(`Derinlik (${depth}mm) stok kalınlığından (${h}mm) fazla olamaz.`);
  }

  const norm = {};
  for (const field of def.params) norm[field.name] = Number(params[field.name] ?? field.default ?? 0);
  const box = def.bounds(norm);
  if (box) {
    const xLo = -w / 2, xHi = w / 2, yLo = -d / 2, yHi = d / 2;
    if (box.xMin < xLo - 1e-6 || box.xMax > xHi + 1e-6 || box.yMin < yLo - 1e-6 || box.yMax > yHi + 1e-6) {
      problems.push(
        `İşlem stok sınırlarının dışına taşıyor: gerekli X ${box.xMin.toFixed(1)}..${box.xMax.toFixed(1)}, ` +
        `Y ${box.yMin.toFixed(1)}..${box.yMax.toFixed(1)} — stok sınırları X ${xLo.toFixed(1)}..${xHi.toFixed(1)}, ` +
        `Y ${yLo.toFixed(1)}..${yHi.toFixed(1)}.`
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Plan lifecycle
// ---------------------------------------------------------------------------

export function createPlan(stock) {
  const planKey = randomUUID();
  plans.set(planKey, {
    planKey,
    stock: { w: Number(stock?.w) || 100, d: Number(stock?.d) || 100, h: Number(stock?.h) || 20 },
    operations: [], // confirmed only — see module doc comment
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return getPlan(planKey);
}

export function getPlan(planKey) {
  const plan = plans.get(planKey);
  return plan ? { ...plan, operations: plan.operations.map((op) => ({ ...op })) } : null;
}

function touch(plan) {
  plan.updatedAt = Date.now();
}

// Appends a new confirmed operation. The route layer is responsible for
// having already run validateOperationParams() and gotten operator
// confirmation — this function itself re-validates defensively (never trust
// a caller not to skip a step) and refuses to record anything that fails.
export function confirmOperation(planKey, type, params) {
  const plan = plans.get(planKey);
  if (!plan) return { ok: false, problems: ["Plan bulunamadı."] };
  const problems = validateOperationParams(type, params, plan.stock);
  if (problems.length) return { ok: false, problems };
  const op = { id: randomUUID(), type, params: { ...params }, confirmedAt: Date.now() };
  plan.operations.push(op);
  touch(plan);
  return { ok: true, operation: { ...op }, operations: plan.operations.map((o) => ({ ...o })) };
}

// Replaces an operation in place (by id) — position in the list is
// preserved, everything after it stays untouched structurally. The caller
// (Faz 4/5) must still rebuild the whole FreeCAD job from the returned
// `operations` array and re-run every safety check; this function only
// updates the plan's own record of what should exist.
export function replaceOperation(planKey, opId, type, params) {
  const plan = plans.get(planKey);
  if (!plan) return { ok: false, problems: ["Plan bulunamadı."] };
  const idx = plan.operations.findIndex((o) => o.id === opId);
  if (idx === -1) return { ok: false, problems: ["İşlem bulunamadı."] };
  const problems = validateOperationParams(type, params, plan.stock);
  if (problems.length) return { ok: false, problems };
  plan.operations[idx] = { id: opId, type, params: { ...params }, confirmedAt: Date.now() };
  touch(plan);
  return { ok: true, operations: plan.operations.map((o) => ({ ...o })) };
}

export function removeOperation(planKey, opId) {
  const plan = plans.get(planKey);
  if (!plan) return { ok: false, problems: ["Plan bulunamadı."] };
  const before = plan.operations.length;
  plan.operations = plan.operations.filter((o) => o.id !== opId);
  if (plan.operations.length === before) return { ok: false, problems: ["İşlem bulunamadı."] };
  touch(plan);
  return { ok: true, operations: plan.operations.map((o) => ({ ...o })) };
}

export function listOperations(planKey) {
  const plan = plans.get(planKey);
  return plan ? plan.operations.map((o) => ({ ...o })) : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, plan] of plans) {
    if (now - plan.updatedAt > PLAN_TTL_MS) plans.delete(key);
  }
}, 10 * 60 * 1000).unref();
