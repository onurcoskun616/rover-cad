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

// Windows CMD mangles special chars (<, >, {, }, |, &, etc.) in -p arguments
// even through cross-spawn escaping. For long or complex prompts, pipe through
// stdin instead — the CLI prepends piped content to the -p user message.
const PIPE_THRESHOLD = 400;

/**
 * Run the Claude Code CLI once and return its raw stdout (trimmed). This is the
 * shared low-level entry point for every "ask Claude to translate X" call in the
 * backend; callers layer their own validation/parsing on top.
 *
 * @param {string} input the prompt text
 * @param {{systemPromptFile: string, allowRead?: boolean}} opts
 * @returns {Promise<string>} raw stdout, trimmed
 */
export function runClaudeCli(input, { systemPromptFile, allowRead = false }) {
  return new Promise((resolve, reject) => {
    const promptExists = fs.existsSync(systemPromptFile);
    const usePipe = input.length > PIPE_THRESHOLD;
    console.log(
      `Claude CLI: prompt file ${promptExists ? "exists" : "MISSING"}: ${systemPromptFile}, ` +
      `input ${input.length} chars, delivery=${usePipe ? "stdin" : "arg"}`,
    );

    const args = [
      "-p",
      usePipe ? "Yukaridaki talimatlara yanit ver." : input,
      "--system-prompt-file",
      systemPromptFile,
      "--output-format",
      "text",
    ];

    args.push("--max-turns", "1");

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
      stdio: [usePipe ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: os.tmpdir(),
    });

    if (usePipe) {
      child.stdin.write(input);
      child.stdin.end();
    }

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
      console.error("Claude CLI spawn error:", err.message);
      reject(err);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const outTrimmed = stdout.trim();
      console.log(
        `Claude CLI exited ${exitCode}, stdout ${outTrimmed.length} chars: ${outTrimmed.slice(0, 200)}`,
      );
      if (stderr.trim()) {
        console.log(`Claude CLI stderr: ${stderr.trim().slice(0, 300)}`);
      }

      if (exitCode !== 0) {
        reject(
          new Error(
            `Claude Code CLI exited with code ${exitCode}: ${stderr || stdout || "no output"}`,
          ),
        );
        return;
      }

      if (!outTrimmed) {
        reject(new Error("Claude Code CLI returned empty output"));
        return;
      }
      resolve(outTrimmed);
    });
  });
}
