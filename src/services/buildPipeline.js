import { runGeneratedCodeAndExport } from "./exportService.js";
import { checkDimensions } from "./dimensionCheck.js";

// The shared "make a model" loop used by both the text (/generate) and image
// (/generate-from-image) routes. Each attempt runs a SINGLE FreeCAD round-trip
// (reset -> run code -> export STEP/STL -> read bounding box) and then verifies
// the box against the requested dimensions. On any failure it feeds the problem
// back to the generator for a self-correcting retry (HANDOFF #11).
//
// The technical-drawing PDF is intentionally NOT produced here: it is the slowest
// FreeCAD operation and is generated on demand via /generate-pdf so the model
// returns as fast as possible.
const MAX_ATTEMPTS = 3;

/**
 * @param {object} opts
 * @param {(correction?: {previousCode: string, problem: string}) => Promise<string>} opts.generate
 *        Produces FreeCAD Python; called again with correction context on retry.
 * @param {string} [opts.verifyPrompt] Text used to extract expected dimensions.
 *        Empty (image flow) means the dimension check is a no-op.
 * @returns {Promise<{ok: boolean, generatedCode?: string, stepPath?: string,
 *   stlPath?: string, bbox?: object, warning?: string,
 *   error?: string, lastError?: string}>}
 */
export async function runBuildPipeline({ generate, verifyPrompt = "" }) {
  let previousCode = null;
  let problem = null;
  let lastError = "Bilinmeyen hata";
  let lastCode = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_ATTEMPTS;
    const correction = previousCode ? { previousCode, problem } : undefined;

    // 1. Generate (or re-generate with correction context).
    let code;
    try {
      code = await generate(correction);
    } catch (err) {
      lastError = err.message;
      // Nothing runnable came back (prose/empty/timeout). Retry fresh.
      previousCode = null;
      problem = null;
      continue;
    }
    lastCode = code;

    // 2. Run + export + measure in a single FreeCAD call. runGeneratedCodeAndExport
    // throws only on a transient MCP fault (timeout/transport); it returns
    // {ok:false} for a code/export error with the traceback text so we can feed it
    // back to the generator. Keep both inside the loop so a hiccup burns one
    // attempt and retries instead of escaping as a 500.
    let out;
    try {
      out = await runGeneratedCodeAndExport(code);
    } catch (err) {
      lastError = err.message;
      previousCode = code;
      problem = `FreeCAD ile iletisimde gecici bir hata olustu:\n${err.message}`;
      continue;
    }
    if (!out.ok) {
      lastError = out.error;
      previousCode = code;
      problem = `FreeCAD kodunu calistirirken/disari aktarirken hata olustu:\n${out.error}`;
      continue;
    }

    // 3. Verify the real bounding box against the requested dimensions.
    const bbox = out.bbox ?? {};
    const check = checkDimensions(verifyPrompt, bbox);

    if (!check.ok && !isLastAttempt) {
      lastError = check.reason;
      previousCode = code;
      problem = check.reason;
      continue;
    }

    // 4. Success. PDF is deferred to /generate-pdf.
    return {
      ok: true,
      generatedCode: code,
      stepPath: out.stepPath,
      stlPath: out.stlPath,
      bbox,
      // If we're shipping on the final attempt despite a dimension mismatch,
      // surface it rather than silently returning a wrong-sized part.
      warning: check.ok ? undefined : check.reason,
    };
  }

  return { ok: false, error: "Model uretilemedi", lastError, generatedCode: lastCode };
}
