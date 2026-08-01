// Pulls the numeric dimensions the user asked for out of a free-text prompt and
// checks them against the real bounding box FreeCAD produced. This is what lets
// the build pipeline notice "you asked for 50mm but the model came out 30mm" and
// feed that back to the model for a self-correcting retry.
//
// The hard part is that a bounding box only sees the OUTER extents. Internal
// features (a bore diameter, a counter-sink, a slot depth) never show up as an
// axis length, so naively requiring every requested number to appear in the bbox
// produces constant false failures. The "anchor" logic below is the compromise
// that made this usable in practice — see checkDimensions().

// Matches a number (int or decimal, "," or "." as the decimal separator)
// immediately followed by a mm/cm/millimetre-ish unit. We deliberately only
// trust numbers that carry an explicit length unit: bare numbers in a prompt are
// too often quantities ("4 delik"), angles, or counts to treat as sizes.
const DIMENSION_RE = /(\d+(?:[.,]\d+)?)\s*(mm|cm|milimetre|millimetre|santimetre)\b/gi;

// Relative and absolute tolerance when matching a requested size to a bbox axis.
// FreeCAD tessellation + our own Part::Cut leftovers (see HANDOFF #8) mean an
// exact match is unrealistic; 2% or 0.5mm, whichever is larger, is forgiving
// enough to avoid false alarms while still catching an order-of-magnitude miss.
const REL_TOL = 0.02;
const ABS_TOL = 0.5;

// Parse every "<number><unit>" occurrence in the prompt into millimetres.
// Returns a de-duplicated, ascending list of values.
export function extractDimensions(prompt) {
  if (typeof prompt !== "string") return [];

  const values = [];
  for (const match of prompt.matchAll(DIMENSION_RE)) {
    const raw = Number(match[1].replace(",", "."));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const unit = match[2].toLowerCase();
    const mm = unit.startsWith("c") || unit.startsWith("s") ? raw * 10 : raw;
    values.push(Number(mm.toFixed(3)));
  }

  return [...new Set(values)].sort((a, b) => a - b);
}

function tolerance(value) {
  return Math.max(value * REL_TOL, ABS_TOL);
}

function matchesAnyAxis(value, axes) {
  const tol = tolerance(value);
  return axes.some((axis) => Math.abs(axis - value) <= tol);
}

function largerThanAllAxes(value, axes) {
  return axes.every((axis) => value - axis > tolerance(value));
}

/**
 * Compare the requested dimensions against a bounding box.
 *
 * @param {string} prompt        original user request
 * @param {{x:number,y:number,z:number}} bbox real bounding box lengths per axis
 * @returns {{ ok: boolean, reason?: string, expected: number[], bbox: number[] }}
 *
 * Anchor logic (the important part):
 *  - If the prompt names no dimensions at all, there is nothing to verify → ok.
 *  - Otherwise the check passes only when BOTH hold:
 *      1. At least one requested value matches one of the three bbox axes
 *         (an "anchor" — proof the model is roughly the requested scale), AND
 *      2. No requested value is larger than *every* axis (a value bigger than
 *         the whole part can't be an internal feature — it's a real miss).
 *  - Requested values that are smaller than the largest axis but match no axis
 *    are assumed to be internal features (bore/slot/etc.) and tolerated.
 */
export function checkDimensions(prompt, bbox) {
  const expected = extractDimensions(prompt);
  const axes = [bbox?.x, bbox?.y, bbox?.z]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (expected.length === 0) {
    return { ok: true, expected, bbox: axes };
  }

  if (axes.length === 0) {
    return {
      ok: false,
      reason: "Modelin sinir kutusu (bounding box) okunamadi.",
      expected,
      bbox: axes,
    };
  }

  const oversized = expected.filter((v) => largerThanAllAxes(v, axes));
  if (oversized.length > 0) {
    return {
      ok: false,
      reason:
        `Istenen olcu(ler) ${oversized.join(", ")} mm, modelin en buyuk kenarindan ` +
        `(${Math.max(...axes).toFixed(1)} mm) daha buyuk. ` +
        `Gercek sinir kutusu: ${axes.map((a) => a.toFixed(1)).join(" x ")} mm. ` +
        `Boyutlari istenen degerlere gore duzelt.`,
      expected,
      bbox: axes,
    };
  }

  const hasAnchor = expected.some((v) => matchesAnyAxis(v, axes));
  if (!hasAnchor) {
    return {
      ok: false,
      reason:
        `Istenen olculerin (${expected.join(", ")} mm) hicbiri modelin ` +
        `sinir kutusuyla (${axes.map((a) => a.toFixed(1)).join(" x ")} mm) eslesmiyor. ` +
        `Ana boyutlari istenen degerlere gore duzelt.`,
      expected,
      bbox: axes,
    };
  }

  return { ok: true, expected, bbox: axes };
}
