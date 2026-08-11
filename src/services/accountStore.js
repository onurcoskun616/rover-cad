import { config } from "../config.js";
import { database } from "./database.js";

function number(value) {
  return Number(value || 0);
}

function publicUser(row) {
  const monthlyTokens = number(row.monthly_token_limit);
  const usedTokens = number(row.used_tokens);
  const reservedTokens = number(row.reserved_tokens);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    plan: row.plan,
    status: row.status,
    monthlyTokens,
    usedTokens,
    reservedTokens,
    remainingTokens: Math.max(0, monthlyTokens - usedTokens - reservedTokens),
    usageMonth: row.usage_month,
    createdAt: row.created_at,
  };
}

export async function ensureProfile(authUser) {
  if (!authUser?.id) throw Object.assign(new Error("Kullanıcı kimliği alınamadı"), { status: 401 });
  const email = String(authUser.email ?? "").trim().toLowerCase();
  const name = String(authUser.user_metadata?.name || authUser.user_metadata?.full_name || "").trim();
  await database().query(
    `insert into public.profiles (id, name, email, role, monthly_token_limit)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set
       name = case when excluded.name <> '' then excluded.name else public.profiles.name end,
       email = excluded.email,
       role = case when excluded.email = $6 then 'admin' else public.profiles.role end,
       updated_at = now()`,
    [authUser.id, name, email, email === config.adminEmail ? "admin" : "user", config.freeMonthlyTokens, config.adminEmail],
  );
  return getUser(authUser.id);
}

export async function getUser(id) {
  await database().query(
    `update public.profiles set used_tokens = 0, reserved_tokens = 0,
       usage_month = to_char(now() at time zone 'Europe/Istanbul', 'YYYY-MM'), updated_at = now()
     where id = $1 and usage_month <> to_char(now() at time zone 'Europe/Istanbul', 'YYYY-MM')`,
    [id],
  );
  const result = await database().query("select * from public.profiles where id = $1", [id]);
  return result.rows[0] ? publicUser(result.rows[0]) : null;
}

export async function listUsage(userId, limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const result = await database().query(
    `select id, feature as action, provider, model, input_tokens as "inputTokens",
            output_tokens as "outputTokens", cache_read_tokens as "cacheReadTokens",
            cache_write_tokens as "cacheWriteTokens", total_tokens as tokens,
            measured, cost_usd as "costUsd", created_at as "createdAt"
       from public.llm_usage
      where user_id = $1 and status = 'completed'
      order by created_at desc limit $2`,
    [userId, safeLimit],
  );
  return result.rows.map((row) => ({
    ...row,
    inputTokens: number(row.inputTokens), outputTokens: number(row.outputTokens),
    cacheReadTokens: number(row.cacheReadTokens), cacheWriteTokens: number(row.cacheWriteTokens),
    tokens: number(row.tokens), costUsd: row.costUsd === null ? null : Number(row.costUsd),
  }));
}

export async function listUsers() {
  const result = await database().query("select * from public.profiles order by created_at desc");
  return result.rows.map(publicUser);
}

export async function updateUser(id, changes) {
  const allowed = {
    status: ["active", "blocked"].includes(changes.status) ? changes.status : null,
    role: ["user", "admin"].includes(changes.role) ? changes.role : null,
    plan: ["free", "pro", "enterprise"].includes(changes.plan) ? changes.plan : null,
    monthlyTokens: Number.isFinite(Number(changes.monthlyTokens)) ? Math.max(0, Math.floor(Number(changes.monthlyTokens))) : null,
  };
  const result = await database().query(
    `update public.profiles set
       status = coalesce($2, status), role = coalesce($3, role), plan = coalesce($4, plan),
       monthly_token_limit = coalesce($5, monthly_token_limit), updated_at = now()
     where id = $1 returning *`,
    [id, allowed.status, allowed.role, allowed.plan, allowed.monthlyTokens],
  );
  if (!result.rows[0]) throw Object.assign(new Error("Kullanıcı bulunamadı"), { status: 404 });
  return publicUser(result.rows[0]);
}

export async function stats() {
  const result = await database().query(
    `select count(*)::bigint as users,
            count(*) filter (where status = 'active')::bigint as active_users,
            coalesce(sum(used_tokens) filter (
              where usage_month = to_char(now() at time zone 'Europe/Istanbul', 'YYYY-MM')
            ), 0)::bigint as monthly_tokens_used
       from public.profiles`,
  );
  const row = result.rows[0];
  return {
    users: number(row.users),
    activeUsers: number(row.active_users),
    monthlyTokensUsed: number(row.monthly_tokens_used),
  };
}

export async function usageSummary(days = 31) {
  const safeDays = Math.min(366, Math.max(1, Number(days) || 31));
  const result = await database().query(
    `select feature, provider, model,
            count(*)::bigint as calls,
            coalesce(sum(input_tokens), 0)::bigint as input_tokens,
            coalesce(sum(output_tokens), 0)::bigint as output_tokens,
            coalesce(sum(cache_read_tokens), 0)::bigint as cache_read_tokens,
            coalesce(sum(cache_write_tokens), 0)::bigint as cache_write_tokens,
            coalesce(sum(total_tokens), 0)::bigint as total_tokens,
            coalesce(sum(cost_usd), 0)::numeric as cost_usd
       from public.llm_usage
      where status = 'completed' and created_at >= now() - ($1::text || ' days')::interval
      group by feature, provider, model
      order by total_tokens desc`,
    [safeDays],
  );
  return result.rows.map((row) => ({
    feature: row.feature, provider: row.provider, model: row.model,
    calls: number(row.calls), inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens), cacheReadTokens: number(row.cache_read_tokens),
    cacheWriteTokens: number(row.cache_write_tokens), totalTokens: number(row.total_tokens),
    costUsd: Number(row.cost_usd || 0),
  }));
}
