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

export const MATERIAL_OPTIONS = Object.keys(MATERIAL_DATA);
const AXIS_OPTIONS = ["3 eksen", "4 eksen", "5 eksen"];
const POST_OPTIONS = ["GRBL", "LinuxCNC", "Mach3/Mach4", "Marlin", "Genel (generic)"];
const WORKHOLDING_OPTIONS = [
  "Mengene",
  "Vakum tabla",
  "Civata/kelepce ile tabla",
  "Diger",
];
const WCS_OPTIONS = [
  "Sol-alt kose, ust yuzey (X0Y0 kose, Z0 ust)",
  "Parca merkezi, ust yuzey",
  "Sol-alt kose, alt yuzey",
  "Diger",
];
const STEP_STRATEGY_OPTIONS = [
  "Her kademe ayri operasyon",
  "Tek operasyonda (kademeli pasalar)",
];

/**
 * Recommend spindle speed and feeds from material + tool diameter using the
 * standard formulas: rpm = Vc*1000/(pi*D), feed = rpm*fz*flutes.
 * @param {string} material
 * @param {number} toolDiameterMm
 * @returns {{spindleRpm:number, horizFeed:number, vertFeed:number, stepdown:number}}
 */
export function recommendCuttingParams(material, toolDiameterMm) {
  const d = MATERIAL_DATA[material] ?? MATERIAL_DATA.Aluminyum;
  const D = Number(toolDiameterMm) > 0 ? Number(toolDiameterMm) : 6;
  let rpm = Math.round((d.vc * 1000) / (Math.PI * D));
  rpm = Math.min(Math.max(rpm, 1000), 24000);
  const horizFeed = Math.max(50, Math.round(rpm * d.fz * DEFAULT_FLUTES));
  const vertFeed = Math.max(20, Math.round(horizFeed * 0.3));
  const stepdown = Math.max(0.2, Math.round(d.apFactor * D * 10) / 10);
  return { spindleRpm: rpm, horizFeed, vertFeed, stepdown };
}

// Raw stock: part bounding box + a machining margin on each side.
const STOCK_MARGIN_MM = 5;
function recommendStock(geometry) {
  const bb = geometry?.boundingBoxMm ?? {};
  const pad = (v) => Math.max(1, Math.ceil((Number(v) || 0) + 2 * STOCK_MARGIN_MM));
  return { x: pad(bb.x), y: pad(bb.y), z: pad(bb.z) };
}

// Recommend a general-purpose flat endmill sized to the part. Small parts get a
// smaller tool so it fits the features.
function recommendEndmill(geometry) {
  const bb = geometry?.boundingBoxMm ?? {};
  const minXY = Math.min(Number(bb.x) || 50, Number(bb.y) || 50);
  if (minXY < 15) return 3;
  if (minXY < 40) return 6;
  return 8;
}

// Detected drillable hole diameters (from cylinder radii), for the tool step's
// informational note.
function holeDiametersNote(geometry) {
  const radii = Array.isArray(geometry?.cylinderRadiiMm) ? geometry.cylinderRadiiMm : [];
  const dias = radii.map((r) => Math.round(r * 2 * 100) / 100).filter((d) => d > 0);
  if (dias.length === 0) return "";
  return `Tespit edilen delik caplari: ${dias.join(", ")} mm (delme icin).`;
}

