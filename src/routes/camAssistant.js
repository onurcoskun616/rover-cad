import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  generateCamPlan,
  generateCamPreview,
  generateCamGcodeFromPlan,
} from "../services/camAssistantService.js";
import { analyzeManufacturability } from "../services/camService.js";
import { getNextCamStep } from "../services/camWizardService.js";
import { effectiveAnswers } from "../services/inventoryService.js";
import { computeQuote, generateQuotePdf, resolveQuoteInputs } from "../services/quoteService.js";
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

// Üretilebilirlik Analizi (DFM): real B-Rep geometry checks (deep/narrow
// holes, undersized internal-corner fillets) run right after upload, before
// the wizard -- see analyzeManufacturability (camService.js) for exactly
// what is and isn't checked. Async (polled via /jobs/:id) for the same
// reason every other FreeCAD-touching route here is: a real MCP round-trip
// can exceed Cloudflare's 100s edge timeout. `exclusive: true` for the same
// reason as /cam-plan below -- it force-closes whatever document the shared
// FreeCAD GUI process currently has open.
router.post("/dfm-analyze", apiKeyAuth, (req, res) => {
  const stepPath = requireStepPath(req, res);
  if (!stepPath) return;
  const jobId = createJob();
  runJob(jobId, async () => {
    const dfm = await analyzeManufacturability(stepPath);
    return { ok: true, body: { dfm } };
  }, { exclusive: true });
  res.status(202).json({ jobId });
});

// Step 2: sequential wizard. Given the answers so far, return the next step to
// ask (its recommendations shaped by earlier answers), or { done: true } once
// everything needed is collected. Stateless — the client resends all answers.
router.post("/cam-step", apiKeyAuth, async (req, res, next) => {
  try {
    const stepPath = requireStepPath(req, res);
    if (!stepPath) return;
    const { prompt, answers, targetIndex } = req.body ?? {};
    const result = await getNextCamStep(
      stepPath,
      typeof prompt === "string" ? prompt : "",
      answers && typeof answers === "object" ? answers : {},
      Number.isInteger(targetIndex) ? targetIndex : undefined,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Step 3: draft (or revise) a human-readable machining plan from the answers.
// Async (polled via /jobs/:id) because the Claude CLI call can exceed
// Cloudflare's 100s edge timeout.
router.post("/cam-plan", apiKeyAuth, (req, res) => {
  const stepPath = requireStepPath(req, res);
  if (!stepPath) return;
  const { answers, previousPlan, changeRequest, prompt } = req.body ?? {};

  const jobId = createJob();

  // generateCamPlan -> describeStepGeometry talks to the SAME shared FreeCAD
  // MCP connection every other route uses, and its setup code force-closes
  // whatever document is currently open before opening its own (camService.js
  // stepInsertPy). Without `exclusive: true` this could run concurrently with
  // another in-progress FreeCAD job (a model build, a CAM simulate/confirm)
  // and yank the document out from under it mid-operation — every other
  // FreeCAD-touching route in this codebase already runs exclusive; this one
  // was the sole exception.
  runJob(jobId, async () => {
    const plan = await generateCamPlan(stepPath, answers ?? {}, {
      previousPlan,
      changeRequest,
      context: typeof prompt === "string" ? prompt : "",
    });
    return { ok: true, body: { plan } };
  }, { exclusive: true });

  res.status(202).json({ jobId });
});

// Step 4: build the Path operations and export the TOOLPATH SIMULATION data
// (ordered tool positions per operation; no G-code yet). Async (polled via
// /jobs/:id). Returns the simulation file URL to animate plus a token so the
// confirm step can reuse the exact same operations.
router.post("/cam-simulate", apiKeyAuth, (req, res) => {
  const stepPath = requireStepPath(req, res);
  if (!stepPath) return;
  const { answers, plan, prompt } = req.body ?? {};
  if (!plan || typeof plan !== "object") {
    return res.status(400).json({ error: "plan is required" });
  }

  const context = typeof prompt === "string" ? prompt : "";
  const proto = req.protocol;
  const host = req.get("host");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await generateCamPreview(stepPath, answers ?? {}, plan, context);
      return {
        ok: true,
        body: {
          token: result.token,
          simulationUrl: makeFileUrl(proto, host, result.previewPath),
          estimatedMinutes: result.estimatedMinutes,
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

// Step 5: only AFTER the user approves the previewed toolpath, post-process it
// into G-code. Reuses the approved operations via `token` so the exported
// G-code matches the preview exactly. Async (polled via /jobs/:id).
router.post("/cam-confirm", apiKeyAuth, (req, res) => {
  const stepPath = requireStepPath(req, res);
  if (!stepPath) return;
  const { answers, plan, prompt, token } = req.body ?? {};
  if (!plan || typeof plan !== "object") {
    return res.status(400).json({ error: "plan is required" });
  }

  const context = typeof prompt === "string" ? prompt : "";
  const proto = req.protocol;
  const host = req.get("host");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      const result = await generateCamGcodeFromPlan(
        stepPath,
        answers ?? {},
        plan,
        context,
        typeof token === "string" ? token : null,
      );
      return {
        ok: true,
        body: {
          gcodePath: result.gcodePath,
          gcodeUrl: makeFileUrl(proto, host, result.gcodePath),
          safetyChecks: result.safetyChecks,
          warning: result.warning ?? null,
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

// Quote/cost engine: compute a cost breakdown from the estimated machining time
// (from the preview) + user cost inputs, and render a "Teklif Formu" PDF.
// Synchronous (no FreeCAD/LLM): arithmetic + a quick PDF write.
router.post("/cam-quote", apiKeyAuth, async (req, res, next) => {
  try {
    const { mode, minutes, answers, bbox, inputs, partName, material, useCatalogDefaults } = req.body ?? {};
    const quoteMode = mode === "detayli" ? "detayli" : "basit";
    const eff = effectiveAnswers(answers && typeof answers === "object" ? answers : {});
    const quoteInputs = resolveQuoteInputs({
      mode: quoteMode,
      inputs: inputs && typeof inputs === "object" ? inputs : {},
      material: material ?? eff?.material,
      machineHourlyRate: eff._machineHourlyRate,
      useCatalogDefaults: useCatalogDefaults === true,
    });
    const quote = computeQuote({
      mode: quoteMode,
      minutes: Number(minutes) || 0,
      answers: eff,
      bbox: bbox && typeof bbox === "object" ? bbox : {},
      inputs: quoteInputs,
    });
    const pdfPath = await generateQuotePdf({
      partName: typeof partName === "string" ? partName : "",
      bbox: bbox ?? {},
      material: typeof material === "string" ? material : answers?.material,
      quote,
    });
    res.json({
      quote,
      pdfUrl: makeFileUrl(req.protocol, req.get("host"), pdfPath),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
