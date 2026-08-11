import { Router } from "express";
import { apiKeyAuth, requireAdmin } from "./apiKeyAuth.js";
import { listUsers, stats, updateUser } from "../services/accountStore.js";
const router = Router();
router.use(apiKeyAuth, requireAdmin);
router.get("/stats", (_req, res) => res.json(stats()));
router.get("/users", (_req, res) => res.json({ users: listUsers() }));
router.patch("/users/:id", (req, res, next) => { try { res.json({ user: updateUser(req.params.id, req.body ?? {}) }); } catch (e) { next(e); } });
export default router;
