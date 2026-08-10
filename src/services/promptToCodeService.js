import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLlm, stripCodeFence } from "./claudeCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEXT_PROMPT_FILE = path.join(__dirname, "..", "prompts", "freecad-system-prompt.txt");
const IMAGE_PROMPT_FILE = path.join(
  __dirname,
  "..",
  "prompts",
  "freecad-image-system-prompt.txt",
);

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

function validatePython(raw) {
  const code = stripCodeFence(raw);
  if (!code) {
    throw new Error("Claude Code CLI returned empty code");
  }
  if (!looksLikePythonCode(code)) {
    throw new Error(
      `Claude Code CLI did not return FreeCAD Python code, it returned: ${code}`,
    );
  }
  return code;
}

/**
 * Text prompt -> FreeCAD Python. Makes a single CLI call.
 * @param {string} prompt
 * @param {{previousCode?: string, problem?: string}} [correction] self-correction context
 */
export async function promptToFreecadCode(prompt, correction) {
  const input = `[MEVCUT_ISTEK]: ${prompt}` + correctionSuffix(correction);
  const raw = await runLlm(input, {
    systemPromptFile: TEXT_PROMPT_FILE,
  });
  return validatePython(raw);
}

/**
 * Revise an existing design. Feeds the current FreeCAD Python plus a change
 * request back to the model and asks for the full updated code, preserving the
 * parts the user didn't ask to change. Used for iterative editing after a model
 * has been created.
 * @param {string} previousCode the current design's FreeCAD Python
 * @param {string} instruction the user's change request
 * @param {string} [basePrompt] the original request, for context
 */
export async function promptToFreecadCodeRevision(previousCode, instruction, basePrompt) {
  const input =
    (basePrompt ? `[ORIJINAL_ISTEK]: ${basePrompt}\n\n` : "") +
    `[MEVCUT_KOD]:\n${previousCode}\n\n` +
    `[DEGISIKLIK_ISTEGI]: ${instruction}\n\n` +
    "[GOREV]: Yukaridaki mevcut tasarimi degisiklik istegine gore GUNCELLE. " +
    "Degistirilmeyen kisimlari oldugu gibi koru. Hicbir soru sorma, hicbir aciklama yazma. " +
    "SADECE guncellenmis tam Python kodunu dondur.";
  const raw = await runLlm(input, {
    systemPromptFile: TEXT_PROMPT_FILE,
  });
  return validatePython(raw);
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
  const raw = await runLlm(input, {
    systemPromptFile: IMAGE_PROMPT_FILE,
    allowRead: true,
    imagePath,
  });
  return validatePython(raw);
}
