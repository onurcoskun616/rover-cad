import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { promptToFreecadCode } from "../services/promptToCodeService.js";
import { runBuildPipeline } from "../services/buildPipeline.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

// Starts the model build as an async job and returns a jobId immediately. The
// build can exceed Cloudflare's 100s edge timeout, so we never hold the HTTP
// request open for it — the frontend polls GET /jobs/:id instead.
router.post("/", (req, res) => {
  const { prompt } = req.body ?? {};

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return res
      .status(400)
      .json({ error: "prompt is required and must be a non-empty string" });
  }

  const proto = req.protocol;
  const host = req.get("host");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await runBuildPipeline({
        generate: (correction) => promptToFreecadCode(prompt, correction),
        verifyPrompt: prompt,
      });

      if (!result.ok) {
        return {
          ok: false,
          body: {
            error: result.error,
            lastError: result.lastError,
            generatedCode: result.generatedCode,
          },
        };
      }

      // CAM eligibility (/generate-cam) and the technical drawing (/generate-pdf)
      // are produced on demand, so no extra FreeCAD round-trip here.
      return {
        ok: true,
        body: {
          stepPath: result.stepPath,
          stlPath: result.stlPath,
          stepUrl: makeFileUrl(proto, host, result.stepPath),
          stlUrl: makeFileUrl(proto, host, result.stlPath),
          bbox: result.bbox,
          warning: result.warning,
          generatedCode: result.generatedCode,
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

export default router;
