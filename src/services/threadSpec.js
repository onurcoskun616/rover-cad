// Metric coarse-thread tap-drill (minor) diameters in mm. For tapping this is
// the pilot/tap-drill size; for internal thread milling the pre-drill is the
// same minor diameter, so this table serves both methods.
const TAP_DRILL_MM = {
  3: 2.5,
  4: 3.3,
  5: 4.2,
  6: 5.0,
  8: 6.8,
  10: 8.5,
  12: 10.2,
  14: 12.0,
  16: 14.0,
  18: 15.5,
  20: 17.5,
  22: 19.5,
  24: 21.0,
};

// Turkish/English fastener/thread words that should force the CAM assistant mode
// even without an explicit "M<n>" size.
const THREAD_KEYWORDS =
  /(somun|c[ıi]vata|vida|k[ıi]lavuz|\bbolt\b|\bnut\b|\bscrew\b|\bthread\b|\btap\b)/i;

// "diş" (thread) matched as a whole word so it doesn't fire on "dış" (outer
// surface, spelled with ı) or on substrings like "endişe". JS \b is ASCII-only,
// so the "ş" boundary is handled with explicit delimiters instead.
const THREAD_DIS = /(^|\s)diş(li|ler|leri)?(\s|$|[.,;:!?)])/i;

/**
 * Scan free text (prompt, generated code, dimensions) for metric thread features.
 * @param {string} text
 * @returns {{hasThread: boolean, sizes: number[]}} sizes are nominal diameters
 *   (e.g. [6, 8]) limited to entries present in the tap-drill table.
 */
export function detectThreads(text) {
  if (!text || typeof text !== "string") {
    return { hasThread: false, sizes: [] };
  }

  const sizes = new Set();
  // M6, m8, M10x1.5, M12 x 1.75 ...
  const re = /\bM\s?(\d{1,2})(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?\b/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const d = Number(match[1]);
    if (TAP_DRILL_MM[d] !== undefined) sizes.add(d);
  }

  const hasThread =
    sizes.size > 0 || THREAD_KEYWORDS.test(text) || THREAD_DIS.test(text);
  return { hasThread, sizes: [...sizes].sort((a, b) => a - b) };
}

/** Tap-drill / pilot diameter (mm) for a nominal metric size, or null. */
export function tapDrillDiameter(nominal) {
  return TAP_DRILL_MM[nominal] ?? null;
}

/**
 * Decide the threading method from the machinist's answers.
 * @param {object} answers
 * @returns {"tapping"|"thread-milling"|null}
 */
export function detectThreadMethod(answers) {
  const text = Object.values(answers ?? {})
    .map(String)
    .join(" ")
    .toLowerCase();
  if (/frez|thread\s*mill/.test(text)) return "thread-milling";
  if (/tap|k[ıi]lavuz/.test(text)) return "tapping";
  return null;
}

// The fixed assistant question offered whenever threads are detected.
export const THREAD_METHOD_QUESTION = {
  question: "Kılavuz çekme mi (tap) yoksa diş frezeleme mi (thread milling) kullanılacak?",
  options: ["Kılavuz çekme (tap)", "Diş frezeleme (thread milling)"],
};

/**
 * Build the deterministic thread-machining guidance block appended to the plan
 * and code-generation prompts. Includes the computed pilot diameters so both the
 * human-readable plan and the generated G-code use the correct hole sizes.
 * @param {number[]} sizes nominal metric sizes
 * @param {"tapping"|"thread-milling"|null} method
 * @returns {string} "" when there is nothing to say
 */
export function threadGuidanceBlock(sizes, method) {
  const known = (sizes ?? []).filter((s) => TAP_DRILL_MM[s] !== undefined);
  if (known.length === 0) return "";

  const table = known
    .map((s) => `- M${s} -> pilot (kilavuz) delik capi ${TAP_DRILL_MM[s]} mm`)
    .join("\n");

  let methodLine;
  if (method === "thread-milling") {
    methodLine =
      "Yontem: DIS FREZELEME (thread milling). Pilot delikleri yukaridaki minor capta del, " +
      "ardindan her delige helisel dis frezeleme operasyonu ekle.";
  } else if (method === "tapping") {
    methodLine =
      "Yontem: KILAVUZ CEKME (tap). Pilot delikleri TAM olarak yukaridaki tap-drill caplarinda del; " +
      "dis, delme sonrasi kilavuz ile acilacak.";
  } else {
    methodLine =
      "Yontem belirtilmedi; pilot delikleri yukaridaki caplarda del.";
  }

  return (
    "\n[DIS_ISLEME]: Bu parcada metrik disler var. Metrik kaba dis tablosuna gore pilot delik caplari:\n" +
    table +
    "\n" +
    methodLine +
    "\nDelme operasyonlarinda takim/delik capini yukaridaki pilot caplara ESITLE."
  );
}
