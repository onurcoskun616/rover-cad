import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeCli, stripCodeFence } from "./claudeCli.js";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";
import { resolveStepPath, describeStepGeometry } from "./camService.js";
import {
  detectThreads,
  detectThreadMethod,
  threadGuidanceBlock,
  THREAD_METHOD_QUESTION,
} from "./threadSpec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptFile = (name) => path.join(__dirname, "..", "prompts", name);
const QUESTIONS_PROMPT = promptFile("cam-questions-system-prompt.txt");
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

// Added deterministically when the part has more than two horizontal levels
// (i.e. it is stepped/multi-level), so the machinist is always asked how the
// steps should be machined. Options are ASCII-only to match the prompt style.
const STEP_LEVEL_QUESTION = {
  question:
    "Parcada birden fazla kademe (yukseklik seviyesi) var. Her kademe ayri bir operasyon olarak mi islenecek?",
  options: ["Evet, her kademe ayri islensin", "Hayir, tek operasyonda", "Diger"],
};

/**
 * Produce the (max 5) questions needed before planning machining of a part. When
 * threads/fasteners are detected in the prompt, the tap-vs-thread-milling
 * question is added deterministically so it is always offered.
 * @param {string} stepPath basename/path of a STEP file in the output dir
 * @param {string} [context] original prompt/description, scanned for threads
 * @returns {Promise<Array<{question: string, options: string[]}>>}
 */
export async function generateCamQuestions(stepPath, context = "") {
  const geometry = await describeStepGeometry(stepPath);
  const threads = detectThreads(context);
  const isStepped = (geometry.horizontalLevelCount ?? 0) > 2;

  let input = geomBlock(geometry);
  if (threads.hasThread) {
    // We add the threading-method question ourselves, so tell the model not to.
    input +=
      "\n[NOT]: Bu parcada metrik dis tespit edildi; dis yontemi (tap/frezeleme) sorusunu SEN SORMA.";
  }
  if (isStepped) {
    // We add the per-step question ourselves, so tell the model not to.
    input +=
      "\n[NOT]: Bu parcada birden fazla kademe/seviye tespit edildi; kademelerin ayri islenip islenmeyecegi sorusunu SEN SORMA (biz ekleyecegiz), ancak diger sorulari bu kademeli geometriye gore uyarla.";
  }
  input += "\n[GOREV]: Bu parcanin islenmesi icin gereken sorulari uret.";

  const questions = await runClaudeJson(input, QUESTIONS_PROMPT, (parsed) => {
    if (!Array.isArray(parsed)) throw new Error("Sorular bir dizi olmali");
    const list = parsed
      .filter((q) => q && typeof q.question === "string")
      .slice(0, 5)
      .map((q) => ({
        question: q.question,
        options: Array.isArray(q.options) ? q.options.map(String) : [],
      }));
    if (list.length === 0) throw new Error("Gecerli soru uretilemedi");
    return list;
  });

  // Deterministically guarantee the geometry-driven questions, keeping the total
  // at <= 5 by trimming model-generated questions from the end (the standard
  // material/axis/workholding/reference questions come first, so they survive).
  const extras = [];
  if (threads.hasThread) {
    const already = questions.some((q) =>
      /tap|kılavuz|klavuz|frez|thread/i.test(q.question),
    );
    if (!already) extras.push({ ...THREAD_METHOD_QUESTION });
  }
  if (isStepped) {
    const already = questions.some((q) =>
      /kademe|seviye|basamak|step/i.test(q.question),
    );
    if (!already) extras.push({ ...STEP_LEVEL_QUESTION });
  }
  if (extras.length) {
    const room = Math.max(1, 5 - extras.length);
    if (questions.length > room) questions.length = room;
    questions.push(...extras);
  }

  return questions;
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
  let input =
    geomBlock(geometry) +
    `\n[CEVAPLAR]: ${JSON.stringify(answers ?? {})}`;

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
    `\n[CEVAPLAR]: ${JSON.stringify(answers ?? {})}` +
    `\n[ONAYLANAN_PLAN]: ${JSON.stringify(plan)}` +
    threadGuidance +
    "\n[GOREV]: Bu plani FreeCAD Path (CAM) koduna cevir ve GRBL G-code olarak yukaridaki cikti yoluna yaz.";

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
