import { database } from "./database.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function publicQuote(row) {
  return {
    id: row.id,
    quoteNumber: row.quote_number,
    partName: row.part_name,
    material: row.material,
    mode: row.mode,
    quantity: row.quantity,
    minutes: num(row.minutes),
    subtotal: num(row.subtotal),
    unitPrice: num(row.unit_price),
    total: num(row.total),
    currency: row.currency,
    items: row.items,
    bbox: row.bbox,
    tolerance: row.tolerance,
    surfaceFinish: row.surface_finish,
    validityDays: row.validity_days,
    validUntil: row.valid_until,
    pdfUrl: row.pdf_url,
    createdAt: row.created_at,
  };
}

// Persists one computed quote (computeQuote's result) against the requesting
// user and assigns it a sequential "TEKLİF NO" (quotes.quote_number, a
// generated column -- see supabase/migrations/202608300001_quotes.sql).
// Called from the shared POST /cam-quote route (camAssistant.js), used by
// both web/teklif.html ("Anında Teklif Al") and cam.html's own quote form.
export async function saveQuote(userId, { partName, material, quote, bbox, tolerance, surfaceFinish, validityDays, pdfUrl }) {
  const days = Math.max(0, Math.round(num(validityDays)));
  const validUntil = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  const result = await database().query(
    `insert into public.quotes
       (user_id, part_name, material, mode, quantity, minutes, subtotal, unit_price, total, items, bbox, tolerance, surface_finish, validity_days, valid_until, pdf_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [
      userId,
      String(partName ?? ""),
      String(material ?? ""),
      quote?.mode === "detayli" ? "detayli" : "basit",
      Math.max(1, Math.round(num(quote?.quantity) || 1)),
      num(quote?.minutes),
      num(quote?.subtotal),
      num(quote?.unitPrice),
      num(quote?.total),
      JSON.stringify(quote?.items ?? []),
      JSON.stringify(bbox ?? {}),
      String(tolerance ?? ""),
      String(surfaceFinish ?? ""),
      days,
      validUntil,
      pdfUrl ?? null,
    ],
  );
  return publicQuote(result.rows[0]);
}

export async function listQuotesForUser(userId, limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const result = await database().query(
    "select * from public.quotes where user_id = $1 order by created_at desc limit $2",
    [userId, safeLimit],
  );
  return result.rows.map(publicQuote);
}

export async function quoteStatsForUser(userId) {
  const result = await database().query(
    `select count(*)::bigint as total_count, coalesce(sum(total), 0)::numeric as total_amount
       from public.quotes where user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return { totalCount: num(row?.total_count), totalAmount: num(row?.total_amount) };
}
