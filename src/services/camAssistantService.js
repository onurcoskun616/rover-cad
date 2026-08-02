import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeCli, stripCodeFence } from "./claudeCli.js";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";
import { resolveStepPath, describeStepGeometry } from "./camService.js";
import { camParamsBlock } from "./camWizardService.js";
import {
  detectThreads,
  detectThreadMethod,
  threadGuidanceBlock,
} from "./threadSpec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptFile = (name) => path.join(__dirname, "..", "prompts", name);
const PLAN_PROMPT = promptFile("cam-plan-system-prompt.txt");
const CODE_PROMPT = promptFile("cam-code-system-prompt.txt");

// Model output for the assistant is JSON, not code. Try a strict parse first,
// then fall back to slicing out the outermost array/object in case the model
// wrapped it in stray text despite the "JSON only" instruction.
export function parseJsonLoose(raw) {
  const s = stripCodeFence(raw);
  try {
    return JSON.parse(s);
  } catch {
    // fall through to bracket extraction
  }

  const startArr = s.indexOf("[");
  const startObj = s.indexOf("{");
  let start;
  let closeCh;
  if (startArr === -1 && startObj === -1) {
    throw new Error("Yanitta JSON bulunamadi");
  } else if (startObj === -1 || (startArr !== -1 && startArr < startObj)) {
    start = startArr;
    closeCh = "]";
  } else {
    start = startObj;
    closeCh = "}";
  }
  const end = s.lastIndexOf(closeCh);
  if (end <= start) throw new Error("Yanitta gecerli JSON yok");
  return JSON.parse(s.slice(start, end + 1));
}

const JSON_ATTEMPTS = 2;

