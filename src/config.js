import "dotenv/config";
import path from "node:path";

const freecadArgs = (process.env.FREECAD_MCP_ARGS ?? "freecad-mcp")
  .split(" ")
  .filter(Boolean);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  outputDir: path.resolve(process.env.OUTPUT_DIR ?? "output"),
  // Persistent user data (machine/tool inventory). File-based JSON store.
  dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  promptCache: {
    // off: disabled, observe: measure hits but still call the LLM,
    // read: reuse FreeCAD-validated private cache entries.
    mode: (process.env.PROMPT_CACHE_MODE ?? "observe").toLowerCase(),
    dir: path.resolve(process.env.PROMPT_CACHE_DIR ?? path.join(process.env.DATA_DIR ?? "data", "prompt-cache")),
    pipelineVersion: process.env.PROMPT_PIPELINE_VERSION ?? "1",
    freecadCompatibility: process.env.FREECAD_COMPATIBILITY_VERSION ?? "unspecified",
  },
  projectArchive: {
    enabled: process.env.PROJECT_ARCHIVE_ENABLED !== "false",
    dir: path.resolve(process.env.PROJECT_ARCHIVE_DIR ?? path.join(process.env.DATA_DIR ?? "data", "user-storage")),
  },
  freeMonthlyTokens: Number(process.env.FREE_MONTHLY_TOKENS ?? 50000),
  adminEmail: (process.env.ADMIN_EMAIL ?? "").toLowerCase(),
  databaseUrl: process.env.DATABASE_URL ?? "",
  databaseSsl: process.env.DATABASE_SSL !== "false",
  databasePoolSize: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    anonKey: process.env.SUPABASE_ANON_KEY ?? "",
  },
  quotaCron: {
    enabled: process.env.QUOTA_CRON_ENABLED !== "false",
    schedule: process.env.QUOTA_CRON_SCHEDULE ?? "0 0 1 * *",
    timezone: process.env.QUOTA_CRON_TIMEZONE ?? "Europe/Istanbul",
  },
  llmQuota: {
    enforce: process.env.ENFORCE_LLM_QUOTA !== "false",
    maxOutputTokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? 12000),
    tokenEstimateChars: Number(process.env.LLM_TOKEN_ESTIMATE_CHARS ?? 3),
    prices: {
      inputPerMillion: Number(process.env.LLM_INPUT_COST_PER_MILLION ?? 0),
      outputPerMillion: Number(process.env.LLM_OUTPUT_COST_PER_MILLION ?? 0),
      cacheReadPerMillion: Number(process.env.LLM_CACHE_READ_COST_PER_MILLION ?? 0),
      cacheWritePerMillion: Number(process.env.LLM_CACHE_WRITE_COST_PER_MILLION ?? 0),
    },
  },
  // "openai" | "claude" — which LLM backend to use for code generation.
  llmProvider: (process.env.LLM_PROVIDER ?? "claude").toLowerCase(),
  freecadMcp: {
    command: process.env.FREECAD_MCP_COMMAND ?? "uvx",
    args: freecadArgs,
    toolName: process.env.FREECAD_MCP_TOOL_NAME ?? "execute_code",
    toolParam: process.env.FREECAD_MCP_TOOL_PARAM ?? "code",
    callTimeoutMs: Number(process.env.FREECAD_MCP_CALL_TIMEOUT_MS ?? 180000),
  },
  claudeCli: {
    command: process.env.CLAUDE_CLI_COMMAND ?? "claude",
    model: process.env.CLAUDE_CLI_MODEL ?? "",
    timeoutMs: Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 180000),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 180000),
  },
};
