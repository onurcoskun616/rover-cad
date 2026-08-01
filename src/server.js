import fs from "node:fs";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import healthRouter from "./routes/health.js";
import generateRouter from "./routes/generate.js";
import generateFromImageRouter from "./routes/generateFromImage.js";
import generateCamRouter from "./routes/generateCam.js";
import { disconnectFreecad } from "./services/freecadMcpClient.js";

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
app.use("/generate-cam", generateCamRouter);
// Serves generated STEP/STL/PDF/G-code files so the frontend can link to and
// preview them.
app.use("/files", express.static(config.outputDir));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`Rover CAD backend listening on http://localhost:${config.port}`);
});

async function shutdown() {
  console.log("Shutting down...");
  server.close();
  await disconnectFreecad();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
