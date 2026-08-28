import { MATERIAL_CUTTING_DATA } from "./materialCuttingData.js";

// Maliyet Hesaplama (Malzeme + İşçilik): a "basit" (simple) cost estimate
// for a stock-cam plan, matching quoteService.js's own "basit" mode shape
// ({items, subtotal, total}) so the UI reads the same way as the STEP-file
// wizard's existing CAM Assistant quote engine. Deliberately NOT sharing
// that service's code: its material vocabulary is Turkish display-name
// keys ("Aluminyum", "Pirinc/Bronz", ...), stock-cam's is its own English
// keys (steel/aluminum/...) — reconciling the two would need a translation
// layer for no real benefit, so this is Stock-CAM's own small,
// self-contained equivalent, reusing materialCuttingData.js's density
// table (a real physical constant) as its only shared source of data.
//
// Material price (per kg) and hourly machine/labor rate are NEVER
// hardcoded or defaulted to a guessed number -- unlike a physical cutting
// constant (Vc, density), market price and labor rate aren't fixed
// physical facts this codebase could look up; the operator supplies
// their own current numbers each time, exactly like the STEP-file
// wizard's own /cam-quote already requires.

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Stock volume (mm^3, converted to cm^3) -- the RAW block purchased, not
// the finished part's net volume: a shop pays for the whole stock, not
// just what stays in the part after machining.
export function stockVolumeCm3(stock) {
  return (num(stock?.w) * num(stock?.d) * num(stock?.h)) / 1000;
}

export function computeStockCamCost({ stock, material, minutes, materialPricePerKg, hourlyRate, profitPct }) {
  const density = MATERIAL_CUTTING_DATA[material]?.density ?? MATERIAL_CUTTING_DATA.steel.density;
  const weightKg = (stockVolumeCm3(stock) * density) / 1000;
  const matCost = round2(num(materialPricePerKg) * weightKg);

  const min = num(minutes);
  const rate = num(hourlyRate);
  const laborCost = round2((min / 60) * rate);

  const items = [
    { label: "Malzeme", amount: matCost },
    { label: `İşlem (${round2(min)} dk x ${rate} TL/saat)`, amount: laborCost },
  ];
  const subtotal = matCost + laborCost;
  const profit = round2((subtotal * num(profitPct)) / 100);
  items.push({ label: `Kâr marjı (%${num(profitPct)})`, amount: profit });
  const total = round2(subtotal + profit);

  return { minutes: round2(min), weightKg: round2(weightKg), items, subtotal: round2(subtotal), total };
}
