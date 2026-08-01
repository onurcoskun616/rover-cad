import { config } from "../config.js";

// Shared x-api-key gate for every endpoint except /health. The key is a shared
// secret baked into the (public) frontend — it only keeps casual/automated
// traffic out, it is not a real authentication boundary.
export function apiKeyAuth(req, res, next) {
  if (!config.apiKey) {
    return res.status(500).json({ error: "Server misconfigured: API_KEY is not set" });
  }
  if (req.get("x-api-key") !== config.apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
