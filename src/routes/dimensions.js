import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { extractDimensions } from "../services/dimensionService.js";

const router = Router();
router.use(apiKeyAuth);

router.post("/", async (req, res) => {
  const { stepPath } = req.body ?? {};
  if (!stepPath) {
    return res.status(400).json({ error: "stepPath zorunludur" });
  }
  try {
    const data = await extractDimensions(stepPath);
    res.json(data);
  } catch (err) {
    console.error("Dimension extraction error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
