import fs from "node:fs";
import { describeStepGeometry, resolveStepPath } from "./camService.js";
import { detectThreads, THREAD_METHOD_QUESTION } from "./threadSpec.js";

// --- Deterministic machining data -------------------------------------------
// Cutting parameters must be reproducible, so they come from a table + the
// standard feed/speed formulas — never from an LLM guess. Values are
// conservative starting points (2-flute tooling): cutting speed Vc (m/min),
// feed per tooth fz (mm), and a max stepdown as a fraction of tool diameter.
const MATERIAL_DATA = {
  Aluminyum: { vc: 200, fz: 0.05, apFactor: 1.0 },
  Celik: { vc: 80, fz: 0.03, apFactor: 0.5 },
  "Paslanmaz Celik": { vc: 50, fz: 0.025, apFactor: 0.4 },
  "Pirinc/Bronz": { vc: 150, fz: 0.05, apFactor: 0.8 },
  Plastik: { vc: 300, fz: 0.08, apFactor: 1.5 },
  Ahsap: { vc: 400, fz: 0.1, apFactor: 2.0 },
};
const DEFAULT_FLUTES = 2;

export const MATERIAL_OPTIONS = [
  "Aluminyum",
  "Celik",
  "Paslanmaz Celik",
  "Plastik",
  "Ahsap",
  "Diger",
];
const AXIS_OPTIONS = ["3 eksen", "4 eksen", "5 eksen"];
const POST_OPTIONS = ["GRBL", "Mach3", "LinuxCNC", "Fanuc"];
const WORKHOLDING_OPTIONS = [
  "Mengene",
  "Vakum tablasi",
  "Ozel fikstur",
  "Diger",
];
const WCS_OPTIONS = [
  "Sol-alt kose, ust yuzey (X0Y0 kose, Z0 ust)",
  "Parca merkezi, ust yuzey",
  "Sol-alt kose, alt yuzey",
  "Diger",
];
const WORKPLANE_OPTIONS = ["G17 / XY", "G18 / XZ", "G19 / YZ"];
const CUTTER_COMP_OPTIONS = [
  "Yok (kapali)",
  "G41 (sol / climb taraf)",
  "G42 (sag)",
];
const FACE_TOP_OPTIONS = [
  "Evet, ust yuzey yuzeylensin (Face)",
  "Hayir, gerekli degil",
];
const MILLING_DIR_OPTIONS = [
  "Climb (ters yonlu)",
  "Conventional (duz yonlu)",
];
const STEP_STRATEGY_OPTIONS = [
  "Her kademe ayri operasyon",
  "Tek operasyonda (kademeli pasalar)",
];
const OP_MAPPING_OPTIONS = [
  "Otomatik esleştir (onerilen)",
  "Plani gorunce elle duzenlerim",
];
const GROUP_REPEATED_OPTIONS = [
  "Evet, tek operasyon olarak grupla",
  "Hayir, ayri ayri isle",
];

/**
 * Recommend spindle speed, feeds, stepdown and stepover from material + tool
 * diameter using the standard formulas: rpm = Vc*1000/(pi*D), feed = rpm*fz*z.
 * @returns {{spindleRpm:number, horizFeed:number, vertFeed:number, stepdown:number, stepover:number}}
 */
export function recommendCuttingParams(material, toolDiameterMm) {
  const d = MATERIAL_DATA[material] ?? MATERIAL_DATA.Aluminyum;
  const D = Number(toolDiameterMm) > 0 ? Number(toolDiameterMm) : 6;
  let rpm = Math.round((d.vc * 1000) / (Math.PI * D));
  rpm = Math.min(Math.max(rpm, 1000), 24000);
  const horizFeed = Math.max(50, Math.round(rpm * d.fz * DEFAULT_FLUTES));
  const vertFeed = Math.max(20, Math.round(horizFeed * 0.3));
  const stepdown = Math.max(0.2, Math.round(d.apFactor * D * 10) / 10);
  const stepover = Math.max(0.1, Math.round(0.4 * D * 10) / 10);
  return { spindleRpm: rpm, horizFeed, vertFeed, stepdown, stepover };
}

