import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  createPlan,
  getPlan,
  confirmOperation,
  replaceOperation,
  removeOperation,
  reorderOperations,
  listOperationTypes,
  validateOperationParams,
  setLastEstimatedMinutes,
  OPERATION_TYPES,
} from "../services/stockCamPlanService.js";
import { getNextParamStep } from "../services/stockCamStepService.js";
import {
  isStockGenerationSupported,
  verifyStockPlan,
  exportStockPlanGcode,
  suggestToolOrder,
  countToolChanges,
} from "../services/stockCamGenerateService.js";
import { buildSetupSheetHtml } from "../services/stockCamSetupSheetService.js";
import { addToolUsageMinutes, toolWearStatus } from "../services/cncMagazineService.js";
import { computeStockCamCost } from "../services/stockCamCostService.js";
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
  const { stock, material } = req.body ?? {};
  if (!stock || typeof stock !== "object") {
    return res.status(400).json({ error: "stock is required" });
  }
  const plan = createPlan(stock, material);
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

  // Takım Ömrü Takibi: the plan's cumulative FreeCAD time-estimate BEFORE
  // this operation, captured now (same timing as the `candidate` construction
  // below) so the delta after verify is this operation's own real marginal
  // cutting time -- see cncMagazineService.js's own comment for the full
  // design (never retroactively touched by an edit/delete).
  const priorMinutes = Number.isFinite(plan.lastEstimatedMinutes) ? plan.lastEstimatedMinutes : 0;

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
    // Lets the printable setup sheet show a real total without its own
    // separate FreeCAD call -- see stockCamPlanService.js's own comment.
    setLastEstimatedMinutes(planKey, verify.estimatedMinutes);
    // toolRefId only arrives when the client's own tool magazine matched a
    // real registered tool (cnc-sim.html's stockCamApplyMagazineTool) --
    // nothing to attribute wear to otherwise.
    const toolRefId = typeof params?.toolRefId === "string" && params.toolRefId ? params.toolRefId : null;
    let toolWear = null;
    if (toolRefId) {
      addToolUsageMinutes(toolRefId, Math.max(0, verify.estimatedMinutes - priorMinutes));
      toolWear = toolWearStatus(toolRefId);
    }
    return {
      ok: true,
      body: {
        confirmed: true,
        operation: result.operation,
        operations: result.operations,
        estimatedMinutes: verify.estimatedMinutes,
        toolWear,
      },
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
    setLastEstimatedMinutes(planKey, verify.estimatedMinutes);
    return { ok: true, body: { confirmed: true, operations: result.operations, estimatedMinutes: verify.estimatedMinutes } };
  }, { exclusive: true });

  res.status(202).json({ jobId });
});