// Call the CLI expecting JSON, validating/normalising with `shape`. Retries once
// with a reminder if the first response doesn't parse into a valid shape.
async function runClaudeJson(input, systemPromptFile, shape) {
  let lastError;
  for (let attempt = 1; attempt <= JSON_ATTEMPTS; attempt++) {
    const attemptInput =
      attempt === 1
        ? input
        : input +
          "\n\n[HATIRLATMA]: Onceki cevabin gecerli degildi. SADECE istenen formatta ham JSON dondur, baska hicbir sey yazma.";
    try {
      const raw = await runClaudeCli(attemptInput, {
        systemPromptFile,
        allowRead: false,
      });
      const parsed = parseJsonLoose(raw);
      return shape(parsed);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function geomBlock(geometry) {
  return `[GEOMETRI_OZETI]: ${JSON.stringify(geometry)}`;
}

/**
 * Draft (or revise) a human-readable CAM operation plan.
 * @param {string} stepPath
 * @param {object} answers machinist's answers (arbitrary key/value)
 * @param {{previousPlan?: object, changeRequest?: string}} [opts]
 * @returns {Promise<{summary: string, steps: object[], notes: string, planText: string}>}
 */
export async function generateCamPlan(stepPath, answers, opts = {}) {
  const geometry = await describeStepGeometry(stepPath);
  let input = geomBlock(geometry) + camParamsBlock(answers);

  // Inject computed pilot-hole diameters so the plan mentions the correct sizes.
  const threads = detectThreads(opts.context ?? "");
  if (threads.hasThread) {
    input += threadGuidanceBlock(threads.sizes, detectThreadMethod(answers));
  }

  if (opts.previousPlan && opts.changeRequest) {
    input +=
      `\n[ONCEKI_PLAN]: ${JSON.stringify(opts.previousPlan)}` +
      `\n[DEGISIKLIK_ISTEGI]: ${opts.changeRequest}`;
  }
  input += "\n[GOREV]: Bu parca icin CAM operasyon planini uret.";

  return runClaudeJson(input, PLAN_PROMPT, (parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Plan bir nesne olmali");
    }
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    if (steps.length === 0) throw new Error("Plan adimlari uretilemedi");
    const plan = {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      steps: steps.map((s, i) => ({
        step: Number(s.step) || i + 1,
        operation: String(s.operation ?? ""),
        tool: String(s.tool ?? ""),
        description: String(s.description ?? ""),
      })),
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
    plan.planText = planToText(plan);
    return plan;
  });
}

// Render a plan object into the human-readable Turkish text the frontend shows.
export function planToText(plan) {
  const lines = [];
  if (plan.summary) lines.push(plan.summary, "");
  for (const s of plan.steps) {
    const head = `${s.step}. Adim: ${s.operation}`.trim();
    const tool = s.tool ? ` (${s.tool})` : "";
    lines.push(head + tool);
    if (s.description) lines.push(`   ${s.description}`);
  }
  if (plan.notes) {
    lines.push("", `Notlar: ${plan.notes}`);
  }
  return lines.join("\n");
}

const GCODE_ATTEMPTS = 3;

// Common G-code / M-code command tokens; if any appears as a literal inside the
// generated Python, the model is hand-writing G-code instead of letting FreeCAD
// compute it.
const GCODE_LITERAL_RE =
  /["'][^"'\n]*\b(G0?[0-3]|G1[789]|G2[01]|G9[01]|M0?[3-9]|M30)\b/;

/**
 * Static guardrail on the generated FreeCAD script: G-code must be produced ONLY
 * by real FreeCAD Path operations + the post-processor, never hand-written by
 * the LLM. The model translates the plan into Path API calls; FreeCAD computes
 * the toolpaths and grbl_post emits the G-code.
 * @param {string} code the generated Python (code fences already stripped)
 * @returns {string|null} a Turkish violation message, or null if the code is OK
 */
export function validateCamCode(code) {
  if (!/\.export\s*\(/.test(code)) {
    return "Kod bir post-processor export cagrisi (orn. grbl_post.export(...)) icermiyor; G-code yalnizca FreeCAD post-processor tarafindan uretilmeli.";
  }
  if (/\bopen\s*\(/.test(code)) {
    return "Kod bir dosya acip yaziyor; cikti G-code dosyasini KENDIN yazma. Dosyayi yalnizca grbl_post.export(...) olusturmali.";
  }
  if (GCODE_LITERAL_RE.test(code)) {
    return "Kod ham G-code/M-code komutlari iceriyor; toolpath hesabini ve G-code'u FreeCAD Path operasyonlari + post-processor uretmeli, sen G-code yazmamalisin.";
  }
  if (!/\bJob\b/.test(code)) {
    return "Kod bir FreeCAD Path Job olusturmuyor; gercek CAM operasyonlari (Path Workbench API) kullanilmali.";
  }
  return null;
}

/**
 * Turn an approved plan into real FreeCAD Path operations and GRBL G-code.
 * @param {string} stepPath
 * @param {object} answers
 * @param {object} plan approved plan object
 * @returns {Promise<{gcodePath: string}>}
 */
export async function generateCamGcodeFromPlan(stepPath, answers, plan, context = "") {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    throw new Error("STEP dosyasi bulunamadi: " + path.basename(abs));
  }
  const geometry = await describeStepGeometry(stepPath);
  const gcodePath = abs.replace(/\.(step|stp)$/i, "") + "_cam.gcode";
  // Remove any stale file so an existence check after execution is meaningful.
  try {
    fs.unlinkSync(gcodePath);
  } catch {
    // not present; fine
  }

  // Compute pilot diameters from the metric thread table and tell the code
  // generator exactly what to drill and which threading operation to add.
  const threads = detectThreads(context);
  const threadGuidance = threads.hasThread
    ? threadGuidanceBlock(threads.sizes, detectThreadMethod(answers))
    : "";

  const baseInput =
    `[STEP_PATH]: ${abs}` +
    `\n[GCODE_OUTPUT_PATH]: ${gcodePath}` +
    `\n${geomBlock(geometry)}` +
    camParamsBlock(answers) +
    `\n[ONAYLANAN_PLAN]: ${JSON.stringify(plan)}` +
    threadGuidance +
    "\n[GOREV]: Bu plani FreeCAD Path (CAM) operasyonlarina cevir; [CAM_PARAMETRELERI]'ndeki takim capi, spindle hizi, ilerlemeler, pasa derinligi, WCS ve post-processor degerlerini KULLAN. Toolpath hesabini FreeCAD yapsin ve secilen post-processor'un export'u ile yukaridaki cikti yoluna G-code yazdirilsin. G-code'u SEN yazma.";

  let lastError = "Bilinmeyen hata";
  let previousCode = null;
  let problem = null;

  for (let attempt = 1; attempt <= GCODE_ATTEMPTS; attempt++) {
    let input = baseInput;
    if (previousCode) {
      input +=
        `\n\n[ONCEKI_KOD]:\n${previousCode}` +
        `\n\n[SORUN]: ${problem}` +
        "\n\n[DUZELT]: Sorunu gider ve tam duzeltilmis Python kodunu bastan yaz. SADECE ham kod.";
    }

    let code;
    try {
      const raw = await runClaudeCli(input, {
        systemPromptFile: CODE_PROMPT,
        allowRead: false,
      });
      code = stripCodeFence(raw);
      if (!code) throw new Error("Bos kod dondu");
    } catch (err) {
      lastError = err.message;
      previousCode = null;
      problem = null;
      continue;
    }

    // Reject (and ask the model to fix) any script that would bypass FreeCAD's
    // Path/CAM API + post-processor and emit G-code directly.
    const violation = validateCamCode(code);
    if (violation) {
      lastError = violation;
      previousCode = code;
      problem =
        violation +
        " Plani SADECE FreeCAD Path (CAM) operasyonlarina cevir; toolpath ve G-code uretimini FreeCAD Path + grbl_post.export yapsin.";
      continue;
    }

    let runText = "";
    try {
      const result = await callFreecadTool(config.freecadMcp.toolName, {
        [config.freecadMcp.toolParam]: code,
      });
      runText = extractResultText(result);
      if (result?.isError || runText.startsWith("Failed to execute code")) {
        throw new Error(runText || "FreeCAD kodu calistiramadi");
      }
    } catch (err) {
      lastError = err.message;
      previousCode = code;
      problem = `FreeCAD Path kodunu calistirirken hata olustu:\n${err.message}`;
      continue;
    }

    if (fs.existsSync(gcodePath)) {
      return { gcodePath };
    }
    lastError = "G-code dosyasi olusmadi";
    previousCode = code;
    problem =
      "Kod calisti ama beklenen G-code dosyasi olusmadi. grbl_post.export cagrisinin " +
      "verilen cikti yoluna yazdigindan ve GCODE_PATH yazdirdigindan emin ol.";
  }

  throw new Error("CAM G-code uretilemedi: " + lastError);
}
