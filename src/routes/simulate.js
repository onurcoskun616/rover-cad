import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { runSimulationExport } from "../services/simulationExportService.js";
import { createJob, runJob } from "../services/jobStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

router.post("/", (req, res) => {
  const { code } = req.body ?? {};

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "code is required" });
  }

  const proto = req.protocol;
  const host = req.get("host");
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

      const partStlUrls = result.parts.map((p) => ({
        name: p.name,
        url: makeFileUrl(proto, host, p.stlPath),
      }));

      return {
        ok: true,
        body: {
          partStlUrls,
          kinematicsUrl: makeFileUrl(proto, host, result.kinematicsPath),
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

router.post("/demo", (req, res) => {
  const demoPath = path.join(__dirname, "..", "..", "examples", "crank_piston_sim.py");
  let code;
  try {
    code = fs.readFileSync(demoPath, "utf-8");
  } catch {
    return res.status(500).json({ error: "Demo script not found on server" });
  }

  const proto = req.protocol;
  const host = req.get("host");
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

      const partStlUrls = result.parts.map((p) => ({
        name: p.name,
        url: makeFileUrl(proto, host, p.stlPath),
      }));

      return {
        ok: true,
        body: {
          partStlUrls,
          kinematicsUrl: makeFileUrl(proto, host, result.kinematicsPath),
        },
      };
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

export default router;