router.delete("/stock-cam/plan/:planKey/op/:opId", apiKeyAuth, (req, res) => {
  const result = removeOperation(req.params.planKey, req.params.opId);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// Otomatik Takım Sıralama: a dry-run preview only -- synchronous, plan-data
// only (no FreeCAD call), same reason /stock-cam/validate is sync. Never
// touches the plan itself; the operator still has to explicitly confirm via
// /stock-cam/reorder below before anything is actually persisted.
router.post("/stock-cam/suggest-order", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  const suggested = suggestToolOrder(plan.operations);
  const changed = suggested.some((op, i) => op.id !== plan.operations[i].id);
  res.json({
    order: suggested.map((op) => op.id),
    labels: suggested.map((op) => OPERATION_TYPES[op.type]?.label || op.type),
    changed,
    beforeToolChanges: countToolChanges(plan.operations),
    afterToolChanges: countToolChanges(suggested),
  });
});

// Applies a reordering (by operation id) -- async (polled via /jobs/:id)
// because, exactly like /stock-cam/edit, it re-verifies the WHOLE reordered
// plan through a real FreeCAD rebuild before persisting anything: cutting
// ORDER can change what each operation actually removes (e.g. a later
// operation assuming material an earlier one already cleared), so a
// reorder gets the identical safety-checked-rebuild discipline as any
// other plan mutation -- never skipped just because no operation's own
// params changed.
router.post("/stock-cam/reorder", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  const { order } = req.body ?? {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "order bir dizi olmalidir." });
  }

  const jobId = createJob();
  runJob(jobId, async () => {
    const byId = new Map(plan.operations.map((op) => [op.id, op]));
    const validOrder =
      order.length === plan.operations.length &&
      new Set(order).size === order.length &&
      order.every((id) => byId.has(id));
    if (!validOrder) {
      return { ok: true, body: { reordered: false, error: "Sıralama listesi mevcut işlemlerle eşleşmiyor." } };
    }
    const candidate = { ...plan, operations: order.map((id) => byId.get(id)) };
    const verify = await verifyStockPlan(candidate);
    if (!verify.ok) {
      return { ok: true, body: { reordered: false, error: verify.error } };
    }
    const result = reorderOperations(planKey, order);
    if (!result.ok) {
      return { ok: true, body: { reordered: false, error: "Plan dogrulamasi basarisiz.", problems: result.problems } };
    }
    setLastEstimatedMinutes(planKey, verify.estimatedMinutes);
    return { ok: true, body: { reordered: true, operations: result.operations, estimatedMinutes: verify.estimatedMinutes } };
  }, { exclusive: true });

  res.status(202).json({ jobId });
});

// Printable job/routing sheet: synchronous, plan-data-only (no FreeCAD/LLM
// call — see stockCamSetupSheetService.js's own comment). Deliberately NOT
// behind apiKeyAuth: it's opened directly in a browser tab/print dialog
// (window.open can't attach a custom auth header), the exact same
// unauthenticated-but-unguessable-key precedent already used for the
// G-code download itself (server.js's plain `express.static` mount on
// /files, no apiKeyAuth there either) — the random planKey is the only
// protection either one relies on.
router.get("/stock-cam/plan/:planKey/setup-sheet", (req, res) => {
  const plan = getPlan(req.params.planKey);
  if (!plan) return res.status(404).send("Plan bulunamadi.");
  if (!plan.operations.length) return res.status(400).send("Planda henuz onaylanmis islem yok.");
  const postName = typeof req.query.postProcessor === "string" ? req.query.postProcessor : "";
  // Maliyet Hesaplama: optional, query-string-only (this route can't take a
  // POST body — window.open opens it directly) -- omitted entirely unless
  // the operator already ran a /stock-cam/quote and chose to carry those
  // same numbers into the printed sheet (see cnc-sim.html's stockCamLastCostInputs).
  const costInputs = {
    materialPricePerKg: req.query.materialPricePerKg,
    hourlyRate: req.query.hourlyRate,
    profitPct: req.query.profitPct,
  };
  res.type("html").send(buildSetupSheetHtml(plan, postName, costInputs));
});

// Maliyet Hesaplama: synchronous (arithmetic only, no FreeCAD/LLM call --
// reuses plan.lastEstimatedMinutes, the real FreeCAD estimate already
// captured at the most recent confirm/edit, see stockCamPlanService.js's
// own comment on that field). materialPricePerKg/hourlyRate/profitPct are
// the operator's OWN current numbers each time -- never persisted or
// defaulted to a guessed figure, same discipline as the STEP-file wizard's
// existing /cam-quote.
router.post("/stock-cam/quote", apiKeyAuth, (req, res) => {
  const planKey = requirePlanKey(req, res);
  if (!planKey) return;
  const plan = getPlan(planKey);
  if (!plan) return res.status(404).json({ error: "Plan bulunamadi." });
  const { materialPricePerKg, hourlyRate, profitPct } = req.body ?? {};
  const quote = computeStockCamCost({
    stock: plan.stock,
    material: plan.material,
    minutes: plan.lastEstimatedMinutes,
    materialPricePerKg,
    hourlyRate,
    profitPct,
  });
  res.json({ quote });
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
