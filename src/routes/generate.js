import path from "node:path";
import { Router } from "express";
import { config } from "../config.js";
import { callFreecadTool, extractResultText } from "../services/freecadMcpClient.js";
import { exportActiveDocument, resetActiveDocument } from "../services/exportService.js";
import { promptToFreecadCode } from "../services/promptToCodeService.js";

function fileUrl(req, filePath) {
  if (!filePath) return null;
  return `${req.protocol}://${req.get("host")}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use((req, res, next) => {
  if (!config.apiKey) {
    return res.status(500).json({ error: "Server misconfigured: API_KEY is not set" });
  }
  if (req.get("x-api-key") !== config.apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

router.post("/", async (req, res, next) => {
  try {
    const { prompt } = req.body ?? {};

    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return res
        .status(400)
        .json({ error: "prompt is required and must be a non-empty string" });
    }

    const freecadCode = await promptToFreecadCode(prompt);

    await resetActiveDocument();

    const buildResult = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]: freecadCode,
    });

    const buildText = extractResultText(buildResult);
    if (buildResult?.isError || buildText.startsWith("Failed to execute code")) {
      return res.status(502).json({
        error: "FreeCAD MCP failed to run the generated code",
        generatedCode: freecadCode,
        details: buildText || buildResult,
      });
    }

    const { stepPath, stlPath } = await exportActiveDocument();

    if (!stepPath && !stlPath) {
      return res.status(502).json({
        error: "FreeCAD did not return an exported file path",
        generatedCode: freecadCode,
        freecadResult: buildResult,
      });
    }

    res.json({
      stepPath,
      stlPath,
      stepUrl: fileUrl(req, stepPath),
      stlUrl: fileUrl(req, stlPath),
      generatedCode: freecadCode,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
