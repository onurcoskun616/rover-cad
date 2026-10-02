/**
 * Architectural facade generation: floor plans / elevations (images or PDF
 * sheets exported from AutoCAD) -> parametric FreeCAD Python.
 *
 * This is a sibling of promptToCodeService's part-oriented generators, not a
 * replacement: it uses its own system prompt with an architectural parameter
 * vocabulary (kat_sayisi, pencere_sayisi, kasa_genisligi, ...) and an explicit
 * "counts must drive loops" rule, because the whole point of this surface is
 * that the user edits a COUNT (3 windows -> 2 or 4) and the facade re-arranges
 * itself without any other change. The generated code still carries the standard
 * ROVER_PARAMS / ROVER_DIMENSIONS / ROVER_ANCHORS blocks, so the existing
 * deterministic param editor (paramEditService) and the 3D viewer work on it
 * unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLlm, stripCodeFence } from "./claudeCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ARCH_PROMPT_FILE = path.join(
  __dirname,
  "..",
  "prompts",
  "arch-facade-system-prompt.txt",
);

// Same defense in depth as promptToCodeService: the model can ignore the system
// prompt and answer with prose. Catch it here so the build pipeline retries
// instead of handing FreeCAD a SyntaxError.
function looksLikePythonCode(text) {
  if (!text) return false;
  const hasAssignmentOrCall = /[=(]/.test(text);
  const mentionsFreecad = /\b(doc|FreeCAD|Part|Draft|App)\b/.test(text);
  const looksLikeQuestion = /^[^\n]*\?\s*$/.test(text.trim()) && !mentionsFreecad;
  return hasAssignmentOrCall && mentionsFreecad && !looksLikeQuestion;
}

function validatePython(raw) {
  const code = stripCodeFence(raw);
  if (!code) {
    throw new Error("Claude Code CLI bos kod dondurdu");
  }
  if (!looksLikePythonCode(code)) {
    throw new Error(
      `Claude Code CLI FreeCAD Python kodu dondurmedi, donen icerik: ${code}`,
    );
  }
  return code;
}

function correctionSuffix(correction) {
  if (!correction?.previousCode) return "";
  return (
    `\n\n[ONCEKI_KOD]:\n${correction.previousCode}` +
    `\n\n[SORUN]: ${correction.problem}` +
    "\n\n[GOREV]: Yukaridaki sorunu gider ve DUZELTILMIS tam Python kodunu bastan yaz. " +
    "Parametre blogunu ve dongu yapisini koru. Hicbir soru sorma, hicbir aciklama yazma. " +
    "SADECE ham Python kodu."
  );
}

// The uploaded sheets are described to the model by absolute path; it opens them
// itself with the Read tool (allowRead). Labelling each path by its role lets the
// model use the plan for depth/wall thickness and the elevation for the window
// grid instead of guessing which drawing is which.
function describeSheets(sheets) {
  return sheets
    .map((sheet, i) => {
      const role = sheet.role ? ` [${sheet.role}]` : "";
      return `  ${i + 1}.${role} ${sheet.filePath}`;
    })
    .join("\n");
}

/**
 * Architectural sheets -> parametric FreeCAD Python for the building mass and
 * its facade openings.
 *
 * @param {{filePath: string, role?: string}[]} sheets uploaded plans/elevations
 * @param {string} [prompt] extra instruction from the user
 * @param {{previousCode?: string, problem?: string}} [correction]
 * @returns {Promise<string>} FreeCAD Python code
 */
export async function archFacadeFromSheets(sheets, prompt, correction) {
  const usable = (sheets ?? []).filter((s) => s?.filePath);
  if (!usable.length) {
    throw new Error("En az bir plan veya cephe dosyasi gereklidir");
  }

  let input =
    "[MEVCUT_ISTEK]: Ekteki mimari cizimleri oku ve binanin kutlesini cephe " +
    "bosluklariyla birlikte PARAMETRIK 3D model olarak olustur.\n\n" +
    `[DOSYALAR]:\n${describeSheets(usable)}\n\n` +
    "[GOREV]: Her dosyayi Read araciyla ac ve incele. Kat yuksekligi, kat sayisi, " +
    "cephe genisligi, duvar kalinligi ve ON CEPHEDEKI KAT BASINA PENCERE ADEDINI " +
    "cizimden oku. Tekrar eden her ogeyi (katlar, pencereler) sayi parametresinden " +
    "gelen dongu ile uret.";

  if (prompt && prompt.trim()) {
    input += `\n\n[EK_TALIMAT]: ${prompt.trim()}`;
  }
  input += correctionSuffix(correction);

  const raw = await runLlm(input, {
    systemPromptFile: ARCH_PROMPT_FILE,
    allowRead: true,
    // The OpenAI path takes a single inline image; the primary sheet is the
    // elevation when we have one, since that is what carries the window grid.
    imagePath:
      usable.find((s) => /cephe|elevation/i.test(s.role ?? ""))?.filePath ??
      usable[0].filePath,
  });
  return validatePython(raw);
}

