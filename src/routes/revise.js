import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  promptToFreecadCode,
  promptToFreecadCodeRevision,
} from "../services/promptToCodeService.js";
import { runBuildPipeline } from "../services/buildPipeline.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

// Iterative editing: takes the current design's code plus a change request and
// rebuilds an updated model. Async (polled via /jobs/:id) like /generate.
router.post("/", (req, res) => {
  const { prompt, previousCode, basePrompt } = req.body ?? {};

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return res
      .status(400)
      .json({ error: "prompt (change request) is required and must be a non-empty string" });
  }
  if (typeof previousCode !== "string" || previousCode.trim().length === 0) {
    return res
      .status(400)
      .json({ error: "previousCode is required and must be a non-empty string" });
  }

  const base = typeof basePrompt === "string" ? basePrompt : "";
  const proto = req.protocol;
  const host = req.get("host");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await runBuildPipeline({
        // First attempt: revise the existing design. On a self-correcting retry,
        // fix the failed revised code via the standard correction path.
        generate: (correction) =>
          correction
            ? promptToFreecadCode(
                `${base ? base + " ; " : ""}Degisiklik: ${prompt}`,
                correction,
              )
            : promptToFreecadCodeRevision(previousCode, prompt, base),
        // Verify against the change request so a "yüksekliği 100mm yap" is checked;
        // a request with no dimensions makes the check a no-op.
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
