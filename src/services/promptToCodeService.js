import spawn from "cross-spawn";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_FILE = path.join(__dirname, "..", "prompts", "freecad-system-prompt.txt");

const DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Agent",
  "Task",
  "TodoWrite",
];

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:python)?\s*\n([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

// Defense in depth: the model can still ignore the system prompt and reply
// with prose (a clarifying question, an apology, etc.) instead of code.
// Catch that here instead of letting it hit FreeCAD as a cryptic
// SyntaxError inside the Report View.
function looksLikePythonCode(text) {
  if (!text) return false;
  if (text.includes("?")) return false;
  const hasAssignmentOrCall = /[=(]/.test(text);
  const mentionsDoc = /\bdoc\b/.test(text);
  return hasAssignmentOrCall && mentionsDoc;
}

const MAX_ATTEMPTS = 3;

const RETRY_REMINDER =
  "\n\n[HATIRLATMA]: Onceki cevabinda kod yerine soru/aciklama/onay istegi yazdin, bu gecersiz. " +
  "Hicbir soru sorma, hicbir onay isteme, hicbir format sec-secenegi sunma. SADECE ham Python kodu yaz.";

export async function promptToFreecadCode(prompt, previousPrompt) {
  const baseCliInput = previousPrompt
    ? `[ONCEKI_ISTEK]: ${previousPrompt}\n[MEVCUT_ISTEK]: ${prompt}`
    : `[MEVCUT_ISTEK]: ${prompt}`;

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const cliInput = attempt === 1 ? baseCliInput : baseCliInput + RETRY_REMINDER;
    try {
      return await runClaudeCli(cliInput);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function runClaudeCli(cliInput) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      cliInput,
      "--system-prompt-file",
      SYSTEM_PROMPT_FILE,
      "--output-format",
      "text",
      "--disallowedTools",
      ...DISALLOWED_TOOLS,
    ];

    if (config.claudeCli.model) {
      args.push("--model", config.claudeCli.model);
    }

    const child = spawn(config.claudeCli.command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Run outside the project directory so this one-shot code-translation
      // call doesn't pick up this project's name, CLAUDE.md, or other
      // ambient context and start reasoning about the backend's own side
      // effects instead of just emitting code.
      cwd: os.tmpdir(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error("Timed out waiting for Claude Code CLI to generate FreeCAD code"));
    }, config.claudeCli.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (exitCode !== 0) {
        reject(
          new Error(
            `Claude Code CLI exited with code ${exitCode}: ${stderr || stdout || "no output"}`,
          ),
        );
        return;
      }

      const code = stripCodeFence(stdout);
      if (!code) {
        reject(new Error("Claude Code CLI returned empty code"));
        return;
      }
      if (!looksLikePythonCode(code)) {
        reject(
          new Error(
            `Claude Code CLI did not return FreeCAD Python code, it returned: ${code}`,
          ),
        );
        return;
      }
      resolve(code);
    });
  });
}
