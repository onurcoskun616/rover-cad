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

export const MILL_OPERATION_TYPES = Object.freeze({
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
  // "Kılavuz Çekme" (tapping): cuts an internal thread. Unlike every other
  // op's `dia`, this one is NOT a geometry guess a bigger/smaller tool can
  // stand in for -- it's the tap's own exact nominal thread diameter, and
  // `pitch` (thread pitch, mm/rev) has no safe default (a wrong guess cuts
  // the wrong thread) -- both are required, never auto-filled.
  tapping: {
    label: "Kılavuz Çekme",
    params: [
      { name: "dia", label: "Diş Çapı (ör. M8 için 8)", unit: "mm", type: "number", min: 1, max: 100 },
      { name: "pitch", label: "Diş Adımı (Pitch)", unit: "mm", type: "number", min: 0.1, max: 10 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    bounds: (p) => centeredBounds(p.x, p.y, p.dia / 2, p.dia / 2),
  },
  // "Freze ile Diş Açma" (thread milling): cuts an internal thread with a
  // small thread-mill endmill via helical interpolation, instead of a tap.
  // Same "never guess" discipline as tapping for dia/pitch -- MinorDiameter
  // gets computed from these two via the exact ISO 68-1 formula (real math,
  // not a guess), never asked separately.
  threadMilling: {
    label: "Freze ile Diş Açma",
    params: [
      { name: "dia", label: "Diş Çapı (ör. M8 için 8)", unit: "mm", type: "number", min: 3, max: 100 },
      { name: "pitch", label: "Diş Adımı (Pitch)", unit: "mm", type: "number", min: 0.1, max: 10 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
      { name: "passes", label: "Paso Sayısı", unit: "", type: "number", default: 3, min: 1, max: 20 },
    ],
    bounds: (p) => centeredBounds(p.x, p.y, p.dia / 2, p.dia / 2),
  },
  // "Havşa Açma (Konik)" (countersink): a shallow conical recess (vida
  // başı oturma yeri) -- FreeCAD's own G-code generation for Path.Op.
  // Drilling only ever plunges straight to a Z depth (no cone-shape
  // concept in the G-code itself, same simplification already relied on
  // by plain drilling); the CONE shape comes entirely from whichever
  // physical countersink bit the operator loads. `angle` is kept purely
  // informational (tells the operator which bit angle to load) -- `depth`
  // stays a normal, explicit, required field like every other op (rather
  // than derived from dia+angle) so the shared stock-height bounds check
  // keeps working unchanged.
  countersink: {
    label: "Havşa Açma (Konik)",
    params: [
      { name: "dia", label: "Havşa Çapı (üst)", unit: "mm", type: "number", min: 1, max: 100 },
      { name: "depth", label: "Derinlik", unit: "mm", type: "number", min: 0.1, max: 50 },
      { name: "angle", label: "Havşa Açısı (bilgi amaçlı)", unit: "derece", type: "number", default: 90, min: 60, max: 150 },
      { name: "x", label: "Merkez X", unit: "mm", type: "number" },
      { name: "y", label: "Merkez Y", unit: "mm", type: "number" },
    ],
    bounds: (p) => centeredBounds(p.x, p.y, p.dia / 2, p.dia / 2),
  },
  // "Havşa Açma (Düz Dip)" (counterbore): a flat-bottom cylindrical recess
  // (örn. altıgen başlı vida için) -- geometrically just a shallow, wide
  // circPocket, so it reuses that exact same PocketShape/ZigZagOffset
  // machinery (see counterboreOpPy's own comment in
  // stockCamGenerateService.js) rather than inventing anything new.
  counterbore: {
    label: "Havşa Açma (Düz Dip)",
    params: [
      { name: "dia", label: "Çap", unit: "mm", type: "number", min: 1, max: 200 },
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
      // Opt-in (default 0 = off): only meaningful when depth fully severs
      // the part from the stock (depth >= stock height) -- see
      // contourOpPy's own comment for why this defaults off rather than on.
      { name: "tabs", label: "Tutucu Köprü Sayısı", unit: "", type: "number", default: 0, min: 0, max: 20 },
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


// ---------------------------------------------------------------------------
// TORNA (lathe) operations. Everything above this point is milling: a
// prismatic W x D x H block, X/Y a flat footprint, Z the cutting depth.
// Turning is a genuinely different geometry AND a different axis
// convention, so lathe operations get their own entries rather than being
// bent onto the milling ones:
//
//   * Stock is a CYLINDER -- { dia, len } instead of { w, d, h }.
//   * X is RADIAL and, by universal turning convention, is programmed as a
//     DIAMETER (X20 means "20mm diameter", i.e. 10mm from the spindle
//     axis) -- so every X-ish parameter here is named `...Dia`, never a
//     radius, and the G-code generator is the only place a radius ever
//     appears (see latheGcodeService.js).
//   * Z is AXIAL. Z0 is the RAW stock's right-hand (free) end face, the
//     face the operator physically touches off on; material extends in the
//     -Z direction toward the chuck, which is at Z = -len.
//
// Operator-facing parameters deliberately avoid negative numbers: the
// wizard asks for POSITIVE DISTANCES from that end face (`startZ`,
// `length`, `posZ`, `depth`) and latheGcodeService.js negates them once,
// in one place, when it emits real ISO G-code. A shop owner describing a
// job says "40mm boyunca 30 çapa düşür", never "Z-40'a kadar".
// ---------------------------------------------------------------------------

// ISO 68-1 metric thread: the external thread's own height h3 = 0.6134 * P
// (DIN 13), so the minor (root) diameter of a d x P thread is
// d - 2*h3 = d - 1.2268*P. Real published geometry, not a guess -- used
// both by validation here (a thread whose root would fall below zero is
// physically impossible) and by the G76 cycle's own depth words.
export const THREAD_HEIGHT_FACTOR = 0.6134;

export function latheThreadMinorDia(majorDia, pitch) {
  return Number(majorDia) - 2 * THREAD_HEIGHT_FACTOR * Number(pitch);
}

export const LATHE_OPERATION_TYPES = Object.freeze({
  latheFace: {
    machine: "lathe",
    label: "Alın Tornalama",
    params: [
      { name: "depth", label: "Alından Alınacak Boy", unit: "mm", type: "number", min: 0.05, max: 200 },
    ],
  },
  latheTurn: {
    machine: "lathe",
    label: "Çap Düşürme (Boyuna Tornalama)",
    params: [
      { name: "targetDia", label: "Hedef Çap", unit: "mm", type: "number", min: 0.5, max: 1000 },
      { name: "startZ", label: "Alından Başlangıç Mesafesi", unit: "mm", type: "number", default: 0, min: 0, max: 3000 },
      { name: "length", label: "İşlenecek Boy", unit: "mm", type: "number", min: 0.5, max: 3000 },
    ],
  },
  latheTaper: {
    machine: "lathe",
    label: "Konik Tornalama",
    params: [
      { name: "startDia", label: "Başlangıç Çapı", unit: "mm", type: "number", min: 0.5, max: 1000 },
      { name: "endDia", label: "Bitiş Çapı", unit: "mm", type: "number", min: 0.5, max: 1000 },
      { name: "startZ", label: "Alından Başlangıç Mesafesi", unit: "mm", type: "number", default: 0, min: 0, max: 3000 },
      { name: "length", label: "Konik Boyu", unit: "mm", type: "number", min: 0.5, max: 3000 },
    ],
  },
  latheGroove: {
    machine: "lathe",
    label: "Kanal Açma",
    params: [
      { name: "width", label: "Kanal Genişliği", unit: "mm", type: "number", min: 0.5, max: 200 },
      { name: "depth", label: "Kanal Derinliği (yarıçapta)", unit: "mm", type: "number", min: 0.1, max: 500 },
      { name: "posZ", label: "Alından Kanal Başlangıcı", unit: "mm", type: "number", min: 0, max: 3000 },
    ],
  },
  latheDrill: {
    machine: "lathe",
    label: "Eksenden Delme",
    params: [
      { name: "dia", label: "Matkap Çapı", unit: "mm", type: "number", min: 0.5, max: 200 },
      { name: "depth", label: "Delik Derinliği", unit: "mm", type: "number", min: 0.5, max: 2000 },
    ],
  },
  latheThread: {
    machine: "lathe",
    label: "Diş Açma (Dış Vida)",
    params: [
      { name: "majorDia", label: "Diş Dış Çapı (ör. M20 için 20)", unit: "mm", type: "number", min: 1, max: 500 },
      { name: "pitch", label: "Diş Adımı (Pitch)", unit: "mm", type: "number", min: 0.2, max: 12 },
      { name: "startZ", label: "Alından Diş Başlangıcı", unit: "mm", type: "number", default: 0, min: 0, max: 3000 },
      { name: "length", label: "Diş Boyu", unit: "mm", type: "number", min: 1, max: 1000 },
    ],
  },
});

export function isLatheOperation(type) {
  return Object.prototype.hasOwnProperty.call(LATHE_OPERATION_TYPES, type);
}

// A plan's stock is a cylinder ({dia,len}) for turning and a block
// ({w,d,h}) for milling -- one field decides which, everywhere, so no
// caller ever has to guess from context.
export function isLatheStock(stock) {
  return Number.isFinite(Number(stock?.dia)) && Number.isFinite(Number(stock?.len));
}

// How close to the chuck a cut may get before it stops being shop-safe
// (jaws, and the unsupported overhang beyond them). Not a hard geometric
// limit -- validation rejects only what is physically impossible (past the
// bar's own end); latheGcodeService.js raises this one as a WARNING, since
// a short part held in a collet legitimately gets machined much closer to
// the jaws than a long bar sticking out of a 3-jaw chuck.
export const LATHE_CHUCK_CLEARANCE_MM = 20;

// Axial extent (distance from the Z0 end face) each lathe operation
// reaches, so the "does it still fit on the bar" check is written once.
export function latheAxialExtent(type, p) {
  if (type === "latheFace") return Number(p.depth) || 0;
  if (type === "latheDrill") return Number(p.depth) || 0;
  if (type === "latheGroove") return (Number(p.posZ) || 0) + (Number(p.width) || 0);
  return (Number(p.startZ) || 0) + (Number(p.length) || 0);
}

// Turning-specific bounds: everything the shared numeric-range loop above
// can't express, checked against the CYLINDRICAL stock. Returns Turkish,
// operator-facing problem strings (same contract as the milling branch).
function validateLatheBounds(type, p, stock) {
  const problems = [];
  const dia = Number(stock?.dia), len = Number(stock?.len);
  if (!Number.isFinite(dia) || !Number.isFinite(len) || dia <= 0 || len <= 0) {
    return ["Stok boyutları geçersiz — önce stok çapını ve boyunu ayarlayın."];
  }
  const radius = dia / 2;

  const extent = latheAxialExtent(type, p);
  if (extent > len + 1e-6) {
    problems.push(`İşlem stok boyunu aşıyor: Z yönünde ${extent.toFixed(1)}mm gerekiyor, stok boyu ${len}mm.`);
  }

  if (type === "latheFace") {
    // Facing away the whole bar would leave nothing to hold or machine.
    if (Number(p.depth) >= len) {
      problems.push(`Alından alınacak boy (${p.depth}mm) stok boyundan (${len}mm) küçük olmalı.`);
    }
  }

  if (type === "latheTurn") {
    if (Number(p.targetDia) >= dia - 1e-6) {
      problems.push(`Hedef çap (${p.targetDia}mm) stok çapından (${dia}mm) küçük olmalı — bu işlem talaş kaldırmaz.`);
    }
  }

  if (type === "latheTaper") {
    for (const [field, label] of [["startDia", "Başlangıç çapı"], ["endDia", "Bitiş çapı"]]) {
      if (Number(p[field]) > dia + 1e-6) {
        problems.push(`${label} (${p[field]}mm) stok çapından (${dia}mm) büyük olamaz.`);
      }
    }
    if (Math.abs(Number(p.startDia) - Number(p.endDia)) < 1e-6) {
      problems.push("Başlangıç ve bitiş çapı aynı — bu bir konik değil, düz tornalama (Çap Düşürme) işlemidir.");
    }
  }

  if (type === "latheGroove") {
    // Leave a real core behind: a groove cut to (or past) the centreline is
    // a PARTING cut, a different operation with its own tool and its own
    // safety rules -- never something this op should silently become.
    if (Number(p.depth) > radius - 0.5) {
      problems.push(
        `Kanal derinliği (${p.depth}mm) çok fazla — stok yarıçapı ${radius}mm, en az 0.5mm göbek kalmalı ` +
        `(parça kesme/parçalama işlemi bu işlemle yapılmaz).`,
      );
    }
  }

  if (type === "latheDrill") {
    if (Number(p.dia) >= dia - 1e-6) {
      problems.push(`Matkap çapı (${p.dia}mm) stok çapından (${dia}mm) küçük olmalı.`);
    }
  }

  if (type === "latheThread") {
    const major = Number(p.majorDia), pitch = Number(p.pitch);
    if (major > dia + 1e-6) {
      problems.push(`Diş dış çapı (${major}mm) stok çapından (${dia}mm) büyük olamaz.`);
    }
    const minor = latheThreadMinorDia(major, pitch);
    if (minor <= 0.5) {
      problems.push(
        `M${major} x ${pitch} dişin diş dibi çapı ${minor.toFixed(2)}mm çıkıyor — bu adım bu çap için çok kaba, ` +
        `daha küçük bir diş adımı seçin.`,
      );
    }
  }

  return problems;
}

// The single registry every caller looks an operation type up in --
// milling and turning entries share one namespace (the type names
// themselves are already unambiguous: `drill` is a milling hole, `latheDrill`
// is drilling on the lathe's centreline), so nothing outside this file has
// to know which machine a type belongs to just to validate or label it.
export const OPERATION_TYPES = Object.freeze({ ...MILL_OPERATION_TYPES, ...LATHE_OPERATION_TYPES });

// `machine` ("mill" | "lathe") narrows the menu to the operations that
// physically make sense on that machine; omitting it lists everything
// (unchanged behaviour for callers that predate turning support).
export function listOperationTypes(machine) {
  return Object.entries(OPERATION_TYPES)
    .filter(([, def]) => !machine || (def.machine || "mill") === machine)
    .map(([type, def]) => ({
      type,
      label: def.label,
      params: def.params,
      machine: def.machine || "mill",
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

  // Turning and milling can't be mixed inside one plan: the stock isn't even
  // the same SHAPE (cylinder vs block), so an operation aimed at the wrong
  // one is rejected outright rather than bounds-checked against dimensions
  // that don't exist.
  if (isLatheOperation(type)) {
    if (!isLatheStock(stock)) {
      return ["Bu işlem bir TORNA işlemi — freze (prizmatik) stoğa uygulanamaz. Torna sekmesinden yeni bir plan başlatın."];
    }
    const latheNorm = {};
    for (const field of def.params) latheNorm[field.name] = Number(params[field.name] ?? field.default ?? 0);
    return validateLatheBounds(type, latheNorm, stock);
  }
  if (isLatheStock(stock)) {
    return ["Bu işlem bir FREZE işlemi — torna (silindirik) stoğa uygulanamaz. Freze sekmesinden yeni bir plan başlatın."];
  }

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

// `material` drives feed/speed selection (stockCamGenerateService.js's
// feedSpeedFor) for every operation in this plan -- the client is expected
// to always ask before stock size (see cnc-sim.html's setup-stage
// sequencing), but a missing/unrecognized value here falls back to
// "steel" (a moderate, safe default) rather than rejecting the plan.
export function createPlan(stock, material) {
  const planKey = randomUUID();
  // The stock's own SHAPE decides which machine this plan is for -- a
  // cylinder ({dia,len}) is a turning job, a block ({w,d,h}) a milling one.
  // Stored explicitly as `machine` so every downstream consumer (generator,
  // cost, setup sheet, tool checklist) can branch on one plain field instead
  // of re-sniffing the stock's keys.
  const lathe = isLatheStock(stock);
  plans.set(planKey, {
    planKey,
    machine: lathe ? "lathe" : "mill",
    stock: lathe
      ? { dia: Number(stock.dia) || 60, len: Number(stock.len) || 200 }
      : { w: Number(stock?.w) || 100, d: Number(stock?.d) || 100, h: Number(stock?.h) || 20 },
    material: typeof material === "string" && material ? material : "steel",
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

// Otomatik Takım Sıralama: persists a NEW ordering of the plan's existing
// operations (by id) — never adds, removes, or edits any operation's own
// type/params. Rejects anything that isn't an exact permutation of the
// plan's current operation ids (missing, duplicated, or foreign ids) rather
// than guessing what the caller meant; the route layer (Faz X) still
// re-verifies the reordered plan via a real FreeCAD rebuild before ever
// calling this, same discipline as replaceOperation.
export function reorderOperations(planKey, orderedIds) {
  const plan = plans.get(planKey);
  if (!plan) return { ok: false, problems: ["Plan bulunamadı."] };
  if (!Array.isArray(orderedIds) || orderedIds.length !== plan.operations.length) {
    return { ok: false, problems: ["Sıralama listesi geçersiz."] };
  }
  if (new Set(orderedIds).size !== plan.operations.length) {
    return { ok: false, problems: ["Sıralama listesinde yinelenen işlem var."] };
  }
  const byId = new Map(plan.operations.map((o) => [o.id, o]));
  const reordered = [];
  for (const id of orderedIds) {
    const op = byId.get(id);
    if (!op) return { ok: false, problems: ["Sıralama listesi mevcut işlemlerle eşleşmiyor."] };
    reordered.push(op);
  }
  plan.operations = reordered;
  touch(plan);
  return { ok: true, operations: plan.operations.map((o) => ({ ...o })) };
}

// İşlem Notları: pure shop-floor metadata on an already-confirmed operation
// (e.g. "ince cidar, yavaş ilerle") -- never touches `params`, so it can
// never affect what actually gets machined. Deliberately synchronous, no
// FreeCAD re-verify (unlike replaceOperation/reorderOperations, which DO
// change geometry or cutting order): a note can never make a previously
// safe plan unsafe. An empty/blank note clears it rather than storing an
// empty string.
export function setOperationNote(planKey, opId, note) {
  const plan = plans.get(planKey);
  if (!plan) return { ok: false, problems: ["Plan bulunamadı."] };
  const op = plan.operations.find((o) => o.id === opId);
  if (!op) return { ok: false, problems: ["İşlem bulunamadı."] };
  const trimmed = String(note ?? "").trim();
  if (trimmed) op.note = trimmed;
  else delete op.note;
  touch(plan);
  return { ok: true, operation: { ...op } };
}

// Faz X: the setup-sheet route persists the most recent FreeCAD time
// estimate here (from confirm/edit's own verifyStockPlan call) so the
// printable job sheet can show a real total without triggering its own,
// separate FreeCAD rebuild -- purely informational, never read by anything
// that affects what actually gets machined.
export function setLastEstimatedMinutes(planKey, minutes) {
  const plan = plans.get(planKey);
  if (plan && Number.isFinite(minutes)) plan.lastEstimatedMinutes = minutes;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, plan] of plans) {
    if (now - plan.updatedAt > PLAN_TTL_MS) plans.delete(key);
  }
}, 10 * 60 * 1000).unref();
