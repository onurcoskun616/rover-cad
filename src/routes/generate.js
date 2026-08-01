import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { promptToFreecadCode } from "../services/promptToCodeService.js";
import { runBuildPipeline } from "../services/buildPipeline.js";

function fileUrl(req, filePath) {
  if (!filePath) return null;
  return `${req.protocol}://${req.get("host")}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

router.post("/", async (req, res, next) => {
  try {
    const { prompt } = req.body ?? {};

    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return res
        .status(400)
        .json({ error: "prompt is required and must be a non-empty string" });
    }

    const result = await runBuildPipeline({
      generate: (correction) => promptToFreecadCode(prompt, correction),
      verifyPrompt: prompt,
    });

    if (!result.ok) {
      return res.status(502).json({
        error: result.error,
        lastError: result.lastError,
        generatedCode: result.generatedCode,
      });
    }

    // The CAM button is offered for any exported part; whether it's simple or
    // complex is decided on demand by /generate-cam, so we no longer spend a
    // FreeCAD round-trip analysing geometry here. The technical drawing PDF is
    // likewise produced on demand via /generate-pdf.
    res.json({
      stepPath: result.stepPath,
      stlPath: result.stlPath,
      stepUrl: fileUrl(req, result.stepPath),
      stlUrl: fileUrl(req, result.stlPath),
      bbox: result.bbox,
      warning: result.warning,
      generatedCode: result.generatedCode,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
