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
  authSecret: process.env.AUTH_SECRET ?? "change-me-in-production",
  freeMonthlyTokens: Number(process.env.FREE_MONTHLY_TOKENS ?? 50000),
  adminEmail: (process.env.ADMIN_EMAIL ?? "").toLowerCase(),
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