// Finish-pass parameters are derived deterministically from the roughing values
// the user confirmed: lighter cut, finer stepover, no leftover allowance.
function deriveFinishParams(answers) {
  const feed = Number(answers?.horizFeed) || 0;
  const stepdown = Number(answers?.stepdown) || 1;
  const stepover = Number(answers?.stepover) || 1;
  return {
    finishFeed: Math.max(30, Math.round(feed * 0.6)),
    finishStepdown: Math.max(0.1, Math.round(stepdown * 0.3 * 10) / 10),
    finishStepover: Math.max(0.05, Math.round(stepover * 0.25 * 100) / 100),
  };
}

// Raw stock: part bounding box + a machining margin on each side.
function recommendStock(geometry, marginMm) {
  const bb = geometry?.boundingBoxMm ?? {};
  const m = Number(marginMm) >= 0 ? Number(marginMm) : 5;
  const pad = (v) => Math.max(1, Math.ceil((Number(v) || 0) + 2 * m));
  return { x: pad(bb.x), y: pad(bb.y), z: pad(bb.z) };
}

// Recommend a general-purpose flat endmill sized to the part.
function recommendEndmill(geometry) {
  const bb = geometry?.boundingBoxMm ?? {};
  const minXY = Math.min(Number(bb.x) || 50, Number(bb.y) || 50);
  if (minXY < 15) return 3;
  if (minXY < 40) return 6;
  return 8;
}

