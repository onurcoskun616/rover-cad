import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { config } from "../config.js";
import { quantityDiscountFor } from "./quotePricingSettings.js";

// Material densities (g/cm3) for converting a stock volume to weight when the
// material price is given per kg.
const DENSITY_G_CM3 = {
  Aluminyum: 2.7,
  Celik: 7.85,
  "Paslanmaz Celik": 8.0,
  "Pirinc/Bronz": 8.5,
  Plastik: 1.2,
  Ahsap: 0.7,
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;
const isBlank = (v) => v === undefined || v === null || v === "";

// Fills in "basit"-mode cost inputs the caller left blank, in priority order:
// the caller's own explicit value > (hourlyRate only) a selected machine
// profile's rate > the admin-configured catalog (quotePricingSettings.js,
// edited from web/admin.html's "Teklif Fiyatlandırma" panel) -- but ONLY
// when useCatalogDefaults is true. cam.html's own quote form never sets
// that flag, so leaving materialPrice blank there keeps meaning exactly
// what it always has ("0 TL", via its own placeholder hint) -- this
// function changes nothing for it. Only web/teklif.html ("Anında Teklif
// Al") sets the flag, since its whole premise is a price with zero manual
// pricing entry. `catalog` is whatever the caller already fetched via
// getQuotePricingSettings() -- this function itself does no file I/O, so
// it stays a plain, easily-testable pure function.
export function resolveQuoteInputs({ mode, inputs, material, machineHourlyRate, useCatalogDefaults, catalog }) {
  const resolved = inputs && typeof inputs === "object" ? { ...inputs } : {};
  if (mode !== "basit") return resolved;
  if (isBlank(resolved.hourlyRate) && machineHourlyRate) {
    resolved.hourlyRate = machineHourlyRate;
  }
  if (!useCatalogDefaults || !catalog) return resolved;
  if (isBlank(resolved.hourlyRate)) {
    resolved.hourlyRate = catalog.machineHourlyRateTRY;
  }
  if (isBlank(resolved.materialPrice)) {
    const catalogPrice = catalog.materialPriceTRYPerKg?.[material];
    if (catalogPrice) {
      resolved.materialPrice = catalogPrice;
      resolved.materialPriceUnit = "kg";
    }
  }
  if (isBlank(resolved.profitPct)) {
    resolved.profitPct = catalog.defaultProfitPct;
  }
  return resolved;
}

// Stock volume in cm3 from the wizard's stock dimensions (mm), falling back to
// the bounding box when stock is not set.
function stockVolumeCm3(answers, bbox) {
  const sx = num(answers?.stockX);
  const sy = num(answers?.stockY);
  const sz = num(answers?.stockZ);
  if (sx > 0 && sy > 0 && sz > 0) return (sx * sy * sz) / 1000;
  const bx = num(bbox?.x);
  const by = num(bbox?.y);
  const bz = num(bbox?.z);
  return (bx * by * bz) / 1000;
}

function materialCost(inputs, answers, bbox) {
  const price = num(inputs?.materialPrice);
  if (price <= 0) return 0;
  const volumeCm3 = stockVolumeCm3(answers, bbox);
  if (inputs?.materialPriceUnit === "kg") {
    const density = DENSITY_G_CM3[answers?.material] ?? 2.7;
    const weightKg = (volumeCm3 * density) / 1000;
    return price * weightKg;
  }
  // default: TL per cm3
  return price * volumeCm3;
}

// Adet Bazlı İskonto: applies the admin-configured tier (if the quantity
// reaches one) to a pre-profit subtotal, pushing its own line item so the
// discount is always visible in the breakdown/PDF, never silently folded
// into another number. Returns the (possibly reduced) subtotal. A caller
// that never passes discountTiers (every EXISTING caller before this
// feature) gets tier=null every time -- quantityDiscountFor(qty, undefined)
// -- so this is a no-op unless a caller opts in.
function applyQuantityDiscount(items, subtotal, quantity, discountTiers) {
  const tier = quantityDiscountFor(quantity, discountTiers);
  if (!tier) return subtotal;
  const discountAmount = round2((subtotal * tier.discountPct) / 100);
  items.push({ label: `Adet Iskontosu (${quantity} adet, %${tier.discountPct})`, amount: -discountAmount });
  return round2(subtotal - discountAmount);
}

/**
 * Compute a cost breakdown for a machined part.
 * @param {object} p
 * @param {"basit"|"detayli"} p.mode
 * @param {number} p.minutes estimated machining time (minutes)
 * @param {object} p.answers wizard answers (material, stock dims)
 * @param {object} p.bbox part bounding box
 * @param {object} p.inputs cost inputs (blank fields count as 0)
 * @param {number} [p.quantity] adet -- defaults to 1 (no discount, no multiplier)
 * @param {Array<{minQty:number,discountPct:number}>} [p.discountTiers] admin-configured quantity discount tiers
 * @returns {{mode:string, minutes:number, items:Array<{label:string, amount:number}>, subtotal:number, quantity:number, unitPrice:number, total:number}}
 */
export function computeQuote({ mode, minutes, answers, bbox, inputs, quantity, discountTiers }) {
  const min = num(minutes);
  const hours = min / 60;
  const qty = Math.max(1, Math.round(num(quantity) || 1));
  const items = [];
  const matCost = round2(materialCost(inputs, answers, bbox));

  if (mode === "detayli") {
    const amortization = round2(hours * num(inputs?.amortHourly));
    const energy = round2(hours * num(inputs?.powerKw) * num(inputs?.energyPrice));
    const toolLife = num(inputs?.toolLifeParts);
    const toolWear = round2(toolLife > 0 ? num(inputs?.toolCost) / toolLife : 0);
    const consumables = round2(
      hours * num(inputs?.consumableHourly) + num(inputs?.consumablePerPart),
    );

    items.push({ label: "Malzeme", amount: matCost });
    items.push({ label: "Makine amortismani", amount: amortization });
    items.push({ label: "Enerji", amount: energy });
    items.push({ label: "Takim asinma payi", amount: toolWear });
    items.push({ label: "Sarf malzemesi", amount: consumables });

    let directSum = matCost + amortization + energy + toolWear + consumables;
    directSum = applyQuantityDiscount(items, directSum, qty, discountTiers);
    const overhead = round2((directSum * num(inputs?.overheadPct)) / 100);
    const afterOverhead = directSum + overhead;
    const scrap = round2((afterOverhead * num(inputs?.scrapPct)) / 100);
    const afterScrap = afterOverhead + scrap;
    const profit = round2((afterScrap * num(inputs?.profitPct)) / 100);
    const unitPrice = round2(afterScrap + profit);

    items.push({ label: `Genel gider (%${num(inputs?.overheadPct)})`, amount: overhead });
    items.push({ label: `Fire/hata payi (%${num(inputs?.scrapPct)})`, amount: scrap });
    items.push({ label: `Kar marji (%${num(inputs?.profitPct)})`, amount: profit });

    return { mode, minutes: round2(min), items, subtotal: round2(afterScrap), quantity: qty, unitPrice, total: round2(unitPrice * qty) };
  }

  // basit mode
  const hourlyRate = num(inputs?.hourlyRate);
  const machineCost = round2(hours * hourlyRate);
  items.push({ label: "Malzeme", amount: matCost });
  items.push({ label: `Islem (${round2(min)} dk x ${hourlyRate} TL/saat)`, amount: machineCost });
  const subtotal = applyQuantityDiscount(items, matCost + machineCost, qty, discountTiers);
  const profit = round2((subtotal * num(inputs?.profitPct)) / 100);
  items.push({ label: `Kar marji (%${num(inputs?.profitPct)})`, amount: profit });
  const unitPrice = round2(subtotal + profit);
  return { mode, minutes: round2(min), items, subtotal: round2(subtotal), quantity: qty, unitPrice, total: round2(unitPrice * qty) };
}

// FreeCAD-free ASCII fallback: pdfkit's Helvetica lacks some Turkish glyphs, so
// map them to ASCII for a clean form.
function toAscii(str) {
  const map = { ç: "c", Ç: "C", ğ: "g", Ğ: "G", ı: "i", İ: "I", ö: "o", Ö: "O", ş: "s", Ş: "S", ü: "u", Ü: "U" };
  return String(str ?? "").replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => map[c] ?? c);
}
const fmtTL = (n) => `${round2(num(n)).toLocaleString("tr-TR")} TL`;

