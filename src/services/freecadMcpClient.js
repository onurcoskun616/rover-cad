import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";

let client = null;
let connecting = null;

async function connect() {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const transport = new StdioClientTransport({
      command: config.freecadMcp.command,
      args: config.freecadMcp.args,
    });

    const newClient = new Client(
      { name: "rover-cad-backend", version: "1.0.0" },
      { capabilities: {} },
    );

    await newClient.connect(transport);
    client = newClient;
    return newClient;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function callFreecadTool(toolName, args) {
  const activeClient = await connect();
  const timeoutMs = config.freecadMcp.callTimeoutMs;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting ${timeoutMs}ms for FreeCAD MCP tool "${toolName}" to respond`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      activeClient.callTool({ name: toolName, arguments: args }),
      timeout,
    ]);
  } catch (err) {
    // The underlying call may still be stuck server-side; drop the
    // connection so the next request reconnects instead of reusing a
    // client that can never produce a matching response.
    await disconnectFreecad().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function extractResultText(mcpResult) {
  if (!mcpResult?.content) return "";
  return mcpResult.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export async function disconnectFreecad() {
  if (client) {
    await client.close();
    client = null;
  }
}