// Group cylindrical faces by radius; radii present 2+ times are repeated
// features (e.g. a set of identical mounting holes).
export function repeatedFeatures(geometry) {
  const counts = geometry?.cylinderRadiusCounts ?? {};
  const out = [];
  for (const [r, c] of Object.entries(counts)) {
    if (c >= 2) {
      out.push({ diameterMm: Math.round(Number(r) * 2 * 100) / 100, count: c });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

// Heuristic feature -> standard-operation suggestion, shown to the user and fed
// to the planner so operations are named specifically (not just pocket/profile).
export function suggestOperations(geometry) {
  const f = geometry?.faceCountsByType ?? {};
  const levels = geometry?.horizontalLevelCount ?? 0;
  const holes = (geometry?.cylinderRadiiMm ?? []).length;
  const freeform =
    (f.BSplineSurface || 0) +
    (f.Cone || 0) +
    (f.Sphere || 0) +
    (f.Toroid || 0) +
    (f.SurfaceOfRevolution || 0) +
    (f.SurfaceOfExtrusion || 0);
  const is3D = freeform > 0;
  const ops = ["Face (ust yuzey)"];
  if (levels > 2) ops.push("2D Adaptive Clearing + 2D Pocket (kademe/cepler)");
  ops.push("2D Contour (dis kontur)");
  if (holes > 0) ops.push("Drilling (delikler)");
  if (is3D) {
    ops.push("3D Adaptive Clearing (kaba) + Parallel/Scallop (finis)");
  }
  return { is3D, text: ops.join(", ") };
}

// Read an existing answer, else a recommended default.
function pick(answers, name, fallback) {
  const v = answers?.[name];
  return v === undefined || v === "" ? fallback : v;
}

function selectField(name, label, options, value, intro) {
  const f = { name, label, type: "select", options, value };
  if (intro) f.intro = intro;
  return f;
}
function numberField(name, label, unit, value) {
  return { name, label, type: "number", unit, value };
}

/**
 * Build the ordered list of applicable wizard steps, each prefilled from prior
 * answers (so recommendations reflect earlier choices and revisiting keeps
 * input). Conditional steps (thread method, stepped strategy, repeated-feature
 * grouping) appear only when the geometry/prompt calls for them.
 */
function buildApplicableSteps({ geometry, threads, answers }) {
  const a = answers ?? {};
  const margin = pick(a, "stockMargin", 5);
  const stock = recommendStock(geometry, margin);
  const endmill = pick(a, "endmillDiameter", recommendEndmill(geometry));
  const params = recommendCuttingParams(a.material, endmill);
  const isStepped = (geometry?.horizontalLevelCount ?? 0) > 2;
  const repeats = repeatedFeatures(geometry);
  const opSuggestion = suggestOperations(geometry);

  const steps = [];

  // 1. Material
  steps.push({
    id: "material",
    title: "1. Malzeme secimi",
    fields: [
      selectField("material", "Malzeme", MATERIAL_OPTIONS, pick(a, "material", MATERIAL_OPTIONS[0])),
    ],
  });

  // 2. Stock (raw block): per-side margin, block size, and top-face facing.
  steps.push({
    id: "stock",
    title: "2. Stok (ham blok) boyutu",
    intro: "Blok, parca olculeri + her yuzeyden pay olarak onerilir.",
    fields: [
      numberField("stockMargin", "Her yuzeyden pay", "mm", margin),
      numberField("stockX", "Stok X", "mm", pick(a, "stockX", stock.x)),
      numberField("stockY", "Stok Y", "mm", pick(a, "stockY", stock.y)),
      numberField("stockZ", "Stok Z", "mm", pick(a, "stockZ", stock.z)),
      selectField("faceTop", "Ust yuzey ilk islemde yuzeylensin mi? (Face)", FACE_TOP_OPTIONS, pick(a, "faceTop", FACE_TOP_OPTIONS[0])),
    ],
  });

  // 3. Machine axis + post-processor / controller
  steps.push({
    id: "machine",
    title: "3. Tezgah ekseni ve post-processor",
    fields: [
      selectField("axisCount", "Tezgah ekseni", AXIS_OPTIONS, pick(a, "axisCount", AXIS_OPTIONS[0])),
      selectField("postProcessor", "Post-processor / kontrolcu", POST_OPTIONS, pick(a, "postProcessor", POST_OPTIONS[0])),
    ],
  });

  // 4. Workholding
  steps.push({
    id: "workholding",
    title: "4. Baglama yontemi",
    fields: [
      selectField("workholding", "Baglama", WORKHOLDING_OPTIONS, pick(a, "workholding", WORKHOLDING_OPTIONS[0])),
    ],
  });

  // 5. Reference/zero point (WCS) + working plane (asked separately).
  steps.push({
    id: "reference",
    title: "5. Referans noktasi (WCS) ve calisma duzlemi",
    fields: [
      selectField("wcs", "Sifir noktasi (WCS)", WCS_OPTIONS, pick(a, "wcs", WCS_OPTIONS[0])),
      selectField("workPlane", "Calisma duzlemi", WORKPLANE_OPTIONS, pick(a, "workPlane", WORKPLANE_OPTIONS[0])),
    ],
  });

  // 6. Tool selection (recommended endmill + cutter comp; thread method).
  const toolFields = [
    numberField("endmillDiameter", "Ana freze capi", "mm", endmill),
    selectField(
      "cutterComp",
      "Takim yaricap kompanzasyonu (torna: kesici ucu yaricapi)",
      CUTTER_COMP_OPTIONS,
      pick(a, "cutterComp", CUTTER_COMP_OPTIONS[0]),
    ),
  ];
  if (threads?.hasThread) {
    toolFields.push(
      selectField("threadMethod", THREAD_METHOD_QUESTION.question, THREAD_METHOD_QUESTION.options, pick(a, "threadMethod", THREAD_METHOD_QUESTION.options[0])),
    );
  }
  steps.push({
    id: "tooling",
    title: "6. Takim secimi",
    fields: toolFields,
  });

  // 7. Operation-type mapping (feature -> standard operation name).
  steps.push({
    id: "operations",
    title: "7. Operasyon tipi esleştirmesi",
    intro: `Tespit edilen ozelliklere onerilen operasyonlar: ${opSuggestion.text}. Parca ${opSuggestion.is3D ? "3D (serbest yuzeyli)" : "2.5D"} olarak degerlendirildi.`,
    fields: [
      selectField("operationMapping", "Operasyon esleştirmesi", OP_MAPPING_OPTIONS, pick(a, "operationMapping", OP_MAPPING_OPTIONS[0])),
    ],
  });

  // 8. Cutting parameters — roughing values (+ finish derived later),
  //    stock-to-leave, stepover and milling direction.
  steps.push({
    id: "cutting",
    title: "8. Kesme parametreleri (kaba + finis)",
    intro: `Onerilenler ${a.material ?? MATERIAL_OPTIONS[0]} + O${endmill}mm takima gore. Kaba ve finis ayri operasyon planlanir.`,
    fields: [
      numberField("spindleRpm", "Spindle hizi", "rpm", pick(a, "spindleRpm", params.spindleRpm)),
      numberField("horizFeed", "Yatay ilerleme", "mm/min", pick(a, "horizFeed", params.horizFeed)),
      numberField("vertFeed", "Dikey ilerleme", "mm/min", pick(a, "vertFeed", params.vertFeed)),
      numberField("stepdown", "Kesme derinligi (stepdown)", "mm", pick(a, "stepdown", params.stepdown)),
      numberField("stepover", "Yanal adim (stepover)", "mm", pick(a, "stepover", params.stepover)),
      numberField("roughStockToLeave", "Kaba isleme finis payi (stock to leave)", "mm", pick(a, "roughStockToLeave", 0.3)),
      selectField("millingDirection", "Kesme yonu", MILLING_DIR_OPTIONS, pick(a, "millingDirection", MILLING_DIR_OPTIONS[0])),
    ],
  });

  // 9. Multi-level / stepped strategy (only if stepped).
  if (isStepped) {
    steps.push({
      id: "steps",
      title: "9. Kademe / cok seviyeli operasyon",
      intro: `Parcada ${geometry.horizontalLevelCount} farkli yukseklik seviyesi tespit edildi.`,
      fields: [
        selectField("stepStrategy", "Kademeler nasil islensin?", STEP_STRATEGY_OPTIONS, pick(a, "stepStrategy", STEP_STRATEGY_OPTIONS[0])),
      ],
    });
  }

  // 10. Repeated-feature grouping (only if identical features detected).
  if (repeats.length) {
    const desc = repeats
      .map((r) => `${r.count} adet O${r.diameterMm}mm`)
      .join(", ");
    steps.push({
      id: "repeated",
      title: "10. Tekrarlayan ozellik tespiti",
      intro: `Ayni capta tekrarlayan ozellik tespit edildi: ${desc}. Tek operasyon olarak gruplanabilir.`,
      fields: [
        selectField("groupRepeated", "Tekrarlayan ozellikler nasil islensin?", GROUP_REPEATED_OPTIONS, pick(a, "groupRepeated", GROUP_REPEATED_OPTIONS[0])),
      ],
    });
  }

  return steps;
}

/**
 * Resolve which wizard step to show. The applicable step list depends only on
 * the geometry/prompt (not on answers), so navigation is index-driven: pass a
 * targetIndex to render a specific step (recomputed so its recommendations
 * reflect current answers, and its fields prefilled from them). Without a
 * targetIndex, returns the first unanswered step. targetIndex >= total => done.
 */
export function nextCamStep({ geometry, threads, answers, targetIndex }) {
  const a = answers ?? {};
  const steps = buildApplicableSteps({ geometry, threads, answers: a });
  const total = steps.length;

  if (Number.isInteger(targetIndex)) {
    const i = targetIndex;
    if (i < 0) return { done: false, index: 0, total, step: steps[0] };
    if (i >= total) return { done: true, total };
    return { done: false, index: i, total, step: steps[i] };
  }

  for (let i = 0; i < steps.length; i++) {
    const complete = steps[i].fields.every((f) => {
      const v = a[f.name];
      return v !== undefined && v !== "";
    });
    if (!complete) return { done: false, index: i, total, step: steps[i] };
  }
  return { done: true, total };
}

/**
 * Format the collected wizard answers into a block the plan/code prompts consume
 * and must honour (exact tool diameter, feeds/speeds, WCS, post-processor,
 * roughing + derived finishing, cutter comp, work plane, ...).
 * @param {object} answers
 * @param {object} [geometry] used to note repeated features to group
 * @returns {string}
 */
export function camParamsBlock(answers, geometry) {
  const a = answers ?? {};
  const fin = deriveFinishParams(a);
  const repeats = geometry ? repeatedFeatures(geometry) : [];
  const repeatNote = repeats.length
    ? repeats.map((r) => `${r.count}xO${r.diameterMm}mm`).join(", ")
    : "";
  return [
    "\n[CAM_PARAMETRELERI] (bu degerlere uy):",
    `- Malzeme: ${a.material ?? "?"}`,
    `- Stok (ham blok) mm: ${a.stockX ?? "?"} x ${a.stockY ?? "?"} x ${a.stockZ ?? "?"} (her yuzeyden pay: ${a.stockMargin ?? "?"} mm)`,
    `- Ust yuzey Face operasyonu: ${a.faceTop ?? "?"}`,
    `- Tezgah ekseni: ${a.axisCount ?? "?"}`,
    `- Post-processor / kontrolcu: ${a.postProcessor ?? "GRBL"}`,
    `- Baglama: ${a.workholding ?? "?"}`,
    `- Referans/sifir (WCS): ${a.wcs ?? "?"}`,
    `- Calisma duzlemi: ${a.workPlane ?? "G17 / XY"}`,
    `- Ana freze capi: ${a.endmillDiameter ?? "?"} mm`,
    `- Takim yaricap kompanzasyonu: ${a.cutterComp ?? "Yok"}`,
    a.threadMethod ? `- Dis yontemi: ${a.threadMethod}` : null,
    `- Operasyon esleştirme: ${a.operationMapping ?? "otomatik"}`,
    "- KABA (roughing):",
    `    spindle ${a.spindleRpm ?? "?"} rpm, ilerleme ${a.horizFeed ?? "?"} mm/min, dikey ${a.vertFeed ?? "?"} mm/min,`,
    `    stepdown ${a.stepdown ?? "?"} mm, stepover ${a.stepover ?? "?"} mm, stock-to-leave ${a.roughStockToLeave ?? "?"} mm`,
    "- FINIS (finishing, kabadan turetildi):",
    `    ilerleme ${fin.finishFeed} mm/min, stepdown ${fin.finishStepdown} mm, stepover ${fin.finishStepover} mm, stock-to-leave 0 mm`,
    `- Kesme yonu: ${a.millingDirection ?? "Climb"}`,
    a.stepStrategy ? `- Kademe stratejisi: ${a.stepStrategy}` : null,
    repeatNote ? `- Tekrarlayan ozellikler (${a.groupRepeated ?? "grupla"}): ${repeatNote}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// The wizard hits /cam-step once per step, so cache the (immutable) geometry
// summary per STEP file. Keyed by absolute path + mtime so a regenerated file
// with the same name is re-analysed.
const geometryCache = new Map();
const GEOM_CACHE_MAX = 50;

export async function getGeometryCached(stepPath) {
  const abs = resolveStepPath(stepPath);
  let key = abs;
  try {
    key = `${abs}:${fs.statSync(abs).mtimeMs}`;
  } catch {
    // file missing; describeStepGeometry will throw with a clear message
  }
  if (geometryCache.has(key)) return geometryCache.get(key);
  const geometry = await describeStepGeometry(stepPath);
  if (geometryCache.size >= GEOM_CACHE_MAX) {
    geometryCache.delete(geometryCache.keys().next().value);
  }
  geometryCache.set(key, geometry);
  return geometry;
}

/**
 * Resolve the next wizard step for a STEP file given the answers so far.
 * @param {string} stepPath
 * @param {string} prompt original prompt (scanned for threads)
 * @param {object} answers accumulated answers
 * @param {number} [targetIndex]
 */
export async function getNextCamStep(stepPath, prompt, answers, targetIndex) {
  const geometry = await getGeometryCached(stepPath);
  const threads = detectThreads(typeof prompt === "string" ? prompt : "");
  return nextCamStep({
    geometry,
    threads,
    answers: answers ?? {},
    targetIndex,
  });
}
