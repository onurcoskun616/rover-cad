import spawn from "cross-spawn";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEXT_PROMPT_FILE = path.join(__dirname, "..", "prompts", "freecad-system-prompt.txt");
const IMAGE_PROMPT_FILE = path.join(
  __dirname,
  "..",
  "prompts",
  "freecad-image-system-prompt.txt",
);

// Every tool the code-translation call has no business using. For the image
// flow Read is removed from this list (the model must open the drawing).
const BASE_DISALLOWED = [
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

// Defense in depth: the model can still ignore the system prompt and reply with
// prose (a clarifying question, an apology, an OpenSCAD snippet) instead of
// FreeCAD Python. Catch that here so the build pipeline can retry instead of
// letting it hit FreeCAD as a cryptic SyntaxError in the Report View.
function looksLikePythonCode(text) {
  if (!text) return false;
  const hasAssignmentOrCall = /[=(]/.test(text);
  const mentionsFreecad = /\b(doc|FreeCAD|Part|Draft|App)\b/.test(text);
  // A leading standalone question mark line is a strong "it asked a question"
  // tell; a "?" buried inside otherwise-valid code (a regex, a string) is fine.
  const looksLikeQuestion = /^[^\n]*\?\s*$/.test(text.trim()) && !mentionsFreecad;
  return hasAssignmentOrCall && mentionsFreecad && !looksLikeQuestion;
}

function correctionSuffix(correction) {
  if (!correction?.previousCode) return "";
  return (
    `\n\n[ONCEKI_KOD]:\n${correction.previousCode}` +
    `\n\n[SORUN]: ${correction.problem}` +
    "\n\n[GOREV]: Yukaridaki sorunu gider ve DUZELTILMIS tam Python kodunu bastan yaz. " +
    "Hicbir soru sorma, hicbir aciklama yazma. SADECE ham Python kodu."
  );
}

/**
 * Text prompt -> FreeCAD Python. Makes a single CLI call.
 * @param {string} prompt
 * @param {{previousCode?: string, problem?: string}} [correction] self-correction context
 */
export async function promptToFreecadCode(prompt, correction) {
  const input = `[MEVCUT_ISTEK]: ${prompt}` + correctionSuffix(correction);
  return runClaudeCli(input, { systemPromptFile: TEXT_PROMPT_FILE, allowRead: false });
}

/**
 * Technical-drawing image -> FreeCAD Python. Makes a single CLI call with the
 * Read tool enabled so the model can open the drawing.
 * @param {string} imagePath absolute path to the uploaded image
 * @param {string} [prompt] optional extra instruction from the user
 * @param {{previousCode?: string, problem?: string}} [correction]
 */
export async function promptToFreecadCodeFromImage(imagePath, prompt, correction) {
  let input = `[MEVCUT_ISTEK]: Ekteki teknik resmi (dosya yolu: ${imagePath}) oku ve icindeki parcayi 3D model olarak olustur.`;
  if (prompt && prompt.trim()) {
    input += ` Ek talimat: ${prompt.trim()}`;
  }
  input += correctionSuffix(correction);
  return runClaudeCli(input, { systemPromptFile: IMAGE_PROMPT_FILE, allowRead: true });
}

function runClaudeCli(cliInput, { systemPromptFile, allowRead }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      cliInput,
      "--system-prompt-file",
      systemPromptFile,
      "--output-format",
      "text",
    ];

    if (allowRead) {
      // Whitelist Read only; everything else stays off.
      args.push("--allowedTools", "Read");
      args.push("--disallowedTools", ...BASE_DISALLOWED.filter((t) => t !== "Read"));
    } else {
      args.push("--disallowedTools", ...BASE_DISALLOWED);
    }

    if (config.claudeCli.model) {
      args.push("--model", config.claudeCli.model);
    }

    const child = spawn(config.claudeCli.command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Run outside the project directory so this one-shot code-translation call
      // doesn't pick up this project's name, CLAUDE.md, or other ambient context
      // and start reasoning about the backend's own side effects instead of just
      // emitting code.
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