// Read an existing answer, else a recommended default. Numbers are returned as
// numbers so the frontend prefills a numeric input.
function pick(answers, name, fallback) {
  const v = answers?.[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Build the ordered list of applicable wizard steps, each with its fields
 * prefilled from prior answers (so recommendations reflect earlier choices and
 * revisiting a step keeps the user's input). Conditional steps (thread method,
 * multi-level strategy) are only included when the geometry/prompt calls for it.
 */
function buildApplicableSteps({ geometry, threads, answers }) {
  const a = answers ?? {};
  const stock = recommendStock(geometry);
  const endmill = pick(a, "endmillDiameter", recommendEndmill(geometry));
  const params = recommendCuttingParams(a.material, endmill);
  const isStepped = (geometry?.horizontalLevelCount ?? 0) > 2;

  const steps = [];

  // 1. Material
  steps.push({
    id: "material",
    title: "1. Malzeme secimi",
    fields: [
      {
        name: "material",
        label: "Malzeme",
        type: "select",
        options: MATERIAL_OPTIONS,
        value: pick(a, "material", MATERIAL_OPTIONS[0]),
      },
    ],
  });

  // 2. Stock (raw block) size
  steps.push({
    id: "stock",
    title: "2. Stok (ham blok) boyutu",
    intro: "Onerilen: parca olculeri + her kenardan 5 mm pay.",
    fields: [
      { name: "stockX", label: "Stok X", type: "number", unit: "mm", value: pick(a, "stockX", stock.x) },
      { name: "stockY", label: "Stok Y", type: "number", unit: "mm", value: pick(a, "stockY", stock.y) },
      { name: "stockZ", label: "Stok Z", type: "number", unit: "mm", value: pick(a, "stockZ", stock.z) },
    ],
  });

  // 3. Machine axis + post-processor / controller
  steps.push({
    id: "machine",
    title: "3. Tezgah ekseni ve post-processor",
    fields: [
      {
        name: "axisCount",
        label: "Tezgah ekseni",
        type: "select",
        options: AXIS_OPTIONS,
        value: pick(a, "axisCount", AXIS_OPTIONS[0]),
      },
      {
        name: "postProcessor",
        label: "Post-processor / kontrolcu",
        type: "select",
        options: POST_OPTIONS,
        value: pick(a, "postProcessor", POST_OPTIONS[0]),
      },
    ],
  });

  // 4. Workholding
  steps.push({
    id: "workholding",
    title: "4. Baglama yontemi",
    fields: [
      {
        name: "workholding",
        label: "Baglama",
        type: "select",
        options: WORKHOLDING_OPTIONS,
        value: pick(a, "workholding", WORKHOLDING_OPTIONS[0]),
      },
    ],
  });

  // 5. Reference / zero point (WCS)
  steps.push({
    id: "wcs",
    title: "5. Referans / sifir noktasi (WCS)",
    fields: [
      {
        name: "wcs",
        label: "Sifir noktasi",
        type: "select",
        options: WCS_OPTIONS,
        value: pick(a, "wcs", WCS_OPTIONS[0]),
      },
    ],
  });

  // 6. Tool selection (geometry-recommended endmill + confirm/change; thread
  //    method when threads are present).
  const toolFields = [
    {
      name: "endmillDiameter",
      label: "Ana freze capi",
      type: "number",
      unit: "mm",
      value: endmill,
    },
  ];
  if (threads?.hasThread) {
    toolFields.push({
      name: "threadMethod",
      label: THREAD_METHOD_QUESTION.question,
      type: "select",
      options: THREAD_METHOD_QUESTION.options,
      value: pick(a, "threadMethod", THREAD_METHOD_QUESTION.options[0]),
    });
  }
  steps.push({
    id: "tooling",
    title: "6. Takim secimi",
    intro: holeDiametersNote(geometry) || undefined,
    fields: toolFields,
  });

  // 7. Cutting parameters (recommended from material + tool; confirm/change).
  steps.push({
    id: "cutting",
    title: "7. Kesme parametreleri",
    intro: `Onerilenler ${a.material ?? MATERIAL_OPTIONS[0]} + O${endmill}mm takima gore hesaplandi.`,
    fields: [
      { name: "spindleRpm", label: "Spindle hizi", type: "number", unit: "rpm", value: pick(a, "spindleRpm", params.spindleRpm) },
      { name: "horizFeed", label: "Yatay ilerleme", type: "number", unit: "mm/min", value: pick(a, "horizFeed", params.horizFeed) },
      { name: "vertFeed", label: "Dikey ilerleme", type: "number", unit: "mm/min", value: pick(a, "vertFeed", params.vertFeed) },
      { name: "stepdown", label: "Pasa derinligi", type: "number", unit: "mm", value: pick(a, "stepdown", params.stepdown) },
    ],
  });

  // 8. Multi-level / stepped operation confirmation (only if stepped).
  if (isStepped) {
    steps.push({
      id: "steps",
      title: "8. Kademe / cok seviyeli operasyon",
      intro: `Parcada ${geometry.horizontalLevelCount} farkli yukseklik seviyesi tespit edildi.`,
      fields: [
        {
          name: "stepStrategy",
          label: "Kademeler nasil islensin?",
          type: "select",
          options: STEP_STRATEGY_OPTIONS,
          value: pick(a, "stepStrategy", STEP_STRATEGY_OPTIONS[0]),
        },
      ],
    });
  }

  return steps;
}

/**
 * Resolve which wizard step to show. The applicable step list depends only on
 * the geometry/prompt (not on answers), so navigation is index-driven: pass a
 * targetIndex to render a specific step (recomputed so its recommendations
 * reflect the current answers, and its fields prefilled from them). Without a
 * targetIndex, returns the first unanswered step. targetIndex >= total => done.
 * @param {{geometry:object, threads:object, answers:object, targetIndex?:number}} ctx
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
 * and must honour (exact tool diameter, feeds/speeds, WCS, post-processor, ...).
 * @param {object} answers
 * @returns {string}
 */
export function camParamsBlock(answers) {
  const a = answers ?? {};
  return [
    "\n[CAM_PARAMETRELERI] (bu degerlere uy):",
    `- Malzeme: ${a.material ?? "?"}`,
    `- Stok (ham blok) mm: ${a.stockX ?? "?"} x ${a.stockY ?? "?"} x ${a.stockZ ?? "?"}`,
    `- Tezgah ekseni: ${a.axisCount ?? "?"}`,
    `- Post-processor / kontrolcu: ${a.postProcessor ?? "GRBL"}`,
    `- Baglama: ${a.workholding ?? "?"}`,
    `- Referans/sifir (WCS): ${a.wcs ?? "?"}`,
    `- Ana freze capi: ${a.endmillDiameter ?? "?"} mm`,
    a.threadMethod ? `- Dis yontemi: ${a.threadMethod}` : null,
    `- Spindle hizi: ${a.spindleRpm ?? "?"} rpm`,
    `- Yatay ilerleme (HorizFeed): ${a.horizFeed ?? "?"} mm/min`,
    `- Dikey ilerleme (VertFeed): ${a.vertFeed ?? "?"} mm/min`,
    `- Pasa derinligi (stepdown): ${a.stepdown ?? "?"} mm`,
    a.stepStrategy ? `- Kademe stratejisi: ${a.stepStrategy}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// The wizard hits /cam-step once per step, so cache the (immutable) geometry
// summary per STEP file to avoid re-running FreeCAD on every step. Keyed by
// absolute path + mtime so a regenerated file with the same name is re-analysed.
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
