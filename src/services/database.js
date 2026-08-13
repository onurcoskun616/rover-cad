import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
let pool;

export function database() {
  if (!config.databaseUrl) {
    throw Object.assign(
      new Error("DATABASE_URL is required for account and quota operations"),
      { status: 503, code: "DATABASE_NOT_CONFIGURED" },
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
      max: config.databasePoolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (error) => console.error("PostgreSQL pool error:", error));
  }
  return pool;
}

export async function closeDatabase() {
  if (!pool) return;
  const activePool = pool;
  pool = undefined;
  await activePool.end();
}
