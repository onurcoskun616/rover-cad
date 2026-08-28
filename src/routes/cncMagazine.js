import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  listMagazineTools,
  addMagazineTool,
  updateMagazineTool,
  removeMagazineTool,
  listMagazineLayout,
  setMagazineLayout,
  listToolUsage,
  resetToolUsage,
} from "../services/cncMagazineService.js";

const router = Router();
router.use(apiKeyAuth);

router.get("/tools", (_req, res, next) => {
  try { res.json({ tools: listMagazineTools() }); } catch (err) { next(err); }
});

router.post("/tools", (req, res) => {
  try { res.status(201).json({ tool: addMagazineTool(req.body ?? {}) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.put("/tools/:id", (req, res) => {
  try {
    const tool = updateMagazineTool(req.params.id, req.body ?? {});
    if (!tool) return res.status(404).json({ error: "Takim bulunamadi" });
    res.json({ tool });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete("/tools/:id", (req, res, next) => {
  try {
    const ok = removeMagazineTool(req.params.id);
    if (!ok) return res.status(404).json({ error: "Takim bulunamadi" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/layout", (_req, res, next) => {
  try { res.json({ slots: listMagazineLayout() }); } catch (err) { next(err); }
});

router.put("/layout", (req, res) => {
  try { res.json({ slots: setMagazineLayout(req.body?.slots ?? []) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Takım Ömrü Takibi: cumulative estimated-cutting-minutes per tool ref-id
// ("builtin:N" or a custom tool's uuid), recorded by /stock-cam/confirm —
// see cncMagazineService.js's own comment for the full design.
router.get("/usage", (_req, res, next) => {
  try { res.json({ usage: listToolUsage() }); } catch (err) { next(err); }
});

router.post("/usage/:refId/reset", (req, res, next) => {
  try { res.json({ ok: resetToolUsage(req.params.refId) }); } catch (err) { next(err); }
});

export default router;
