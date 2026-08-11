import { consumeTokens, verifySession } from "../services/accountStore.js";

// User session gate and monthly usage reservation for protected endpoints.
export function apiKeyAuth(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  const user = verifySession(token);
  if (!user) return res.status(401).json({ error: "Oturum açmanız gerekiyor" });
  req.user = user;
  // Reserve a transparent fixed token amount for AI-producing operations.
  const path = req.originalUrl.split("?")[0];
  const costs = { "/generate": 2500, "/generate-from-image": 3500, "/revise": 1800,
    "/cam-step": 500, "/cam-plan": 1200, "/simulate/generate": 2000 };
  const cost = req.method === "POST" ? (costs[path] ?? 0) : 0;
  try { if (cost) req.user = consumeTokens(user.id, cost, path); next(); }
  catch (e) { res.status(e.status ?? 500).json({ error: e.message }); }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Yönetici yetkisi gerekiyor" });
  next();
}
