import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCliJson } from "../src/services/claudeCli.js";

test("Claude CLI JSON usage is normalized without losing cache tokens", () => {
  const result = parseClaudeCliJson(JSON.stringify({
    result: "print('ok')",
    session_id: "session-1",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 80,
    },
  }));
  assert.equal(result.text, "print('ok')");
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 300,
    cacheWriteTokens: 80,
    measured: true,
  });
  assert.equal(result.costUsd, 0.0123);
});

test("Claude CLI JSON without result is rejected", () => {
  assert.throws(() => parseClaudeCliJson('{"usage":{}}'), /did not contain a result/);
});
