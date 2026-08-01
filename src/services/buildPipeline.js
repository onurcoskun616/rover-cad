import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";
import {
  resetActiveDocument,
  exportActiveDocument,
  queryBoundingBox,
  exportTechDrawPdf,
  parseRoverDimensions,
} from "./exportService.js";
import { checkDimensions } from "./dimensionCheck.js";

// The shared "make a model" loop used by both the text (/generate) and image
// (/generate-from-image) routes. Each attempt: generate code -> reset the
// document -> run the code -> export STEP/STL -> read the real bounding box ->
// verify it matches the requested dimensions. On any failure it feeds the
// problem back to the generator for a self-correcting retry (HANDOFF #11).
const MAX_ATTEMPTS = 3;

/**
 * @param {object} opts
 * @param {(correction?: {previousCode: string, problem: string}) => Promise<string>} opts.generate
 *        Produces FreeCAD Python; called again with correction context on retry.
 * @param {string} [opts.verifyPrompt] Text used to extract expected dimensions.
 *        Empty (image flow) means the dimension check is a no-op.
 * @returns {Promise<{ok: boolean, generatedCode?: string, stepPath?: string,
 *   stlPath?: string, pdfPath?: string|null, bbox?: object, warning?: string,
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

    // 2. Run it in a fresh document.
    await resetActiveDocument();
    const runResult = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]: code,
    });
    const runText = extractResultText(runResult);
    if (runResult?.isError || runText.startsWith("Failed to execute code")) {
      lastError = runText || "FreeCAD kodu calistiramadi";
      previousCode = code;
      problem = `FreeCAD kodunu calistirirken hata olustu:\n${runText}`;
      continue;
    }

    // 3. Export STEP/STL.
    const exported = await exportActiveDocument();
    if (!exported.stepPath && !exported.stlPath) {
      lastError = "FreeCAD disari aktarilabilir bir kati (solid) uretmedi";
      previousCode = code;
      problem =
        "Kod calisti ama disari aktarilabilir bir kati (solid) olusmadi. " +
        "Dokumana gecerli bir 3D kati ekle.";
      continue;
    }

    // 4. Read the real bounding box and verify the requested dimensions.
    let bbox = null;
    try {
      bbox = await queryBoundingBox();
    } catch {
      bbox = null;
    }
    const check = checkDimensions(verifyPrompt, bbox ?? {});

    if (!check.ok && !isLastAttempt) {
      lastError = check.reason;
      previousCode = code;
      problem = check.reason;
      continue;
    }

    // 5. Success — enrich with a TechDraw PDF (best-effort, never fatal).
    const dimensions = parseRoverDimensions(code);
    const pdf = await exportTechDrawPdf(exported.baseName, bbox ?? {}, dimensions);

    return {
      ok: true,
      generatedCode: code,
      stepPath: exported.stepPath,
      stlPath: exported.stlPath,
      pdfPath: pdf.pdfPath,
      bbox,
      // If we're shipping on the final attempt despite a dimension mismatch,
      // surface it rather than silently returning a wrong-sized part.
      warning: check.ok ? undefined : check.reason,
    };
  }

  return { ok: false, error: "Model uretilemedi", lastError, generatedCode: lastCode };
}
