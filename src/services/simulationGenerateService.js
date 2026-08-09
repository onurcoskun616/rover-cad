import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeCli, stripCodeFence } from "./claudeCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIM_PROMPT_FILE = path.join(__dirname, "..", "prompts", "sim-system-prompt.txt");

function looksLikeSimCode(text) {
  if (!text) return false;
  return /\b(FreeCAD|Part|Mesh)\b/.test(text) && /PART_STL/.test(text);
}

export async function promptToSimCode(prompt, previousCode) {
  let input;
  if (previousCode) {
    input =
      `[MEVCUT_KOD]:\n${previousCode}\n\n` +
      `[YENI_ISTEK]: ${prompt}\n\n` +
      "[GOREV]: Mevcut mekanizmaya yukaridaki istegi ekle veya degistir. " +
      "Mevcut parcalari, joint'leri ve constraint'leri koru (kullanici degistirmek istemedikce). " +
      "Yeni parcalari/parametreleri ekle. SADECE guncellenmis tam Python kodunu dondur.";
  } else {
    input = `[ISTEK]: ${prompt}`;
  }

  const raw = await runClaudeCli(input, {
    systemPromptFile: SIM_PROMPT_FILE,
    allowRead: false,
  });

  const code = stripCodeFence(raw);
  if (!code) {
    throw new Error("Claude returned empty code for simulation");
  }
  if (!looksLikeSimCode(code)) {
    throw new Error(`Claude did not return valid simulation code: ${code.slice(0, 200)}`);
  }
  return code;
}
