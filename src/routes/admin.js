import { Router } from "express";
import { apiKeyAuth, requireAdmin } from "./apiKeyAuth.js";
import { grantBonusTokens, listUsers, stats, updateUser, usageSummary } from "../services/accountStore.js";
import { getQuotePricingSettings, updateQuotePricingSettings } from "../services/quotePricingSettings.js";
const router = Router();
router.use(apiKeyAuth, requireAdmin);
// "Anında Teklif Al" (web/teklif.html) pricing catalog -- machine hourly
// rate, per-material TRY/kg, default profit %, and adet-bazlı iskonto
// tiers. Editable here instead of a code change + redeploy each time.
router.get("/quote-pricing", (_req, res) => { res.json(getQuotePricingSettings()); });
router.put("/quote-pricing", (req, res) => { res.json(updateQuotePricingSettings(req.body ?? {})); });
router.get("/stats", async (_req, res, next) => { try { res.json(await stats()); } catch (e) { next(e); } });
router.get("/users", async (_req, res, next) => { try { res.json({ users: await listUsers() }); } catch (e) { next(e); } });
router.get("/usage-summary", async (req, res, next) => {
  try { res.json({ usage: await usageSummary(req.query.days) }); } catch (e) { next(e); }
});
router.patch("/users/:id", async (req, res, next) => { try { res.json({ user: await updateUser(req.params.id, req.body ?? {}) }); } catch (e) { next(e); } });
router.post("/users/:id/grant-tokens", async (req, res, next) => {
  try { res.json({ user: await grantBonusTokens(req.params.id, req.body?.amount) }); } catch (e) { next(e); }
});
export default router;