/**
 * Render the quote as a "Teklif Formu" PDF and return its path.
 * @param {object} p
 * @param {string} p.partName
 * @param {object} p.bbox
 * @param {string} p.material
 * @param {object} p.quote result of computeQuote
 * @returns {Promise<string>} the PDF path
 */
export function generateQuotePdf({ partName, bbox, material, quote }) {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(config.outputDir, { recursive: true });
      const pdfPath = path.join(config.outputDir, `teklif_${Date.now()}_${randomUUID().slice(0, 8)}.pdf`);
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      doc.fontSize(20).text("Teklif Formu", { align: "center" });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor("#666")
        .text(`Tarih: ${new Date().toLocaleString("tr-TR")}`, { align: "center" });
      doc.moveDown(1).fillColor("#000");

      const bx = round2(num(bbox?.x));
      const by = round2(num(bbox?.y));
      const bz = round2(num(bbox?.z));
      doc.fontSize(11);
      doc.text(`Parca: ${toAscii(partName) || "-"}`);
      doc.text(`Olculer (mm): ${bx} x ${by} x ${bz}`);
      doc.text(`Malzeme: ${toAscii(material) || "-"}`);
      doc.text(`Tahmini isleme suresi (birim): ${quote.minutes} dk`);
      doc.text(`Adet: ${quote.quantity ?? 1}`);
      doc.text(`Hesaplama modu: ${quote.mode === "detayli" ? "Detayli" : "Basit"}`);
      doc.moveDown(0.8);

      doc.fontSize(13).text("Maliyet Dokumu", { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(11);
      const leftX = 60;
      const rightX = 400;
      for (const it of quote.items) {
        const y = doc.y;
        doc.text(toAscii(it.label), leftX, y);
        doc.text(fmtTL(it.amount), rightX, y, { align: "right", width: 90 });
        doc.moveDown(0.3);
      }
      doc.moveDown(0.4);
      doc.moveTo(leftX, doc.y).lineTo(490, doc.y).stroke("#999");
      doc.moveDown(0.4);

      const qty = quote.quantity ?? 1;
      if (qty > 1) {
        const uy = doc.y;
        doc.fontSize(11).text("Birim Fiyat", leftX, uy);
        doc.text(fmtTL(quote.unitPrice), rightX, uy, { align: "right", width: 90 });
        doc.moveDown(0.4);
      }
      const ty = doc.y;
      doc.fontSize(14).text(qty > 1 ? `TOPLAM (${qty} adet)` : "TOPLAM", leftX, ty);
      doc.fontSize(14).text(fmtTL(quote.total), rightX, ty, { align: "right", width: 90 });

      doc.moveDown(2);
      doc.fontSize(8).fillColor("#888")
        .text("Bu teklif otomatik hesaplanmistir; baglayici degildir.", { align: "center" });

      doc.end();
      stream.on("finish", () => resolve(pdfPath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
