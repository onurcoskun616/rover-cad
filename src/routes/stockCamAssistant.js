import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  createPlan,
  getPlan,
  confirmOperation,
  replaceOperation,
  removeOperation,
  listOperationTypes,
  validateOperationParams,
  OPERATION_TYPES,
} from "../services/stockCamPlanService.js";
import { getNextParamStep } from "../services/stockCamStepService.js";
import {
  isStockGenerationSupported,
  verifyStockPlan,
  exportStockPlanGcode,
} from "../services/stockCamGenerateService.js";
import { createJob, runJob } from "../services/jobStore.js";
import { config } from "../config.js";
import path from "node:path";

// Menu-driven, stock-based CAM plan endpoints (Faz 5 wiring): the operator
// never gets to append an operation to a plan without it having survived
// BOTH stockCamPlanService's numeric/stock-bounds validation AND (for the
// MVP-supported types) a real FreeCAD safety-checked rebuild via
// verifyStockPlan — see the module doc comment in stockCamGenerateService.js.
// FreeCAD calls go through the same createJob/runJob async-poll pattern
// every other CAM route uses, since a real FreeCAD rebuild can exceed
// Cloudflare's 100s edge timeout.

const router = Router();

function requirePlanKey(req, res) {
  const { planKey } = req.body ?? {};
  if (typeof planKey !== "string" || !planKey) {
    res.status(400).json({ error: "planKey is required" });
    return null;
  }
  return planKey;
}

router.get("/stock-cam/operation-types", apiKeyAuth, (req, res) => {
  res.json({ types: listOperationTypes() });
});

router.post("/stock-cam/plan", apiKeyAuth, (req, res) => {
  const { stock } = req.body ?? {};
  if (!stock || typeof stock !== "object") {
    return res.status(400).json({ error: "stock is required" });
  }
  const plan = createPlan(stock);
  res.json({ plan });
});

router.get("/stock-cam/plan/:planKey", apiKeyAuth, (req, res) => {
  const plan = getPlan(req.params.planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  res.json({ plan });
});

// Faz 2: one turn of the parameter-collection wizard for a chosen operation
// type. Stateless like CAM Asistanı's /cam-step — the client resends the
// accumulated answers each turn.
router.post("/stock-cam/step", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  const { opType, message, answers } = req.body ?? {};
  if (!OPERATION_TYPES[opType]) {
    return res.status(400).json({ error: `Bilinmeyen islem tipi: ${opType}` });
  }

  // Async (polled via /jobs/:id): this calls the LLM (Claude CLI), which can
  // take well over Cloudflare's ~100s edge timeout — same reason every other
  // LLM/FreeCAD-touching CAM route in this file uses createJob/runJob. A
  // synchronous await here manifests to the browser as a bare "Failed to
  // fetch" once the edge kills the connection, with no error detail at all.
  const jobId = createJob();
  runJob(jobId, async () => {
    const result = await getNextParamStep(
      opType,
      typeof message === "string" ? message : "",
      answers && typeof answers === "object" ? answers : {},
      plan.stock,
    );
    return { ok: true, body: result };
  });

  res.status(202).json({ jobId });
});

// Faz 3 support: re-validate a draft's params against the plan's stock
// on demand (e.g. after the operator hand-edits a field before confirming),
// without touching the plan itself — used to gate whether the sticker
// preview may show at all.
router.post("/stock-cam/validate", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  const { opType, params } = req.body ?? {};
  const problems = validateOperationParams(opType, params ?? {}, plan.stock);
  res.json({ problems });
});

