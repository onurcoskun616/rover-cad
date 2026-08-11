import { ensureProfile } from "../services/accountStore.js";
import { runWithLlmContext } from "../services/llmRequestContext.js";
import { getSupabaseUser } from "../services/supabaseAuth.js";

// User session gate and monthly usage reservation for protected endpoints.
export async function apiKeyAuth(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  try {
    const authUser = await getSupabaseUser(token);
    if (!authUser) return res.status(401).json({ error: "Oturum açmanız gerekiyor" });
    const user = await ensureProfile(authUser);
    if (user.status !== "active") return res.status(403).json({ error: "Hesabınız kullanıma kapalı" });
    req.user = user;
    const feature = `${req.method} ${req.originalUrl.split("?")[0]}`;
    return runWithLlmContext({ userId: user.id, feature }, next);
  } catch (error) {
    return next(error);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Yönetici yetkisi gerekiyor" });
  next();
}
