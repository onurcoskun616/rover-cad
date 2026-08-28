import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
let pool;

export function database() {
  const hasDatabaseUrl = Boolean(config.databaseUrl);
  const hasDatabaseParts = Boolean(config.database.host && config.database.user && config.database.password);

  if (!hasDatabaseUrl && !hasDatabaseParts) {
    throw Object.assign(
      new Error("DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD is required for account and quota operations"),
      { status: 503, code: "DATABASE_NOT_CONFIGURED" },
    );
  }
  if (!pool) {
    pool = new Pool({
      ...(hasDatabaseUrl
        ? { connectionString: config.databaseUrl }
        : {
            host: config.database.host,
            port: config.database.port,
            database: config.database.name,
            user: config.database.user,
            password: config.database.password,
          }),
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
