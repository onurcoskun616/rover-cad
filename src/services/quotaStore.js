import { database } from "./database.js";

function quotaError(error) {
  if (error?.code === "P0001" && /QUOTA_EXCEEDED/.test(error.message)) {
    return Object.assign(new Error("Aylık ücretsiz token limitinize ulaştınız"), {
      status: 402,
      code: "QUOTA_EXCEEDED",
    });
  }
  if (error?.code === "P0001" && /ACCOUNT_BLOCKED/.test(error.message)) {
    return Object.assign(new Error("Hesabınız kullanıma kapalı"), {
      status: 403,
      code: "ACCOUNT_BLOCKED",
    });
  }
  return error;
}

export async function reserveLlmTokens({ userId, estimatedTokens, feature, provider, model }) {
  try {
    const result = await database().query(
      "select * from reserve_llm_tokens($1, $2, $3, $4, $5)",
      [userId, Math.max(1, Math.ceil(estimatedTokens)), feature, provider, model],
    );
    return result.rows[0];
  } catch (error) {
    throw quotaError(error);
  }
}

export async function settleLlmTokens(reservationId, usage) {
  const result = await database().query(
    "select * from settle_llm_tokens($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      reservationId,
      Math.max(0, Number(usage.inputTokens) || 0),
      Math.max(0, Number(usage.outputTokens) || 0),
      Math.max(0, Number(usage.cacheReadTokens) || 0),
      Math.max(0, Number(usage.cacheWriteTokens) || 0),
      usage.providerRequestId || null,
      Number.isFinite(Number(usage.costUsd)) ? Number(usage.costUsd) : null,
      usage.measured !== false,
    ],
  );
  return result.rows[0];
}

export async function releaseLlmReservation(reservationId, reason) {
  await database().query("select release_llm_reservation($1, $2)", [
    reservationId,
    String(reason || "LLM call failed").slice(0, 500),
  ]);
}

export async function resetExpiredFreeQuotas() {
  const result = await database().query("select reset_expired_free_quotas() as reset_count");
  return Number(result.rows[0]?.reset_count || 0);
}
