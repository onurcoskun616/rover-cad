// Representative (NOT exact-per-tool) carbide-endmill cutting data, one
// entry per material -- the SAME material keys as web/cnc-sim.html's own
// MAT_DB (steel/aluminum/brass/copper/cast-iron/titanium/wood/plastic/
// acrylic), so a plan's own `material` field lines up directly with the
// simulator's existing material selector rather than inventing a second,
// disconnected material list.
//
// Vc (cutting speed, m/min) and fz (feed per tooth, mm/tooth, 2-flute
// generic carbide endmill assumed) are typical MIDPOINT values from
// widely-cited general machining reference ranges (e.g. steel ~80-120,
// aluminum ~200-400, titanium ~30-60 m/min for carbide tooling) -- a
// reasonable, safe DEFAULT the same way every other geometry-based
// fallback guess in this codebase is (toolDiameterFor's own circPocket/
// hexPocket fractions, etc.), never a substitute for a real speeds-and-
// feeds chart for a specific tool/coating/rigidity combination.
//
// Wood/plastic/acrylic don't follow the same metal-cutting Vc formula in
// practice (a router bit's "right" RPM isn't governed by the same surface-
// speed physics), so they get fixed, representative RPM/feed pairs
// instead -- acrylic in particular needs a much gentler feed than its RPM
// might suggest, since pushing too hard re-melts/welds the chip back onto
// the cut edge.
// `density` (g/cm3) is a real, published physical constant for each
// material (used by stockCamCostService.js for Maliyet Hesaplama's material
// weight/cost) -- unlike Vc/fz above, density isn't a "reasonable default
// standing in for a precise chart", it's the actual physical property.
// Where a material also exists in quoteService.js's own DENSITY_G_CM3 map
// (Celik/Aluminyum/Pirinc-Bronz/Plastik/Ahsap), the value here matches it
// exactly, so the app never shows two different densities for "the same"
// material across its two separate cost tools.
// `coolant` is standard, widely-published shop-floor machining guidance per
// material (real practice, not an invented number) -- most notably: cast
// iron is machined DRY almost universally (its own graphite is a natural
// lubricant; liquid coolant risks thermal-shock cracking and turns the
// graphite dust into an abrasive paste), while titanium needs the opposite
// extreme (flood coolant is effectively mandatory -- its poor thermal
// conductivity concentrates heat at the cutting edge, risking rapid tool
// wear and, at the extreme, a fire).
export const MATERIAL_CUTTING_DATA = {
  steel: { label: "Çelik", vc: 100, fz: 0.05, density: 7.85,
    coolant: { type: "Sulu/Kesme Yağı", note: "Isı ve takım aşınmasını azaltmak için önerilir (zorunlu değil)." } },
  aluminum: { label: "Alüminyum", vc: 300, fz: 0.08, density: 2.70,
    coolant: { type: "Sulu/Sisleme Soğutma", note: "Talaşın takıma yapışmasını (BUE) önlemek için soğutma/yağlama önerilir." } },
  brass: { label: "Pirinç", vc: 175, fz: 0.06, density: 8.50,
    coolant: { type: "Kuru Kesim", note: "Genellikle kuru kesilir; ağır kesimde hafif soğutma yeterli." } },
  copper: { label: "Bakır", vc: 120, fz: 0.06, density: 8.96,
    coolant: { type: "Sulu/Sisleme Soğutma", note: "Yumuşak/yapışkan talaşın atılması ve yüzey kalitesi için soğutma önerilir." } },
  "cast-iron": { label: "Dökme Demir", vc: 80, fz: 0.06, density: 7.20,
    coolant: { type: "KURU KESİM", note: "Soğutma sıvısı KULLANMAYIN — ısıl şok/çatlama riski taşır ve grafit tozuyla karışıp aşındırıcı bir çamur oluşturur." } },
  titanium: { label: "Titanyum", vc: 45, fz: 0.03, density: 4.50,
    coolant: { type: "Bol Sıvı Soğutma (ZORUNLU)", note: "Düşük ısı iletkenliği nedeniyle kesme kenarında ısı birikir — yetersiz soğutma hızlı takım aşınmasına ve yangın riskine yol açabilir." } },
  wood: { label: "Ahşap", fixedRpm: 18000, fixedFeed: 3000, density: 0.70,
    coolant: { type: "Kuru (Toz Emişi)", note: "Sıvı soğutma kullanılmaz — toz emişi/vakum sistemi önerilir." } },
  plastic: { label: "Plastik", fixedRpm: 10000, fixedFeed: 1500, density: 1.20,
    coolant: { type: "Kuru / Hava Üflemeli", note: "Bazı plastikler sıvı soğutucudan olumsuz etkilenebilir (gerilme çatlaması)." } },
  acrylic: { label: "Akrilik", fixedRpm: 12000, fixedFeed: 1000, density: 1.18,
    coolant: { type: "Hava Üflemeli", note: "Sıvı soğutucudan kaçının (çatlama riski) — ısınıp erimeyi önlemek için hava üflemesi yeterlidir." } },
};

const FLUTES_ASSUMED = 2; // generic small-diameter carbide endmill default
const RPM_MIN = 200, RPM_MAX = 24000;
const FEED_MIN = 10, FEED_MAX = 3000;

// Returns { rpm, feed(mm/min) } for the given material + this operation's
// own resolved tool diameter. Unknown/missing material keys fall back to
// steel -- a safe, moderate default rather than silently picking the
// fastest (aluminum) or slowest (titanium) material's numbers.
export function feedSpeedFor(materialKey, toolDiaMm) {
  const mat = MATERIAL_CUTTING_DATA[materialKey] || MATERIAL_CUTTING_DATA.steel;
  if (mat.fixedRpm) {
    return { rpm: mat.fixedRpm, feed: mat.fixedFeed };
  }
  const dia = Math.max(0.1, Number(toolDiaMm) || 6);
  const rawRpm = (mat.vc * 1000) / (Math.PI * dia);
  const rpm = Math.min(RPM_MAX, Math.max(RPM_MIN, Math.round(rawRpm)));
  const rawFeed = rpm * FLUTES_ASSUMED * mat.fz;
  const feed = Math.min(FEED_MAX, Math.max(FEED_MIN, Math.round(rawFeed)));
  return { rpm, feed };
}