// Faz 4/5: confirm a new operation. Async (polled via /jobs/:id) because it
// triggers a real FreeCAD rebuild of the whole plan through verifyStockPlan.
// Nothing is appended to the plan unless that rebuild comes back safe — see
// module doc comment.
router.post("/stock-cam/confirm", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  const { opType, params } = req.body ?? {};
  if (!OPERATION_TYPES[opType]) {
    return res.status(400).json({ error: `Bilinmeyen islem tipi: ${opType}` });
  }
  if (!isStockGenerationSupported(opType)) {
    return res.status(400).json({
      error: `'${OPERATION_TYPES[opType].label}' islemi henuz gercek Topkapi AI uretimini desteklemiyor.`,
    });
  }
  const problems = validateOperationParams(opType, params ?? {}, plan.stock);
  if (problems.length) {
    return res.status(400).json({ error: "Parametreler gecersiz.", problems });
  }

  const jobId = createJob();
  runJob(jobId, async () => {
    // Verify against a candidate plan (current confirmed ops + this new one)
    // BEFORE it's actually recorded — nothing enters the plan on a failed check.
    const candidate = { ...plan, operations: [...plan.operations, { id: "candidate", type: opType, params }] };
    const verify = await verifyStockPlan(candidate);
    if (!verify.ok) {
      return { ok: true, body: { confirmed: false, error: verify.error } };
    }
    const result = confirmOperation(planKey, opType, params);
    if (!result.ok) {
      // Should be unreachable (already validated above), but never silently
      // record something the plan's own validator would reject.
      return { ok: true, body: { confirmed: false, error: "Plan dogrulamasi basarisiz.", problems: result.problems } };
    }
    return {
      ok: true,
      body: { confirmed: true, operation: result.operation, operations: result.operations, estimatedMinutes: verify.estimatedMinutes },
    };
  }, { exclusive: true });

  res.status(202).json({ jobId });
});

// Faz 5: edit an earlier, already-confirmed operation. Same discipline as
// confirm — verifies the FULL plan with the edit applied before persisting
// it, so a downstream operation that the edit makes unsafe is caught before
// the plan's own record changes, not after.
router.post("/stock-cam/edit", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  const { opId, opType, params } = req.body ?? {};
  if (typeof opId !== "string" || !opId) {
    return res.status(400).json({ error: "opId is required" });
  }
  if (!OPERATION_TYPES[opType]) {
    return res.status(400).json({ error: `Bilinmeyen islem tipi: ${opType}` });
  }
  const problems = validateOperationParams(opType, params ?? {}, plan.stock);
  if (problems.length) {
    return res.status(400).json({ error: "Parametreler gecersiz.", problems });
  }

  const jobId = createJob();
  runJob(jobId, async () => {
    const candidateOps = plan.operations.map((o) => (o.id === opId ? { ...o, type: opType, params } : o));
    const candidate = { ...plan, operations: candidateOps };
    const verify = await verifyStockPlan(candidate);
    if (!verify.ok) {
      return { ok: true, body: { confirmed: false, error: verify.error } };
    }
    const result = replaceOperation(planKey, opId, opType, params);
    if (!result.ok) {
      return { ok: true, body: { confirmed: false, error: "Plan dogrulamasi basarisiz.", problems: result.problems } };
    }
    return { ok: true, body: { confirmed: true, operations: result.operations, estimatedMinutes: verify.estimatedMinutes } };
  }, { exclusive: true });

  res.status(202).json({ jobId });
});

router.delete("/stock-cam/plan/:planKey/op/:opId", apiKeyAuth, (req, res) => {
  const result = removeOperation(req.params.planKey, req.params.opId);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// Faz 7: final G-code export for the whole plan.
router.post("/stock-cam/gcode", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  if (!plan.operations.length) {
    return res.status(400).json({ error: "Planda henuz onaylanmis islem yok." });
  }
  const { postProcessor } = req.body ?? {};

  const jobId = createJob();
  runJob(jobId, async () => {
    const gcodePath = path.join(config.outputDir, `rover_stock_${planKey}.gcode`);
    const result = await exportStockPlanGcode(plan, gcodePath, postProcessor);
    if (!result.ok) {
      return { ok: true, body: { exported: false, error: result.error } };
    }
    const url = `${req.protocol}://${req.get("host")}/files/${path.basename(result.gcodePath)}`;
    return { ok: true, body: { exported: true, gcodeUrl: url, warning: result.warning ?? null } };
  }, { exclusive: true });

  res.status(202).json({ jobId });
});

export default router;
