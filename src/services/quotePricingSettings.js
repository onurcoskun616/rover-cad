import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// Admin-configurable pricing catalog for "Anında Teklif Al" (web/teklif.html)
// -- file-based JSON store, same pattern as cncMagazineService.js's own
// tool/layout stores. Editing these through the Admin panel (web/admin.html)
// is how the operator updates them now, instead of a code change + redeploy
// each time. Seeded with the same flat placeholder values the operator
// originally gave directly (500 TL/saat, 100 TL/kg across every material,
// 20% kâr marjı matching cam.html's own pre-existing "Basit" mode default).
//
// Adet Bazlı İskonto: quantityDiscountTiers apply a discount percentage to
// the pre-profit (malzeme+işlem) subtotal once the quantity reaches a
// tier's minQty -- these percentages/thresholds are the operator's own
// numbers too, not invented; DEFAULTS below is only a starting point until
// the operator sets real ones via the Admin panel.
const DEFAULTS = {
  machineHourlyRateTRY: 500,
  materialPriceTRYPerKg: {
    Aluminyum: 100,
    Celik: 100,
    "Paslanmaz Celik": 100,
    "Pirinc/Bronz": 100,
    Plastik: 100,
    Ahsap: 100,
  },
  defaultProfitPct: 20,
  quantityDiscountTiers: [],
};

function filePath() {
  return path.join(config.dataDir, "quote-pricing-settings.json");
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeTiers(raw) {
  if (!Array.isArray(raw)) return DEFAULTS.quantityDiscountTiers;
  return raw
    .map((t) => ({ minQty: num(t?.minQty, 0), discountPct: num(t?.discountPct, 0) }))
    .filter((t) => t.minQty > 0 && t.discountPct > 0);
}

export function getQuotePricingSettings() {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      machineHourlyRateTRY: num(parsed?.machineHourlyRateTRY, DEFAULTS.machineHourlyRateTRY),
      materialPriceTRYPerKg:
        parsed?.materialPriceTRYPerKg && typeof parsed.materialPriceTRYPerKg === "object"
          ? { ...DEFAULTS.materialPriceTRYPerKg, ...parsed.materialPriceTRYPerKg }
          : DEFAULTS.materialPriceTRYPerKg,
      defaultProfitPct: num(parsed?.defaultProfitPct, DEFAULTS.defaultProfitPct),
      quantityDiscountTiers: sanitizeTiers(parsed?.quantityDiscountTiers),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateQuotePricingSettings(partial) {
  const current = getQuotePricingSettings();
  const next = {
    machineHourlyRateTRY:
      partial?.machineHourlyRateTRY !== undefined ? num(partial.machineHourlyRateTRY, current.machineHourlyRateTRY) : current.machineHourlyRateTRY,
    materialPriceTRYPerKg:
      partial?.materialPriceTRYPerKg && typeof partial.materialPriceTRYPerKg === "object"
        ? { ...current.materialPriceTRYPerKg, ...partial.materialPriceTRYPerKg }
        : current.materialPriceTRYPerKg,
    defaultProfitPct: partial?.defaultProfitPct !== undefined ? num(partial.defaultProfitPct, current.defaultProfitPct) : current.defaultProfitPct,
    quantityDiscountTiers: partial?.quantityDiscountTiers !== undefined ? sanitizeTiers(partial.quantityDiscountTiers) : current.quantityDiscountTiers,
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(next, null, 2));
  return next;
}

// The highest-minQty tier the given quantity qualifies for, or null if it
// doesn't reach even the lowest configured tier. Tiers are NOT assumed
// pre-sorted (the Admin panel form doesn't enforce an order), so this
// always sorts by minQty descending itself before picking the first match.
export function quantityDiscountFor(quantity, tiers) {
  const qty = Math.max(1, num(quantity, 1));
  const sorted = [...(Array.isArray(tiers) ? tiers : [])].sort((a, b) => b.minQty - a.minQty);
  return sorted.find((t) => qty >= t.minQty) ?? null;
}
