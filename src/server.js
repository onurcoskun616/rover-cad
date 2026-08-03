import fs from "node:fs";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import healthRouter from "./routes/health.js";
import generateRouter from "./routes/generate.js";
import generateFromImageRouter from "./routes/generateFromImage.js";
import uploadStepRouter from "./routes/uploadStep.js";
import uploadDxfRouter from "./routes/uploadDxf.js";
import reviseRouter from "./routes/revise.js";
import generatePdfRouter from "./routes/generatePdf.js";
import jobsRouter from "./routes/jobs.js";
import camAssistantRouter from "./routes/camAssistant.js";
import { machinesRouter, toolsRouter } from "./routes/inventory.js";
import { callFreecadTool, disconnectFreecad } from "./services/freecadMcpClient.js";

fs.mkdirSync(config.outputDir, { recursive: true });

const app = express();
// Behind a reverse proxy (e.g. api.topkapikoleji.org), so req.protocol
// reflects X-Forwarded-Proto instead of always reporting http.
app.set("trust proxy", true);
app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","),
  }),
);
app.use(express.json());

app.use("/health", healthRouter);
app.use("/generate", generateRouter);
app.use("/generate-from-image", generateFromImageRouter);
app.use("/upload-step", uploadStepRouter);
app.use("/upload-dxf", uploadDxfRouter);
app.use("/revise", reviseRouter);
app.use("/generate-pdf", generatePdfRouter);
// Poll async job status started by the routes above.
app.use("/jobs", jobsRouter);
// Machine/tool inventory (profiles reused across CAM jobs).
app.use("/machines", machinesRouter);
app.use("/tools", toolsRouter);
// Serves generated STEP/STL/PDF/G-code files so the frontend can link to and
// preview them. Registered before the "/"-mounted CAM assistant router so these
// public downloads are never intercepted.
app.use("/files", express.static(config.outputDir));
// CAM assistant (step wizard -> plan -> confirm) for every part:
// /cam-step, /cam-plan, /cam-confirm.
// Mounted at "/" (its routes carry their own auth), so keep it last.
app.use("/", camAssistantRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`Rover CAD backend listening on http://localhost:${config.port}`);
  // Pre-warm FreeCAD: open the MCP connection and launch FreeCAD now so the first
  // real request doesn't pay the cold-start (uvx resolve + FreeCAD boot) cost.
  callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: "print('warm')",
  })
    .then(() => console.log("FreeCAD pre-warmed"))
    .catch((err) => console.warn("FreeCAD pre-warm skipped:", err.message));
});

async function shutdown() {
  console.log("Shutting down...");
  server.close();
  await disconnectFreecad();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
