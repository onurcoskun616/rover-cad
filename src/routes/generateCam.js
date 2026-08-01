import path from "node:path";
import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { generateGcode } from "../services/camService.js";

function fileUrl(req, filePath) {
  if (!filePath) return null;
  return `${req.protocol}://${req.get("host")}/files/${path.basename(filePath)}`;
}

const router = Router();

router.use(apiKeyAuth);

router.post("/", async (req, res, next) => {
  try {
    const { stepPath } = req.body ?? {};

    if (typeof stepPath !== "string" || stepPath.trim().length === 0) {
      return res
        .status(400)
        .json({ error: "stepPath is required and must be a non-empty string" });
    }

    const result = await generateGcode(stepPath);

    if (result.complex) {
      return res.json({ complex: true, message: result.message });
    }

    res.json({
      complex: false,
      gcodePath: result.gcodePath,
      gcodeUrl: fileUrl(req, result.gcodePath),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
