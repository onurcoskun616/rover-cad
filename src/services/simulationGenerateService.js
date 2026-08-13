import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLlm, stripCodeFence } from "./claudeCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SIM_PROMPT_FILE = path.join(__dirname, "..", "prompts", "sim-system-prompt.txt");

function looksLikeSimCode(text) {
  if (!text) return false;
  return /\b(FreeCAD|Part|Mesh)\b/.test(text) && /PART_STL/.test(text);
}

export async function promptToSimCode(prompt, previousCode, previousKinematics) {
  let input;
  if (previousCode) {
    input = "[MEVCUT DURUM]\n--- Mevcut Python Kodu ---\n" + previousCode + "\n";
    if (previousKinematics) {
      const kinStr = typeof previousKinematics === "string"
        ? previousKinematics
        : JSON.stringify(previousKinematics, null, 2);
      input += "\n--- Mevcut kinematics.json ---\n" + kinStr + "\n";
    }
    input +=
      "\n[KULLANICI ISTEGI]: " + prompt + "\n\n" +
      "[GOREV]: Mevcut mekanizmaya yukaridaki istegi ekle veya degistir.\n" +
      "Kural 1: Her yeni parca icin ROVER_PARAMS bloguna parametre ekle.\n" +
      "Kural 2: Yeni parcayi bagimsiz Part::Feature olarak olustur (fuse yapma).\n" +
      "Kural 3: kinematics.json'a yeni joint/constraint ekle.\n" +
      "Kural 4: Mevcut tum parcalari, joint'leri ve constraint'leri aynen koru.\n" +
      "SADECE guncellenmis tam Python kodunu dondur.";
  } else {
    input = `[ISTEK]: ${prompt}`;
  }

  const raw = await runLlm(input, {
    systemPromptFile: SIM_PROMPT_FILE,
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
