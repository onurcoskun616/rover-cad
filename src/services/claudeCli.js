import spawn from "cross-spawn";
import fs from "node:fs";
import os from "node:os";
import { config } from "../config.js";
import { runOpenAI } from "./openaiClient.js";
import { getLlmContext } from "./llmRequestContext.js";
import { releaseLlmReservation, reserveLlmTokens, settleLlmTokens } from "./quotaStore.js";

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

export function parseClaudeCliJson(raw) {
  const payload = JSON.parse(String(raw));
  const text = String(payload.result ?? "").trim();
  if (!text) throw new Error("Claude Code CLI JSON did not contain a result");
  const usage = payload.usage ?? {};
  return {
    text,
    provider: "claude",
    model: payload.model || config.claudeCli.model || "claude-cli-default",
    providerRequestId: payload.session_id || null,
    costUsd: Number.isFinite(Number(payload.total_cost_usd)) ? Number(payload.total_cost_usd) : null,
    usage: {
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
      measured: Boolean(payload.usage),
    },
  };
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
 * @returns {Promise<{text:string, usage:object, provider:string, model:string}>}
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
      "json",
    ];

    args.push("--max-turns", "3");

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
        const raw = stderr || stdout || "no output";
        let message = `Claude Code CLI exited with code ${exitCode}: ${raw}`;
        try {
          const parsed = JSON.parse(outTrimmed || raw);
          if (parsed.api_error_status === 429) {
            message = "Yapay zeka servisi şu an meşgul. Lütfen birkaç dakika sonra tekrar deneyin.";
          } else if (parsed.result) {
            message = parsed.result;
          }
        } catch {}
        reject(new Error(message));
        return;
      }

      if (!outTrimmed) {
        reject(new Error("Claude Code CLI returned empty output"));
        return;
      }
      try {
        resolve(parseClaudeCliJson(outTrimmed));
      } catch (error) {
        reject(new Error(`Claude Code CLI returned invalid metering JSON: ${error.message}`));
      }
    });
  });
}

/**
 * Unified LLM entry point. Delegates to OpenAI or Claude CLI based on
 * config.llmProvider. All callers should use this instead of runClaudeCli
 * directly.
 *
 * @param {string} input the prompt text
 * @param {{systemPromptFile: string, allowRead?: boolean, imagePath?: string}} opts
 * @returns {Promise<string>} raw LLM output, trimmed
 */
export async function runLlm(input, { systemPromptFile, allowRead = false, imagePath }) {
  const context = getLlmContext();
  if (config.llmQuota.enforce && !context?.userId) {
    throw Object.assign(new Error("LLM çağrısı için kullanıcı kota bağlamı bulunamadı"), {
      status: 500,
      code: "LLM_QUOTA_CONTEXT_MISSING",
    });
  }
  const systemChars = fs.existsSync(systemPromptFile) ? fs.statSync(systemPromptFile).size : 0;
  const estimateChars = Math.max(1, config.llmQuota.tokenEstimateChars);
  const inputEstimate = Math.ceil((systemChars + String(input).length) / estimateChars);
  const estimatedTokens = inputEstimate + Math.max(1, config.llmQuota.maxOutputTokens);
  const provider = config.llmProvider === "openai" ? "openai" : "claude";
  const configuredModel = provider === "openai"
    ? config.openai.model
    : (config.claudeCli.model || "claude-cli-default");
  let reservation;

  if (context?.userId) {
    reservation = await reserveLlmTokens({
      userId: context.userId,
      estimatedTokens,
      feature: context.feature || "unknown",
      provider,
      model: configuredModel,
    });
  }

  try {
    const result = provider === "openai"
      ? await runOpenAI(input, { systemPromptFile, imagePath })
      : await runClaudeCli(input, { systemPromptFile, allowRead });
    const usage = { ...result.usage };
    if (!usage.measured) {
      usage.inputTokens = inputEstimate;
      usage.outputTokens = Math.ceil(result.text.length / estimateChars);
    }
    const prices = config.llmQuota.prices;
    const calculatedCost = (
      (usage.inputTokens || 0) * prices.inputPerMillion
      + (usage.outputTokens || 0) * prices.outputPerMillion
      + (usage.cacheReadTokens || 0) * prices.cacheReadPerMillion
      + (usage.cacheWriteTokens || 0) * prices.cacheWritePerMillion
    ) / 1_000_000;
    if (reservation?.reservation_id) {
      await settleLlmTokens(reservation.reservation_id, {
        ...usage,
        providerRequestId: result.providerRequestId,
        costUsd: result.costUsd ?? calculatedCost,
      });
    }
    return result.text;
  } catch (error) {
    if (reservation?.reservation_id) {
      try { await releaseLlmReservation(reservation.reservation_id, error.message); }
      catch (releaseError) { console.error("LLM token reservation release failed:", releaseError); }
    }
    throw error;
  }
}
