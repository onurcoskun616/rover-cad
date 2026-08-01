import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  exportTechDrawPdfFromStep,
  parseRoverDimensions,
} from "../services/exportService.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

// On-demand technical-drawing PDF. Kept off the /generate hot path because
// TechDraw rendering is the slowest FreeCAD operation. Expects the STEP produced
// by a previous /generate, plus the bbox (for view scale) and generated code
// (to recover the ROVER_DIMENSIONS table) returned by that same call. Async
// (polled via /jobs/:id) since TechDraw can exceed Cloudflare's 100s limit.
router.post("/", (req, res) => {
  const { stepPath, bbox, code } = req.body ?? {};
  if (typeof stepPath !== "string" || stepPath.trim().length === 0) {
    return res
      .status(400)
      .json({ error: "stepPath is required and must be a non-empty string" });
  }

  const proto = req.protocol;
  const host = req.get("host");
  const dimensions = parseRoverDimensions(code ?? "");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await exportTechDrawPdfFromStep(stepPath, bbox ?? {}, dimensions);
      if (!result.pdfPath) {
        return { ok: false, body: { error: result.error ?? "PDF olusturulamadi" } };
      }
      return {
        ok: true,
        body: {
          pdfPath: result.pdfPath,
          pdfUrl: makeFileUrl(proto, host, result.pdfPath),
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

export default router;
