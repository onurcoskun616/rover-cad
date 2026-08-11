import { Router } from "express";
import { apiKeyAuth, requireAdmin } from "./apiKeyAuth.js";
import { listUsers, stats, updateUser, usageSummary } from "../services/accountStore.js";
const router = Router();
router.use(apiKeyAuth, requireAdmin);
router.get("/stats", async (_req, res, next) => { try { res.json(await stats()); } catch (e) { next(e); } });
router.get("/users", async (_req, res, next) => { try { res.json({ users: await listUsers() }); } catch (e) { next(e); } });
router.get("/usage-summary", async (req, res, next) => {
  try { res.json({ usage: await usageSummary(req.query.days) }); } catch (e) { next(e); }
});
router.patch("/users/:id", async (req, res, next) => { try { res.json({ user: await updateUser(req.params.id, req.body ?? {}) }); } catch (e) { next(e); } });
export default router;
