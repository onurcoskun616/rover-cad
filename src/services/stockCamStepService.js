import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeJson } from "./camAssistantService.js";
import { OPERATION_TYPES, validateOperationParams } from "./stockCamPlanService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STEP_PROMPT = path.join(__dirname, "..", "prompts", "stock-cam-step-system-prompt.txt");

// The menu-driven wizard's parameter-collection step. The LLM's ONLY job
// here is extracting/asking for numbers within the fixed schema from Faz 1
// (stockCamPlanService's OPERATION_TYPES) — it never writes G-code and never
// invents a value the operator didn't state or that isn't a safe, explicit
// default ("merkeze" -> x=0,y=0). Whatever it returns is re-validated by
// validateOperationParams() before this function reports `done: true`, so a
// confident-but-wrong LLM answer still can't slip past the same numeric/
// stock-bounds checks Faz 1 already proved correct — this function can
// relax and finish early, but it can never make an unsafe answer count as
// "confirmed".
export function shapeStepResponse(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Beklenen JSON nesnesi degil");
  }
  const answers = parsed.answers && typeof parsed.answers === "object" ? parsed.answers : {};
  const question = typeof parsed.question === "string" && parsed.question.trim() ? parsed.question.trim() : null;
  const done = Boolean(parsed.done);
  return { answers, question, done };
}

/**
 * Advance the parameter-collection wizard for one operation type by one
 * turn. `knownAnswers` carries forward across calls (the client resends the
 * accumulated set each turn, same stateless-wizard shape as CAM Asistanı's
 * existing /cam-step). Returns either:
 *   { done: true, answers, problems: [] }               -- ready for sticker preview
 *   { done: true, answers, problems: [...] }             -- LLM said done, but our own
 *                                                            validator disagrees; caller
 *                                                            must show `problems`, not proceed
 *   { done: false, answers, question }                   -- still needs an answer
 *
 * `askLlm` defaults to the real Claude CLI call; tests inject a stub so the
 * merge/defaults/validation logic below can be verified without spawning a
 * real LLM process.
 */
export async function getNextParamStep(opType, userMessage, knownAnswers, stock, askLlm = runClaudeJson) {
  const def = OPERATION_TYPES[opType];
  if (!def) {
    throw new Error(`Bilinmeyen islem tipi: ${opType}`);
  }

  const input = JSON.stringify({
    opType,
    opLabel: def.label,
    schema: def.params.map(({ name, label, unit, min, max }) => ({ name, label, unit, min, max })),
    stock,
    userMessage: String(userMessage ?? ""),
    knownAnswers: knownAnswers && typeof knownAnswers === "object" ? knownAnswers : {},
  });

  const { answers: newAnswers, question, done } = await askLlm(
    input,
    STEP_PROMPT,
    shapeStepResponse,
  );

  const merged = { ...(knownAnswers || {}), ...newAnswers };

  // Fill in explicit schema defaults (e.g. dirAngle=0) for anything still
  // missing rather than treating a merely-optional field as a blocker.
  for (const field of def.params) {
    if (merged[field.name] === undefined && field.default !== undefined) {
      merged[field.name] = field.default;
    }
  }

  const requiredMissing = def.params.filter(
    (f) => f.default === undefined && (merged[f.name] === undefined || merged[f.name] === null || merged[f.name] === ""),
  );

  if (!done || requiredMissing.length > 0) {
    return {
      done: false,
      answers: merged,
      question: question || `${requiredMissing[0]?.label ?? "Eksik parametre"} nedir?`,
    };
  }

  const problems = validateOperationParams(opType, merged, stock);
  return { done: true, answers: merged, problems };
}
