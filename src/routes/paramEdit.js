import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { runParamEdit, parseParams } from "../services/paramEditService.js";
import { createJob, runJob } from "../services/jobStore.js";
import { archiveProjectBuildFailOpen } from "../services/projectArchiveService.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

router.post("/", (req, res) => {
  const { code, paramName, newValue, projectId, projectName, basePrompt } = req.body ?? {};

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "code is required" });
  }
  if (typeof paramName !== "string" || !paramName.trim()) {
    return res.status(400).json({ error: "paramName is required" });
  }
  if (typeof newValue !== "number" || !Number.isFinite(newValue)) {
    return res.status(400).json({ error: "newValue must be a finite number" });
  }

  const params = parseParams(code);
  const param = params.find((p) => p.name === paramName);
  if (!param) {
    return res.status(400).json({
      error: `Parametre bulunamadi: ${paramName}`,
      availableParams: params.map((p) => p.name),
    });
  }

  const proto = req.protocol;
  const host = req.get("host");
  const userId = req.user?.id ?? null;
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await runParamEdit(code, paramName, newValue);

      if (!result.ok) {
        return {
          ok: false,
          body: { error: result.error, generatedCode: result.generatedCode },
        };
      }

      const archived = archiveProjectBuildFailOpen({
        userId,
        projectId,
        projectName,
        operation: "cad-param-edit",
        prompt: `${basePrompt || "Parametrik düzenleme"}; ${paramName}=${newValue}`,
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
