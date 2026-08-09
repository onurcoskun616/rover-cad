import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import cors from "cors";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { runSimulationExport } from "../services/simulationExportService.js";
import { promptToSimCode } from "../services/simulationGenerateService.js";
import { createJob, runJob } from "../services/jobStore.js";
import { pushStep, undoStep } from "../services/simHistoryStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const router = Router();

router.use(cors({ origin: true }));
router.use(apiKeyAuth);

router.post("/", (req, res) => {
  const { code } = req.body ?? {};

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "code is required" });
  }

  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      console.log("[simulate] starting FreeCAD export…");
      const result = await runSimulationExport(code);
      console.log("[simulate] export finished, ok=%s parts=%d", result.ok, result.parts?.length ?? 0);

      if (!result.ok) {
        console.error("[simulate] export error:", result.error);
        return { ok: false, body: { error: result.error } };
      }

      const partsInline = result.parts.map((p) => ({
        name: p.name,
        stlBase64: fs.readFileSync(p.stlPath).toString("base64"),
      }));

      let kinematicsData = null;
      try {
        kinematicsData = JSON.parse(fs.readFileSync(result.kinematicsPath, "utf-8"));
      } catch (e) {
        console.error("[simulate] kinematics read error:", e.message);
      }

      return {
        ok: true,
        body: {
          partsInline,
          kinematicsData,
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

router.post("/generate", (req, res) => {
  const { prompt, previousCode, previousKinematics, sessionId } = req.body ?? {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }

  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      console.log("[simulate/generate] generating sim code from prompt…");
      let code;
      try {
        code = await promptToSimCode(prompt.trim(), previousCode || null, previousKinematics || null);
      } catch (err) {
        console.error("[simulate/generate] code generation error:", err.message);
        return { ok: false, body: { error: `Kod uretimi basarisiz: ${err.message}` } };
      }

      console.log("[simulate/generate] running generated code in FreeCAD…");
      const result = await runSimulationExport(code);
      console.log("[simulate/generate] export finished, ok=%s parts=%d", result.ok, result.parts?.length ?? 0);

      if (!result.ok) {
        console.error("[simulate/generate] export error:", result.error);
        return { ok: false, body: { error: result.error, generatedCode: code } };
      }

      const partsInline = result.parts.map((p) => ({
        name: p.name,
        stlBase64: fs.readFileSync(p.stlPath).toString("base64"),
      }));

      let kinematicsData = null;
      try {
        kinematicsData = JSON.parse(fs.readFileSync(result.kinematicsPath, "utf-8"));
      } catch (e) {
        console.error("[simulate/generate] kinematics read error:", e.message);
      }

      let stepIndex = null;
      let totalSteps = null;
      if (sessionId) {
        const info = pushStep(sessionId, { code, kinematicsData, partsInline });
        stepIndex = info.stepIndex;
        totalSteps = info.totalSteps;
      }

      return {
        ok: true,
        body: {
          partsInline,
          kinematicsData,
          generatedCode: code,
          sessionId: sessionId || null,
          stepIndex,
          totalSteps,
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

router.post("/demo", (req, res) => {
  const { sessionId } = req.body ?? {};
  const demoPath = path.join(__dirname, "..", "..", "examples", "crank_piston_sim.py");
  let code;
  try {
    code = fs.readFileSync(demoPath, "utf-8");
  } catch {
    return res.status(500).json({ error: "Demo script not found on server" });
  }

  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      console.log("[simulate/demo] starting FreeCAD export…");
      const result = await runSimulationExport(code);
      console.log("[simulate/demo] export finished, ok=%s parts=%d", result.ok, result.parts?.length ?? 0);

      if (!result.ok) {
        console.error("[simulate/demo] export error:", result.error);
        return { ok: false, body: { error: result.error } };
      }

      const partsInline = result.parts.map((p) => ({
        name: p.name,
        stlBase64: fs.readFileSync(p.stlPath).toString("base64"),
      }));

      let kinematicsData = null;
      try {
        kinematicsData = JSON.parse(fs.readFileSync(result.kinematicsPath, "utf-8"));
      } catch (e) {
        console.error("[simulate/demo] kinematics read error:", e.message);
      }

      let stepIndex = null;
      let totalSteps = null;
      if (sessionId) {
        const info = pushStep(sessionId, { code, kinematicsData, partsInline });
        stepIndex = info.stepIndex;
        totalSteps = info.totalSteps;
      }

      return {
        ok: true,
        body: {
          partsInline,
          kinematicsData,
          generatedCode: code,
          sessionId: sessionId || null,
          stepIndex,
          totalSteps,
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

router.post("/undo", (req, res) => {
  const { sessionId } = req.body ?? {};

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const step = undoStep(sessionId);
  if (!step) {
    return res.status(400).json({ error: "Geri alinacak adim yok." });
  }

  return res.json({
    ok: true,
    partsInline: step.partsInline,
    kinematicsData: step.kinematicsData,
    generatedCode: step.code,
    stepIndex: step.stepIndex,
    totalSteps: step.totalSteps,
  });
});

export default router;
