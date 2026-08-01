import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { generateGcode } from "../services/camService.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

// Async: G-code generation runs FreeCAD Path ops and can exceed Cloudflare's
// 100s limit, so it's a polled job.
router.post("/", (req, res) => {
  const { stepPath } = req.body ?? {};

  if (typeof stepPath !== "string" || stepPath.trim().length === 0) {
    return res
      .status(400)
      .json({ error: "stepPath is required and must be a non-empty string" });
  }

  const proto = req.protocol;
  const host = req.get("host");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await generateGcode(stepPath);
      if (result.complex) {
        return { ok: true, body: { complex: true, message: result.message } };
      }
      return {
        ok: true,
        body: {
          complex: false,
          gcodePath: result.gcodePath,
          gcodeUrl: makeFileUrl(proto, host, result.gcodePath),
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

export default router;
