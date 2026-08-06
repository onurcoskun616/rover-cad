import spawn from "cross-spawn";
import fs from "node:fs";
import os from "node:os";
import { config } from "../config.js";

// Every tool a one-shot translation call has no business using. For flows that
// must read an uploaded file, "Read" is removed from this list by the caller.
export const BASE_DISALLOWED = [
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

// Strip a leading ```lang fence and trailing ``` if the model wrapped its answer
// in a markdown code block, regardless of the language tag.
export function stripCodeFence(text) {
  const trimmed = String(text ?? "").trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Run the Claude Code CLI once and return its raw stdout (trimmed). This is the
 * shared low-level entry point for every "ask Claude to translate X" call in the
 * backend; callers layer their own validation/parsing on top.
 *
 * The system prompt is read from the file and embedded directly into the -p
 * argument (not via --system-prompt-file) because the latter was silently
 * ignored on the user's Windows setup.
 *
 * @param {string} input the user prompt text
 * @param {{systemPromptFile: string, allowRead?: boolean}} opts
 * @returns {Promise<string>} raw stdout, trimmed
 */
export function runClaudeCli(input, { systemPromptFile, allowRead = false }) {
  return new Promise((resolve, reject) => {
    // Read the system prompt and embed it at the top of the -p argument so the
    // model always receives its role instructions regardless of whether
    // --system-prompt-file works.
    let systemPrompt = "";
    try {
      systemPrompt = fs.readFileSync(systemPromptFile, "utf8").trim();
    } catch (err) {
      console.error(`System prompt file read failed: ${systemPromptFile}`, err.message);
    }

    const fullPrompt = systemPrompt
      ? `<system>\n${systemPrompt}\n</system>\n\n${input}`
      : input;

    console.log(
      `Claude CLI: system prompt ${systemPrompt ? "OK" : "MISSING"} (${systemPrompt.length} chars), ` +
      `input ${input.length} chars, total ${fullPrompt.length} chars`,
    );

    const args = [
      "-p",
      fullPrompt,
      "--output-format",
      "text",
      "--max-turns",
      "1",
    ];

    if (allowRead) {
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
      cwd: os.tmpdir(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error("Timed out waiting for Claude Code CLI"));
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

      const out = stdout.trim();
      if (!out) {
        reject(new Error("Claude Code CLI returned empty output"));
        return;
      }
      resolve(out);
    });
  });
}
