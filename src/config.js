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
  apiKey: process.env.API_KEY ?? "",
  freecadMcp: {
    command: process.env.FREECAD_MCP_COMMAND ?? "uvx",
    args: freecadArgs,
    toolName: process.env.FREECAD_MCP_TOOL_NAME ?? "execute_code",
    toolParam: process.env.FREECAD_MCP_TOOL_PARAM ?? "code",
    callTimeoutMs: Number(process.env.FREECAD_MCP_CALL_TIMEOUT_MS ?? 90000),
  },
  claudeCli: {
    command: process.env.CLAUDE_CLI_COMMAND ?? "claude",
    model: process.env.CLAUDE_CLI_MODEL ?? "",
    timeoutMs: Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 180000),
  },
};
