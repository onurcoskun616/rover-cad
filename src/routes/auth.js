import { Router } from "express";
import { login, register, listUsage } from "../services/accountStore.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
const router = Router();
router.post("/register", (req, res, next) => { try { res.status(201).json(register(req.body ?? {})); } catch (e) { next(e); } });
router.post("/login", (req, res, next) => { try { res.json(login(req.body ?? {})); } catch (e) { next(e); } });
router.get("/me", apiKeyAuth, (req, res) => res.json({ user: req.user }));
router.get("/usage", apiKeyAuth, (req, res) => res.json({ usage: listUsage(req.user.id) }));
export default router;
