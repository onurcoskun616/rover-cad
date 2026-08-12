import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";

const CACHE_SCHEMA_VERSION = 1;
const ALLOWED_MODES = new Set(["off", "observe", "read"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cacheMode() {
  const requested = String(config.promptCache?.mode ?? "observe").toLowerCase();
  return ALLOWED_MODES.has(requested) ? requested : "observe";
}

export function normalizeTechnicalPrompt(prompt) {
  return String(prompt ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ")
    .trim();
}

function safeScopeId(value) {
  const raw = String(value ?? "anonymous");
  return sha256(raw).slice(0, 32);
}

function readSystemPromptDigest(systemPromptFile) {
  try {
    return sha256(fs.readFileSync(systemPromptFile));
  } catch (error) {
    console.warn("[prompt-cache] system prompt okunamadi; cache devre disi:", error.message);
    return null;
  }
}

function modelIdentity() {
  if (config.llmProvider === "openai") {
    return config.openai.model || "openai-default";
  }
  return config.claudeCli.model || "claude-cli-default";
}

function cacheRoot() {
  return path.resolve(config.promptCache?.dir ?? path.join(config.dataDir, "prompt-cache"));
}

function entryPath(scope, key) {
  return path.join(cacheRoot(), "private", safeScopeId(scope), `${key}.json`);
}

function telemetryPath() {
  return path.join(cacheRoot(), "telemetry.jsonl");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("[prompt-cache] kayit okunamadi:", error.message);
    }
    return null;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function appendTelemetry(event) {
  try {
    fs.mkdirSync(cacheRoot(), { recursive: true });
    fs.appendFileSync(
      telemetryPath(),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn("[prompt-cache] telemetri yazilamadi:", error.message);
  }
}

export function preparePromptCache({ prompt, operation, userId, systemPromptFile }) {
  const mode = cacheMode();
  if (mode === "off") return null;

  const systemPromptSha256 = readSystemPromptDigest(systemPromptFile);
  if (!systemPromptSha256) return null;

  const scope = userId || "anonymous";
  const descriptor = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    operation,
    normalizedPrompt: normalizeTechnicalPrompt(prompt),
    llmProvider: config.llmProvider,
    llmModel: modelIdentity(),
    systemPromptSha256,
    pipelineVersion: config.promptCache?.pipelineVersion ?? "1",
    freecadCompatibility: config.promptCache?.freecadCompatibility ?? "unspecified",
  };
  const key = sha256(JSON.stringify(descriptor));
  const filePath = entryPath(scope, key);
  const cached = readJson(filePath);
  const hit = Boolean(cached?.validated && typeof cached.code === "string");

  appendTelemetry({
    type: hit ? "hit" : "miss",
    mode,
    operation,
    key,
    scope: safeScopeId(scope),
  });
  console.log(`[prompt-cache] ${hit ? "HIT" : "MISS"} mode=${mode} operation=${operation} key=${key.slice(0, 12)}`);

  return {
    key,
    mode,
    descriptor,
    cachedCode: hit ? cached.code : null,
    mayReuse: mode === "read" && hit,
    recordValidated({ code, bbox = null, metadata = null }) {
      if (typeof code !== "string" || !code.trim()) return;
      const codeSha256 = sha256(code);
      const observedMatch = hit ? cached.codeSha256 === codeSha256 : null;
      const entry = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        key,
        descriptor,
        originalPrompt: String(prompt),
        code,
        codeSha256,
        bbox,
        metadata,
        validated: true,
        validatedAt: new Date().toISOString(),
        previousValidatedAt: cached?.validatedAt ?? null,
      };

      try {
        if (!(hit && mode === "observe")) {
          atomicWriteJson(filePath, entry);
        }
        appendTelemetry({
          type: hit && mode === "observe" ? "observation-result" : "validated-write",
          mode,
          operation,
          key,
          scope: safeScopeId(scope),
          observedMatch,
        });
      } catch (error) {
        console.warn("[prompt-cache] dogrulanmis kayit yazilamadi:", error.message);
      }
    },
  };
}
