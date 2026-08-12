import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  promptToFreecadCode,
  promptToFreecadCodeRevision,
} from "../services/promptToCodeService.js";
import { runBuildPipeline } from "../services/buildPipeline.js";
import { createJob, runJob } from "../services/jobStore.js";
import { archiveProjectBuildFailOpen } from "../services/projectArchiveService.js";
import { setLlmFeature } from "../services/llmRequestContext.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

// Iterative editing: takes the current design's code plus a change request and
// rebuilds an updated model. Async (polled via /jobs/:id) like /generate.
router.post("/", (req, res) => {
  const { prompt, previousCode, basePrompt, projectId, projectName } = req.body ?? {};

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
  setLlmFeature(prompt.replace(/\s+/g, " ").trim());

  const base = typeof basePrompt === "string" ? basePrompt : "";
  const proto = req.protocol;
  const host = req.get("host");
  const userId = req.user?.id ?? null;
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

      const archived = archiveProjectBuildFailOpen({
        userId,
        projectId,
        projectName,
        operation: "cad-revise",
        prompt: base ? `${base} ; ${prompt}` : prompt,
        generatedCode: result.generatedCode,
        stepPath: result.stepPath,
        stlPath: result.stlPath,
        bbox: result.bbox,
      });

      return {
        ok: true,
        body: {
          stepPath: result.stepPath,
          stlPath: result.stlPath,
          stepUrl: makeFileUrl(proto, host, result.stepPath),
          stlUrl: makeFileUrl(proto, host, result.stlPath),
          bbox: result.bbox,
          anchors: result.anchors,
          center: result.center,
          warning: result.warning,
          generatedCode: result.generatedCode,
          ...(archived ?? {}),
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

export default router;
