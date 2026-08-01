import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  generateCamQuestions,
  generateCamPlan,
  generateCamGcodeFromPlan,
} from "../services/camAssistantService.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

function requireStepPath(req, res) {
  const { stepPath } = req.body ?? {};
  if (typeof stepPath !== "string" || stepPath.trim().length === 0) {
    res.status(400).json({ error: "stepPath is required and must be a non-empty string" });
    return null;
  }
  return stepPath;
}

// This router is mounted at "/" so its three endpoints keep their exact paths.
// Because "/" matches everything, apiKeyAuth is applied per-route (not via
// router.use) so unrelated requests — e.g. the public /files static downloads —
// fall through untouched instead of being caught by a router-wide auth gate.
const router = Router();

// Step 2: questions the machinist must answer before planning.
router.post("/cam-questions", apiKeyAuth, async (req, res, next) => {
  try {
    const stepPath = requireStepPath(req, res);
    if (!stepPath) return;
    const questions = await generateCamQuestions(stepPath);
    res.json({ questions });
  } catch (err) {
    next(err);
  }
});

// Step 3: draft (or revise) a human-readable machining plan from the answers.
router.post("/cam-plan", apiKeyAuth, async (req, res, next) => {
  try {
    const stepPath = requireStepPath(req, res);
    if (!stepPath) return;
    const { answers, previousPlan, changeRequest } = req.body ?? {};
    const plan = await generateCamPlan(stepPath, answers ?? {}, {
      previousPlan,
      changeRequest,
    });
    res.json({ plan });
  } catch (err) {
    next(err);
  }
});

// Step 4: on approval, build real Path operations and export GRBL G-code. Async
// (polled via /jobs/:id): this runs the Claude CLI plus FreeCAD Path ops with a
// retry loop and can easily exceed Cloudflare's 100s limit.
router.post("/cam-confirm", apiKeyAuth, (req, res) => {
  const stepPath = requireStepPath(req, res);
  if (!stepPath) return;
  const { answers, plan } = req.body ?? {};
  if (!plan || typeof plan !== "object") {
    return res.status(400).json({ error: "plan is required" });
  }

  const proto = req.protocol;
  const host = req.get("host");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await generateCamGcodeFromPlan(stepPath, answers ?? {}, plan);
      return {
        ok: true,
        body: {
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