/**
 * Text-only facade request (no drawing uploaded) -> parametric FreeCAD Python.
 * Same prompt, so the output carries the identical architectural parameter
 * vocabulary and loop structure as the sheet-driven path.
 *
 * @param {string} prompt
 * @param {{previousCode?: string, problem?: string}} [correction]
 */
export async function archFacadeFromText(prompt, correction) {
  const input =
    `[MEVCUT_ISTEK]: ${prompt}\n\n` +
    "[GOREV]: Hicbir cizim verilmedi, tarifi kullan. Eksik olculer icin sistem " +
    "promptundaki Turkiye yapi konvansiyonu degerlerini kullan ve en ustte NOTE " +
    "yorumuyla hangi olcuyu varsaydigini belirt. Tekrar eden her ogeyi sayi " +
    "parametresinden gelen dongu ile uret." +
    correctionSuffix(correction);

  const raw = await runLlm(input, { systemPromptFile: ARCH_PROMPT_FILE });
  return validatePython(raw);
}

// AutoCAD Architecture (ACA) saves walls, curtain walls, mullions and openings
// as custom AEC proxy objects rather than plain lines. Non-ACA readers (FreeCAD's
// importDXF among them) drop those objects or keep only their flattened display
// graphics, so a DXF exported straight from an ACA project tends to arrive empty
// or as unusable fragments. The fix is AutoCAD's EXPORTTOAUTOCAD command, which
// explodes AEC objects into plain geometry first. Detected here so the user is
// told what to do instead of being handed an empty model.
const ACA_MARKERS = [
  "AecDb",
  "AecArch",
  "AEC_REFEDIT",
  "MassElem",
  "AecStru",
];

/**
 * Sniff a DXF/DWG for AutoCAD Architecture proxy objects.
 *
 * The whole file is scanned in bounded chunks rather than sampled from the
 * front: measured on a real 14.5 MB ACA project (AC1018), every AEC class name
 * sat at 99.7% of the file, so a head-only read reports a clean drawing and the
 * user gets an empty model with no explanation. Chunks carry an overlap so a
 * marker straddling a boundary is still found, and memory stays flat whatever
 * the project's size.
 *
 * @param {string} filePath
 * @returns {Promise<{isAca: boolean, markers: string[]}>}
 */
export async function detectAcaProxyObjects(filePath) {
  const CHUNK = 4 * 1024 * 1024;
  const OVERLAP = Math.max(...ACA_MARKERS.map((m) => m.length));
  const found = new Set();

  let fd;
  try {
    fd = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(CHUNK);
    let position = 0;
    let carry = "";

    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, CHUNK, position);
      if (bytesRead <= 0) break;
      const text = carry + buf.slice(0, bytesRead).toString("latin1");
      for (const marker of ACA_MARKERS) {
        if (text.includes(marker)) found.add(marker);
      }
      if (found.size === ACA_MARKERS.length) break;
      carry = text.slice(-OVERLAP);
      position += bytesRead;
      if (bytesRead < CHUNK) break;
    }
  } catch {
    return { isAca: false, markers: [] };
  } finally {
    await fd?.close().catch(() => {});
  }

  const markers = ACA_MARKERS.filter((m) => found.has(m));
  return { isAca: markers.length > 0, markers };
}

export const ACA_EXPORT_HINT =
  "Bu cizim AutoCAD Architecture (ACA) nesneleri iceriyor: duvarlar, giydirme " +
  "cepheler ve pencereler duz cizgi degil, ozel AEC nesneleri olarak kayitli. " +
  "Bu nesneler ACA disindaki okuyucularda bos gelir. AutoCAD'de once " +
  "EXPORTTOAUTOCAD komutunu calistirin (AEC nesnelerini duz cizgi/yaya cevirir), " +
  "sonra olusan dosyayi DXF olarak kaydedin. Alternatif olarak kat planini ve on " +
  "cepheyi PDF veya PNG olarak verin; bu sayfa gorsellerden de model uretir.";
