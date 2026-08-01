import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  exportTechDrawPdfFromStep,
  parseRoverDimensions,
} from "../services/exportService.js";

function fileUrl(req, filePath) {
  if (!filePath) return null;
  return `${req.protocol}://${req.get("host")}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

// On-demand technical-drawing PDF. Kept off the /generate hot path because
// TechDraw rendering is the slowest FreeCAD operation. Expects the STEP produced
// by a previous /generate, plus the bbox (for view scale) and generated code
// (to recover the ROVER_DIMENSIONS table) returned by that same call.
router.post("/", async (req, res, next) => {
  try {
    const { stepPath, bbox, code } = req.body ?? {};
    if (typeof stepPath !== "string" || stepPath.trim().length === 0) {
      return res
        .status(400)
        .json({ error: "stepPath is required and must be a non-empty string" });
    }

    const dimensions = parseRoverDimensions(code ?? "");
    const result = await exportTechDrawPdfFromStep(stepPath, bbox ?? {}, dimensions);

    if (!result.pdfPath) {
      return res.status(502).json({ error: result.error ?? "PDF olusturulamadi" });
    }

    res.json({
      pdfPath: result.pdfPath,
      pdfUrl: fileUrl(req, result.pdfPath),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
