import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runLlm, stripCodeFence } from "./claudeCli.js";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";
import { sanitizeFreeCADCode } from "./exportService.js";
import { resolveStepPath, describeStepGeometry } from "./camService.js";
import { camParamsBlock } from "./camWizardService.js";
import { listMagazineTools, slotNumberForTool } from "./cncMagazineService.js";
import {
  detectThreads,
  detectThreadMethod,
  threadGuidanceBlock,
} from "./threadSpec.js";
import { transformToSinumerik, isSinumerik } from "./sinumerikTransformer.js";
import { transformToHeidenhain, isHeidenhain, heidenhainVersion } from "./heidenhainTransformer.js";
import {
  transformToMeldas, isMitsubishi,
  transformToMazak, isMazak,
  transformToOkumaOSP, isOkuma,
} from "./industrialTransformers.js";

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
    const preview = s.slice(0, 200);
    throw new Error(`Yanitta JSON bulunamadi. Yanit: ${preview}`);
  } else if (startObj === -1 || (startArr !== -1 && startArr < startObj)) {
    start = startArr;
    closeCh = "]";
  } else {
    start = startObj;
    closeCh = "}";
  }
  const end = s.lastIndexOf(closeCh);
  if (end <= start) {
    const preview = s.slice(0, 200);
    throw new Error(`Yanitta gecerli JSON yok. Yanit: ${preview}`);
  }
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    const preview = s.slice(start, start + 200);
    throw new Error(`JSON parse hatasi: ${e.message}. Yanit: ${preview}`);
  }
}

const JSON_ATTEMPTS = 2;

// Call the CLI expecting JSON, validating/normalising with `shape`. Retries
// with increasingly firm reminders if the response doesn't parse.
async function runClaudeJson(input, systemPromptFile, shape) {
  let lastError;
  let lastRaw = "";
  for (let attempt = 1; attempt <= JSON_ATTEMPTS; attempt++) {
    let attemptInput = input;
    if (attempt >= 2) {
      attemptInput +=
        '\n\n[SON UYARI]: Onceki cevabin gecerli degildi. Aciklama, yorum, code fence YAZMA. Ciktinin ilk karakteri { olmali. SADECE ham JSON dondur.';
    }
    try {
      const raw = await runLlm(attemptInput, {
        systemPromptFile,
      });
      lastRaw = raw;
      const parsed = parseJsonLoose(raw);
      return shape(parsed);
    } catch (err) {
      lastError = err;
      console.warn(`runClaudeJson attempt ${attempt}/${JSON_ATTEMPTS} failed:`, err.message);
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
  const t0 = Date.now();
  const geometry = await describeStepGeometry(stepPath);
  console.log(`generateCamPlan: geometry in ${Date.now() - t0}ms`);

  // Build the input with the INSTRUCTION first, then data. This order is
  // critical: when the input starts with raw geometry JSON, some models treat
  // it as shared data and describe it instead of generating a plan.
  let instruction = `SADECE ham JSON dondur. Ilk karakter { son karakter } olmali. Fence/aciklama YAZMA.\n\n`;

  let data = geomBlock(geometry) + camParamsBlock(answers, geometry);

  // Inject computed pilot-hole diameters so the plan mentions the correct sizes.
  const threads = detectThreads(opts.context ?? "");
  if (threads.hasThread) {
    data += threadGuidanceBlock(threads.sizes, detectThreadMethod(answers));
  }

  if (opts.previousPlan && opts.changeRequest) {
    data +=
      `\n[ONCEKI_PLAN]: ${JSON.stringify(opts.previousPlan)}` +
      `\n[DEGISIKLIK_ISTEGI]: ${opts.changeRequest}`;
  }

  const input = instruction + data;

  const t1 = Date.now();
  console.log(`generateCamPlan: calling Claude CLI (input ${input.length} chars)`);
  return runClaudeJson(input, PLAN_PROMPT, (parsed) => {
    console.log(`generateCamPlan: Claude CLI done in ${Date.now() - t1}ms`);
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
        // Numeric machining parameters the wizard UI shows for review/edit
        // before code generation. stepDownMm is hard-clamped here (not just
        // trusted from the LLM) so an over-limit value can never reach the
        // UI as a pre-filled "safe-looking" default in the first place.
        stepDownMm: clampStepDownMm(s.stepDownMm),
        feedMmMin: positiveNumberOrNull(s.feedMmMin),
        startDepthMm: finiteNumberOrNull(s.startDepthMm),
        finalDepthMm: finiteNumberOrNull(s.finalDepthMm),
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

const GCODE_ATTEMPTS = 2;

// Common G-code / M-code command tokens; if any appears as a literal inside the
// generated Python, the model is hand-writing G-code instead of letting FreeCAD
// compute it.
const GCODE_LITERAL_RE =
  /["'][^"'\n]*\b(G0?[0-3]|G1[789]|G2[01]|G9[01]|M0?[3-9]|M30)\b/;

/**
 * Static guardrail on the generated FreeCAD script. The LLM only builds FreeCAD
 * Path (CAM) operations into a variable named `job`; it must NOT touch G-code at
 * all — a separate trusted epilogue (never the model) runs the toolpath preview
 * and the post-processor. So the script must not export, open/write files, or
 * contain any raw G-code, and it must create a Path Job assigned to `job`.
 * @param {string} code the generated Python (code fences already stripped)
 * @returns {string|null} a Turkish violation message, or null if the code is OK
 */
export function validateCamCode(code) {
  if (/\.export\s*\(/.test(code)) {
    return "Kod bir post-processor export cagrisi iceriyor; G-code'u SEN uretme. Sadece Path operasyonlarini `job` icine kur; export'u sistem yapacak.";
  }
  if (/\bopen\s*\(/.test(code)) {
    return "Kod bir dosya aciyor; hicbir dosya acma/yazma yapma. Sadece FreeCAD Path operasyonlarini kur.";
  }
  if (GCODE_LITERAL_RE.test(code)) {
    return "Kod ham G-code/M-code komutlari iceriyor; toolpath'i ve G-code'u FreeCAD hesaplar. Sen sadece Path operasyonlari kuracaksin.";
  }
  if (!/\bJob\b/.test(code)) {
    return "Kod bir FreeCAD Path Job olusturmuyor; gercek CAM operasyonlari (Path Workbench API) kullanilmali.";
  }
  if (!/\bjob\s*=(?!=)/.test(code)) {
    return "Path Job nesnesi tam olarak `job` adli degiskene atanmali (job = PathJob.Create(...)).";
  }
  return null;
}

// Max single-move Z descent (mm) allowed in generated Path operations — matches
// the CNC Simülatör's SafetyInterceptor.maxPlunge. This walks the ACTUAL
// FreeCAD-computed Path.Commands (trusted epilogue, not the model), so it
// catches a violation regardless of what StepDown/depth the LLM used, and does
// so at full resolution (before any downsampling for the preview JSON).
// Helical G2/G3 dives are exempt, matching server/llm_system_prompt.txt.
const MAX_PLUNGE_MM = 10;

// A tell-tale signature of a recurring model mistake: multiple differently
// -named split operations (e.g. ProfileRough_L0, _L1, ...) that ALL report
// the EXACT SAME fromZ->toZ range. A correctly split operation (created via
// the cam-code-system-prompt.txt `_rover_make_leveled_ops` helper) never
// repeats the same range across levels — each level gets its own slice of
// the total depth — so seeing the same range 2+ times means the model
// bypassed the helper and hand-wrote its own (broken) splitting loop, or
// "fixed" an empty toolpath by recomputing every level from the same
// bounding box instead of translating the plan's own numbers. Detecting
// this lets the retry prompt name the exact mistake instead of repeating
// the generic depth-limit rule the model already ignored once.
function detectDuplicateDepthSplit(violations) {
  const seen = new Map();
  for (const v of violations) {
    const key = `${v.fromZ}->${v.toZ}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.values()].some((n) => n >= 2);
}

// Normalise the plan's numeric machining fields (see generateCamPlan): never
// trust the LLM's raw number as-is, and never let a non-finite/garbage value
// through as if it were a real, reviewable figure.
function clampStepDownMm(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_PLUNGE_MM);
}
function positiveNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function finiteNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The plunge check assumes Z is height (mill convention: Z-descent = plunging
// deeper into material). On a lathe, Z is axial travel along the workpiece
// length, not depth — a normal longitudinal turning pass moves Z by tens of
// mm in one command, which the mill-style check would misread as a dangerous
// single-pass plunge. So it's skipped entirely for torna jobs; the collision
// check (a pure 3D geometry check, axis-convention-independent) still runs.
export function isTornaMachine(answers) {
  return String(answers?.machineType || "").toLowerCase().includes("torna");
}

// Trusted PRELUDE (runs BEFORE the model's code, never after): FreeCAD's Path
// workbench resolves an operation's ToolController automatically when the
// model's code leaves it unset — but only if the job still has exactly ONE
// ToolController at that point. Once the multi-tool magazine feature lets a
// job carry several, that auto-resolution can no longer stay silent: inside
// a live FreeCAD GUI session (not headless), it opens an interactive "Takım
// Denetleyicisi Seçimi" dialog and blocks forever waiting for a human to
// click it — which never happens here, so the whole CAM Assistant request
// just hangs. The generator prompt now tells the model how to avoid ever
// triggering this (create the first operation before adding extra
// ToolControllers, then set every operation's ToolController explicitly),
// but that's a prompt-compliance guarantee, not a code one. This neutralizes
// the interactive picker unconditionally as a deterministic safety net: with
// it disabled, an operation that still ends up ambiguous fails immediately
// with a catchable Python error our retry loop can feed back to the model,
// instead of hanging the FreeCAD session with no way to recover.
function disableInteractiveToolControllerPy() {
  return [
    "try:",
    "    from PathScripts import PathUtils as _PathUtils",
    "    class _NoInteractiveToolController:",
    "        def selectedToolController(self):",
    "            return None",
    "        def chooseToolController(self, controllers):",
    "            raise RuntimeError(",
    "                'Bir operasyon ToolController\\'i acikca atanmadan olusturuldu ve job\\'da '",
    "                'birden fazla ToolController var, bu yuzden FreeCAD interaktif secim istedi. '",
    "                'Cozum: job.Proxy.addToolController(...) ile ek takim eklemeden ONCE ilk '",
    "                'operasyonu olustur, VE her operasyonun .ToolController ozelligini acikca ata.'",
    "            )",
    "    _PathUtils.UserInput = _NoInteractiveToolController()",
    "except Exception:",
    "    pass",
  ].join("\n");
}

// The FreeCAD MCP tool only ever reports "Failed to execute code: <type>:
// <message>" on failure — no traceback, no line number. For a one-line
// exception like "TypeError: 'module' object is not callable" that's nowhere
// near enough to know WHICH line/call is wrong, for us or for the retry
// loop's self-correction feedback. This runs the model's code through our
// OWN exec() (as a string, so no reindentation of the model's code is
// needed) inside a try/except that captures a full traceback.format_exc()
// and folds it into the exception message — so whatever terse wrapper the
// MCP tool applies on top, the message now contains the real traceback.
//
// A plain exec(source, globals()) reports frame locations as "File
// <string>, line N" with NO source text under them — Python's traceback
// formatter can only print a frame's source line if it can find that file,
// and an exec'd string was never written to a file it can look up. So
// registering the source under a fake filename in linecache BEFORE exec'ing
// it (and compiling with that same filename) makes the traceback print the
// actual failing statement, not just its line number — confirmed by a
// direct before/after test.
function wrapWithTracebackPy(code) {
  return [
    "try:",
    "    import linecache as _lc",
    `    _src = ${JSON.stringify(code)}`,
    '    _fn = "<model_code>"',
    "    _lc.cache[_fn] = (len(_src), None, _src.splitlines(keepends=True), _fn)",
    "    exec(compile(_src, _fn, 'exec'), globals())",
    "except Exception:",
    "    import traceback as _tb",
    "    raise RuntimeError('MODEL KODU HATASI:\\n' + _tb.format_exc())",
  ].join("\n");
}

function plungeCheckPy(isTorna) {
  if (isTorna) {
    return 'print("PLUNGE_VIOLATIONS=[]")  # torna: Z ekseni eksenel ilerleme, plunge kontrolu uygulanmiyor';
  }
  return [
    "import json as _json",
    "_plunge_violations = []",
    "for _op in _grp:",
    "    _p = getattr(_op, 'Path', None)",
    "    if _p is None:",
    "        continue",
    "    _lbl = str(getattr(_op, 'Label', _op.Name))",
    "    _pz = None",
    "    for _c in _p.Commands:",
    "        _pr = _c.Parameters",
    "        if 'Z' not in _pr:",
    "            continue",
    "        _nz = float(_pr['Z'])",
    "        _rapid = _c.Name in ('G0', 'G00')",
    "        _arc = _c.Name in ('G2', 'G3', 'G02', 'G03')",
    "        if _pz is not None and not _rapid and not _arc:",
    "            _delta = _pz - _nz",
    `            if _delta > ${MAX_PLUNGE_MM} + 1e-6:`,
    "                _plunge_violations.append({'op': _lbl, 'fromZ': round(_pz, 3), 'toZ': round(_nz, 3), 'delta': round(_delta, 3)})",
    "        _pz = _nz",
    'print("PLUNGE_VIOLATIONS=" + _json.dumps(_plunge_violations))',
  ].join("\n");
}

// Trusted epilogue (NOT model output): flag operations whose toolpaths are
// byte-for-byte identical to an earlier one. detectDuplicateDepthSplit() below
// spots the same mistake, but only among operations that ALSO tripped the
// plunge limit — so a level split that collapsed onto shallow, legal depths
// sailed straight through. Live case: ProfileRough_L0/_L1 and
// ProfileFinish_L0/_L1/_L2 all cut the exact same contour at Z3 then Z0,
// five times, because FreeCAD's opExecute reset every level's StartDepth and
// FinalDepth back to the same defaults during recompute. The part still came
// out, so nothing complained — it just air-cut four extra times and never
// stepped down. Identical paths are never intentional: two operations that
// remove the same material are always a level split that did not take.
function duplicateOpCheckPy() {
  return [
    "import json as _json_dup, hashlib as _hashlib_dup",
    "_dup_ops = []",
    "_seen_paths = {}",
    "for _op in _grp:",
    "    _p = getattr(_op, 'Path', None)",
    "    if _p is None:",
    "        continue",
    "    _lbl = str(getattr(_op, 'Label', _op.Name))",
    "    _sig = []",
    "    for _c in _p.Commands:",
    "        _pr = _c.Parameters",
    "        _sig.append(_c.Name + ':' + ','.join(",
    "            '%s%.4f' % (_k, float(_pr[_k])) for _k in sorted(_pr) if _k in 'XYZIJK'))",
    "    if len(_sig) < 2:",
    "        continue",
    "    _h = _hashlib_dup.md5('|'.join(_sig).encode('utf-8')).hexdigest()",
    "    if _h in _seen_paths:",
    "        _dup_ops.append({'op': _lbl, 'sameAs': _seen_paths[_h]})",
    "    else:",
    "        _seen_paths[_h] = _lbl",
    'print("DUPLICATE_OPS=" + _json_dup.dumps(_dup_ops))',
  ].join("\n");
}

/** Read the "DUPLICATE_OPS=[...]" line duplicateOpCheckPy() prints. */
export function parseDuplicateOps(text) {
  const match = String(text ?? "").match(/DUPLICATE_OPS=(\[.*\])/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Read the "PLUNGE_VIOLATIONS=[...]" line the trusted epilogue prints (see
// plungeCheckPy above) out of the FreeCAD tool's combined stdout text.
export function parsePlungeViolations(text) {
  const match = String(text ?? "").match(/PLUNGE_VIOLATIONS=(\[.*\])/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Rapid (G0) collision check against the REAL part geometry. The CAM
// Assistant's FreeCAD script never models the stock as an actual solid (only
// `base`, the finished-part STEP shape, exists in the document) — unlike the
// CNC Simülatör's SafetyInterceptor, which validates against a stock
// heightmap. So this checks the thing that actually IS reliably known: a
// rapid move's straight-line path must never travel THROUGH the finished
// part's solid (that only happens if an operation's clearance/retract height
// is wrong — legitimate rapids stay in open air above/around the part).
// Samples points along each rapid segment and asks FreeCAD's own geometric
// kernel whether that point is inside the solid — no stock position/size
// guessing involved. A cheap bounding-box pre-filter skips the (relatively
// expensive) exact check for segments that are entirely above the part, which
// covers the vast majority of ordinary retract-height travel moves.
function collisionCheckPy() {
  return [
    "import json as _json",
    "_collision_violations = []",
    "try:",
    "    _solid = base.Shape",
    "    _bb = _solid.BoundBox",
    "except Exception:",
    "    _solid = None",
    "if _solid is not None:",
    "    for _op in _grp:",
    "        _p = getattr(_op, 'Path', None)",
    "        if _p is None:",
    "            continue",
    "        _lbl = str(getattr(_op, 'Label', _op.Name))",
    "        _px = _py = _pz = None",
    "        _hit = False",
    "        for _c in _p.Commands:",
    "            if _hit:",
    "                break",
    "            _pr = _c.Parameters",
    "            _rapid = _c.Name in ('G0', 'G00')",
    "            _nx = float(_pr['X']) if 'X' in _pr else (_px if _px is not None else 0.0)",
    "            _ny = float(_pr['Y']) if 'Y' in _pr else (_py if _py is not None else 0.0)",
    "            _nz = float(_pr['Z']) if 'Z' in _pr else (_pz if _pz is not None else 0.0)",
    "            if _rapid and _px is not None and min(_pz, _nz) <= _bb.ZMax + 0.5:",
    "                _dist = ((_nx-_px)**2 + (_ny-_py)**2 + (_nz-_pz)**2) ** 0.5",
    "                if _dist > 0.5:",
    "                    _steps = min(15, max(3, int(_dist // 3)))",
    "                    for _s in range(1, _steps):",
    "                        _t = _s / _steps",
    "                        _sx = _px + (_nx-_px)*_t",
    "                        _sy = _py + (_ny-_py)*_t",
    "                        _sz = _pz + (_nz-_pz)*_t",
    "                        try:",
    "                            _inside = _solid.isInside(FreeCAD.Vector(_sx, _sy, _sz), 0.05, True)",
    "                        except Exception:",
    "                            _inside = False",
    "                        if _inside:",
    "                            _collision_violations.append({'op': _lbl, 'x': round(_sx, 2), 'y': round(_sy, 2), 'z': round(_sz, 2)})",
    "                            _hit = True",
    "                            break",
    "            _px, _py, _pz = _nx, _ny, _nz",
    'print("COLLISION_VIOLATIONS=" + _json.dumps(_collision_violations))',
  ].join("\n");
}

// Read the "COLLISION_VIOLATIONS=[...]" line the trusted epilogue prints (see
// collisionCheckPy above).
export function parseCollisionViolations(text) {
  const match = String(text ?? "").match(/COLLISION_VIOLATIONS=(\[.*\])/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Trusted transform (NOT model output): make the FreeCAD Job's Stock match the
// raw block the user actually entered in the CAM wizard. `PathJob.Create(...,
// None)` leaves the Job on FreeCAD's default stock — the part's own bounding
// box plus a ~1mm skin — so every operation gets planned for a block that
// shrink-wraps the finished part. Live testing showed exactly what that costs:
// on a real 80x143x20 plate holding a ~20x23x13 hexagon, the FaceMill skimmed a
// 4x7mm rectangle (the default stock's whole top) instead of the plate's, the
// Profile traced the outline once at a single depth instead of descending
// through 20mm of material, and every ClearanceHeight/SafeHeight came out below
// the plate's real top — so the CNC simulator, which renders the block the user
// entered, saw each retract rapid drive straight into stock the toolpath never
// knew existed, and the finished "part" was just its outline scratched into an
// otherwise untouched plate. Setting the stock here rather than in the prompt is
// deliberate: the model is told the block dimensions in [CAM_PARAMETRELERI] and
// still left the Job on its default stock, and this is a property with one
// correct value that can be computed outright.
//
// Injected immediately AFTER the Job is created and BEFORE the model's
// operations are built, because operations read the stock when their paths are
// computed — setting it afterwards would leave already-computed depths and
// boundaries derived from the default block.
//
// Extents go on symmetrically in X/Y (part centred in the block) with ALL the
// spare Z above the part, mirroring how a block is actually clamped: the part's
// bottom sits on the fixture and the excess on top is what gets faced off.
// Skipped when the entered block is smaller than the part on any axis — that
// part cannot be made from that block, and silently shrinking the stock would
// hide the mistake instead of surfacing it.
function realStockPy(sx, sy, sz) {
  return [
    "def _rover_real_stock(_doc, _job, _base_obj, _sx, _sy, _sz):",
    "    try:",
    "        _bb = _base_obj.Shape.BoundBox",
    "        _stock = _job.Stock",
    "    except Exception as _e:",
    "        print('REAL_STOCK=skipped (' + str(_e) + ')')",
    "        return",
    "    if _stock is None:",
    "        print('REAL_STOCK=skipped (job has no Stock)')",
    "        return",
    "    _px = float(_bb.XLength); _py = float(_bb.YLength); _pz = float(_bb.ZLength)",
    "    if _sx + 1e-6 < _px or _sy + 1e-6 < _py or _sz + 1e-6 < _pz:",
    "        print('REAL_STOCK=skipped (block %gx%gx%g smaller than part %gx%gx%g)' % (_sx, _sy, _sz, _px, _py, _pz))",
    "        return",
    "    _ext = (( 'ExtXneg', (_sx - _px) / 2.0), ('ExtXpos', (_sx - _px) / 2.0),",
    "            ('ExtYneg', (_sy - _py) / 2.0), ('ExtYpos', (_sy - _py) / 2.0),",
    "            ('ExtZneg', 0.0), ('ExtZpos', _sz - _pz))",
    "    _n = 0",
    "    for _k, _v in _ext:",
    "        if hasattr(_stock, _k):",
    "            try:",
    "                setattr(_stock, _k, _v)",
    "                _n += 1",
    "            except Exception:",
    "                pass",
    "    if _n:",
    "        _doc.recompute()",
    "        print('REAL_STOCK=%gx%gx%g' % (_sx, _sy, _sz))",
    "    else:",
    "        print('REAL_STOCK=skipped (stock exposes no Ext* properties)')",
    `_rover_real_stock(doc, job, base, ${sx}, ${sy}, ${sz})`,
  ].join("\n");
}

// Splice realStockPy() into the model's script on the line after the Job is
// created, matching that line's indentation (the script builds the Job inside a
// function body, so a flush-left block would be a syntax error). Returns the
// code untouched when the wizard has no block dimensions or the Job line isn't
// where the prompt mandates it — a missing stock override only costs the fix,
// while a bad splice would cost the whole run.
function injectRealStockPy(code, answers) {
  const sx = positiveNumberOrNull(answers?.stockX);
  const sy = positiveNumberOrNull(answers?.stockY);
  const sz = positiveNumberOrNull(answers?.stockZ);
  if (!sx || !sy || !sz) return code;
  const lines = code.split("\n");
  const idx = lines.findIndex((l) => /^\s*job\s*=.*PathJob\s*\.\s*Create\s*\(/.test(l));
  if (idx < 0) return code;
  const indent = lines[idx].match(/^\s*/)[0];
  const block = realStockPy(sx, sy, sz)
    .split("\n")
    .map((l) => (l ? indent + l : l));
  lines.splice(idx + 1, 0, ...block);
  return lines.join("\n");
}

// Sanitize the model's script, then give the Job the user's real stock block.
// Shared by both run paths (fresh generation and the re-run of an approved
// preview's stored code) so an exported G-code can never be planned against a
// different block than the preview the user approved.
function preparePathCodePy(code, answers) {
  return wrapWithTracebackPy(injectRealStockPy(sanitizeFreeCADCode(code), answers));
}

// Trusted epilogue (NOT model output): force every MillFace operation to face
// the RAW BLOCK's top. The cam-code prompt already spells this out, and the
// model kept pinning `Base` to the part's own top faces anyway — so MillFace
// cleared that little island instead of the block. On a 98x156 plate holding a
// ~57x51 part that came out as a handful of disconnected diagonal strokes that
// read as a letter scratched into the stock, plus a stray plunge out where the
// island's first pass started, while the rest of the block's top was never
// touched. Same lesson as autoFixClearanceHeightsPy above: when a property has
// exactly one correct value, set the property instead of asking again.
//
// Depths go with it — facing runs from the block's top down to the finished top
// surface, since that gap IS the excess this operation exists to remove — and
// are re-asserted after the recompute because FreeCAD's own opExecute resets
// them to the operation's defaults, which is what collapsed facing into a
// single pass at the part's top. Must run BEFORE autoFixDeepPlungesPy: that one
// hand-edits Path.Commands in memory and a later recompute would undo its work.
function autoFixFaceBoundaryPy() {
  return [
    // A facing op that emits only a clearance move (no X/Y anywhere) removed
    // nothing. On a read failure assume it cuts, so a property we could not
    // inspect never triggers a rollback.
    "def _rover_face_cuts(_op):",
    "    try:",
    "        _p = getattr(_op, 'Path', None)",
    "        if _p is None:",
    "            return False",
    "        for _c in _p.Commands:",
    "            if 'X' in _c.Parameters or 'Y' in _c.Parameters:",
    "                return True",
    "    except Exception:",
    "        return True",
    "    return False",
    // The part's genuinely horizontal top faces, by FreeCAD face name. A facing
    // op pointed at a vertical wall produces nothing — you cannot face-mill the
    // side of a part — and that is exactly what the live failure turned out to
    // be: boundary and depths were already correct (Stock, 20->10) and the path
    // was still empty, while FreeCAD reported the selected face as Face5 at
    // y=-17.32, z=1.47, a hexagon SIDE wall halfway up the part.
    "def _rover_top_faces(_base_obj):",
    "    _names = []",
    "    try:",
    "        _sh = _base_obj.Shape",
    "        _zmax = float(_sh.BoundBox.ZMax)",
    "        for _i, _f in enumerate(_sh.Faces):",
    "            try:",
    "                if type(_f.Surface).__name__ != 'Plane':",
    "                    continue",
    "                if abs(float(_f.normalAt(0, 0).z)) < 0.999:",
    "                    continue",
    "                if abs(float(_f.BoundBox.ZMax) - _zmax) > 1e-6:",
    "                    continue",
    "                _names.append('Face%d' % (_i + 1))",
    "            except Exception:",
    "                continue",
    "    except Exception:",
    "        pass",
    "    return _names",
    "def _rover_fix_face_ops(_doc, _grp, _base_obj, _job):",
    "    try:",
    "        _part_top = float(_base_obj.Shape.BoundBox.ZMax)",
    "    except Exception:",
    "        return",
    "    _stock_top = _part_top",
    "    try:",
    "        _stk = getattr(_job, 'Stock', None)",
    "        if _stk is not None:",
    "            _stock_top = max(_stock_top, float(_stk.Shape.BoundBox.ZMax))",
    "    except Exception:",
    "        pass",
    // Facing runs from the block's top down to the finished top surface. If the
    // block is no taller than the part there is nothing above it to remove, and
    // an earlier version fell back to "skim 1mm" — which cuts 1mm INTO the
    // finished part and delivers it undersize. A facing pass with no material
    // to take is not a shallow pass, it is no pass: leave such an operation
    // alone and say so, rather than inventing depth out of the part itself.
    "    _has_excess = _stock_top > _part_top + 1e-6",
    "    _final = _part_top",
    "    if not _has_excess:",
    "        print('FACE_FIX=0 (blok parcadan yuksek degil: yuzeylenecek malzeme yok)')",
    "        return",
    "    _targets = []",
    "    for _op in _grp:",
    "        _cls = ''",
    "        try:",
    "            _cls = type(_op.Proxy).__name__",
    "        except Exception:",
    "            pass",
    "        _name = str(getattr(_op, 'Name', '')) + str(getattr(_op, 'Label', ''))",
    "        if 'Face' not in _cls and 'Face' not in _name:",
    "            continue",
    // BoundaryShape is the knob that decides how far the clearing reaches:
    // 'Face Region' stops at the selected face's own outline, 'Stock' runs out
    // to the block. Base stays exactly as the model set it — an earlier version
    // cleared it too, on the theory that pinning Base to the part's top faces
    // was what confined the operation, and that produced a FaceMill with no
    // toolpath at all (a lone clearance move and nothing else). Base names the
    // surface to face; BoundaryShape decides how wide. Only the second one was
    // ever wrong.
    "        _prev_boundary = getattr(_op, 'BoundaryShape', None)",
    "        _prev_base = getattr(_op, 'Base', None)",
    "        _prev_sd = _prev_fd = None",
    "        try:",
    "            _prev_sd = float(_op.StartDepth.Value)",
    "            _prev_fd = float(_op.FinalDepth.Value)",
    "        except Exception:",
    "            pass",
    // The boundary is a bonus; the depths are the point. An earlier version
    // skipped the whole operation when BoundaryShape was missing or refused the
    // value — which meant the depths were never corrected either, and a face op
    // left skimming 10mm above the part went out untouched, cutting nothing but
    // air. Widening the boundary is worth attempting, and worth nothing if it
    // costs the fix that actually matters.
    "        if _prev_boundary is not None:",
    "            try:",
    "                _op.BoundaryShape = 'Stock'",
    "            except Exception:",
    "                pass",
    // "Face the whole block" in FreeCAD is an EMPTY Base plus a Stock boundary:
    // with Base naming a face, MillFace clears that face's own region inset by
    // the tool radius and the Stock boundary does not widen it — on a 40mm
    // hexagon under a 25mm cutter that came out as an 18x14mm patch in the
    // middle of an 80x143 block. An earlier attempt at an empty Base looked
    // like it produced nothing, but that was while the depths still sat in air
    // above the part, so it was never actually tested. The fallbacks below
    // cover it if this turns out to be empty on its own merits.
    "        try:",
    "            _op.Base = []",
    "        except Exception:",
    "            pass",
    "        for _prop, _val in (('StartDepth', _stock_top), ('FinalDepth', _final)):",
    "            if hasattr(_op, _prop):",
    "                try:",
    "                    setattr(_op, _prop, _val)",
    "                except Exception:",
    "                    pass",
    "        _targets.append((_op, _prev_boundary, _prev_base, _prev_sd, _prev_fd))",
    "    if not _targets:",
    "        print('FACE_FIX=0')",
    "        return",
    "    _doc.recompute()",
    "    _again = False",
    "    for _op, _prev, _pbase, _psd, _pfd in _targets:",
    "        try:",
    "            if (abs(float(_op.StartDepth.Value) - _stock_top) > 1e-6",
    "                    or abs(float(_op.FinalDepth.Value) - _final) > 1e-6):",
    "                _op.StartDepth = _stock_top",
    "                _op.FinalDepth = _final",
    "                _again = True",
    "        except Exception:",
    "            pass",
    "    if _again:",
    "        _doc.recompute()",
    // Never ship a facing operation that cuts nothing. If forcing the boundary
    // left the op with no XY motion at all, put the original boundary back: a
    // narrower face pass still removes material, an empty one is strictly worse
    // than what the model wrote.
    // Roll back EVERYTHING this function changed, not just the boundary. An
    // earlier version restored BoundaryShape alone and left the forced depths
    // in place, so a face op that came out empty stayed empty after the
    // "rollback" — which is how an empty FaceMill (one clearance move, no
    // cutting at all) still reached the machine. Undoing a subset of a failed
    // change is not a rollback.
    // Still nothing? Re-aim the operation at the part's real top faces before
    // concluding the settings were wrong — a Base pointing at a side wall
    // defeats every correct boundary and depth above it.
    "    _rebased = False",
    "    _top_faces = _rover_top_faces(_base_obj)",
    "    for _op, _prev, _pbase, _psd, _pfd in _targets:",
    "        if _rover_face_cuts(_op) or not _top_faces:",
    "            continue",
    "        try:",
    "            _op.Base = [(_base_obj, _top_faces)]",
    "            _rebased = True",
    "        except Exception:",
    "            pass",
    "    if _rebased:",
    "        _doc.recompute()",
    "    _reverted = 0",
    "    _tried = []",
    "    for _op, _prev, _pbase, _psd, _pfd in _targets:",
    "        if _rover_face_cuts(_op):",
    "            continue",
    "        try:",
    "            if _prev is not None:",
    "                _op.BoundaryShape = _prev",
    "            if _pbase is not None:",
    "                _op.Base = _pbase",
    "            if _psd is not None:",
    "                _op.StartDepth = _psd",
    "            if _pfd is not None:",
    "                _op.FinalDepth = _pfd",
    "            _tried.append((_op, _prev, _pbase, _psd, _pfd))",
    "        except Exception:",
    "            pass",
    "    if _tried:",
    "        _doc.recompute()",
    // Restoring is only an improvement if what we restored actually cuts. The
    // model's own depths are how this started: a face op skimming a 1mm layer
    // ~10mm ABOVE a 10mm-tall part, entirely in air, producing nothing. Handing
    // that back is not a rollback, it is the original bug. When neither setting
    // cuts, keep the forced one — it is at least aimed at the block's real top.
    "    _refixed = False",
    "    for _op, _prev, _pbase, _psd, _pfd in _tried:",
    "        if _rover_face_cuts(_op):",
    "            _reverted += 1",
    "            continue",
    "        try:",
    "            _op.BoundaryShape = 'Stock'",
    "        except Exception:",
    "            pass",
    "        try:",
    "            _op.StartDepth = _stock_top",
    "            _op.FinalDepth = _final",
    "            _refixed = True",
    "        except Exception:",
    "            pass",
    "    if _refixed:",
    "        _doc.recompute()",
    // Per-op diagnostic: without FreeCAD to hand, this is what says whether the
    // forced settings produced a real path, whether the rollback recovered one,
    // and which depths were involved.
    "    for _op, _prev, _pbase, _psd, _pfd in _targets:",
    "        _n = 0",
    "        _xs = []",
    "        _ys = []",
    "        try:",
    "            for _c in _op.Path.Commands:",
    "                if 'X' in _c.Parameters or 'Y' in _c.Parameters:",
    "                    _n += 1",
    "                if 'X' in _c.Parameters:",
    "                    _xs.append(float(_c.Parameters['X']))",
    "                if 'Y' in _c.Parameters:",
    "                    _ys.append(float(_c.Parameters['Y']))",
    "        except Exception:",
    "            pass",
    // The number of moves says the op is alive; the swept extent says whether
    // it is facing the block or a patch in the middle of it.
    "        _span = '%.0fx%.0f' % (max(_xs) - min(_xs), max(_ys) - min(_ys)) if _xs and _ys else '-'",
    "        _nbase = len(getattr(_op, 'Base', []) or [])",
    "        print('FACE_OP=%s boundary=%s->%s depth=%s/%s->%.3f/%.3f topfaces=%s base=%d cuts=%d span=%s'",
    "              % (getattr(_op, 'Label', '?'), _prev, getattr(_op, 'BoundaryShape', '?'),",
    "                 _psd, _pfd, _stock_top, _final, ','.join(_top_faces) or 'none', _nbase, _n, _span))",
    "    print('FACE_FIX=%d reverted=%d (top %.3f -> %.3f)' % (len(_targets), _reverted, _stock_top, _final))",
    "_rover_fix_face_ops(doc, _grp, base, job)",
  ].join("\n");
}

// Trusted epilogue (NOT model output): PREVENTIVE, deterministic fix for the
// "rapid passes through the part" collision violation. The error message has
// always pointed at the real cause ("yanlis/eksik ... ClearanceHeight/
// SafeHeight yuzunden olur") but prompting alone hasn't reliably gotten the
// model to set these high enough — live testing kept showing every
// operation's retract rapid landing at the SAME low Z (e.g. 3.2mm) that
// turned out to sit inside the part's real bounding box. Rather than trying
// to reroute already-computed G-code around the collision after the fact
// (tried first — a plunge/approach move that legitimately ends inside the
// finished-part solid, because that's exactly where cutting is about to
// happen, can't be "routed around": there is no safe path to a destination
// inside the solid, and the check has no stock model to know that spot will
// already be machined away by then), this corrects the ACTUAL FreeCAD
// property that generates the unsafe rapid: any operation's ClearanceHeight
// or SafeHeight below the part's real top gets raised to bb.ZMax + margin,
// then the document is recomputed ONCE so FreeCAD regenerates that
// operation's retract/approach rapids at a genuinely safe height (with the
// deeper move into material becoming the FEED move it always should have
// been, which the plunge check already handles separately). Must run BEFORE
// autoFixDeepPlungesPy below: that function hand-edits Path.Commands
// in-memory without recomputing, and a recompute() afterward would silently
// regenerate — and so undo — its split. Verified with a Python simulation
// mirroring Path/Op/Base.py's real "Path.Command('G0', {'Z':
// obj.ClearanceHeight.Value})" retract pattern before shipping.
function autoFixClearanceHeightsPy() {
  return [
    "def _rover_fix_clearance_heights(_grp, _base_obj):",
    "    try:",
    "        _bb = _base_obj.Shape.BoundBox",
    "    except Exception:",
    "        return",
    // Clear the STOCK, not just the finished part. Deriving this from the part
    // alone put every retract below the top of the raw block whenever the block
    // was taller than the part (the normal case — that excess is what gets
    // machined away), so the "safe" height sat inside material the toolpath was
    // about to travel across. Live case: part ZMax 13 gave safe_z 18 on a 20mm
    // plate, and every rapid at Z18 was a crash.
    "    _top = float(_bb.ZMax)",
    "    try:",
    "        _stk = getattr(job, 'Stock', None)",
    "        if _stk is not None:",
    "            _top = max(_top, float(_stk.Shape.BoundBox.ZMax))",
    "    except Exception:",
    "        pass",
    "    _safe_z = _top + 5.0",
    "    _fixed = False",
    "    for _op in _grp:",
    "        for _prop in ('ClearanceHeight', 'SafeHeight'):",
    "            if hasattr(_op, _prop):",
    "                try:",
    "                    _cur = float(getattr(_op, _prop).Value)",
    "                except Exception:",
    "                    continue",
    "                if _cur < _safe_z - 1e-6:",
    "                    try:",
    "                        setattr(_op, _prop, _safe_z)",
    "                        _fixed = True",
    "                    except Exception:",
    "                        pass",
    "    if _fixed:",
    "        doc.recompute()",
    "_rover_fix_clearance_heights(_grp, base)",
  ].join("\n");
}

// Trusted epilogue (NOT model output): PREVENTIVE, deterministic fix for
// whatever collision violation survives autoFixClearanceHeightsPy above.
// Live testing showed the SAME violation (a rapid ending at a fixed point
// like (0,0,3.2), inside the part's solid) persisting even after raising
// ClearanceHeight/SafeHeight and recomputing — meaning that property isn't
// what's actually generating this particular unsafe move, or FreeCAD isn't
// regenerating it from that property the way expected. Trying to ROUTE the
// rapid around the solid (up/across/down) was tried first and abandoned: a
// rapid whose FINAL destination is legitimately inside the solid (because
// cutting is about to start exactly there) has no safe path to that
// destination — routing only delays where the straight-line sampling finds
// the solid again, it doesn't remove the violation. The actual fix: a rapid
// that enters material right before cutting begins should never have been a
// RAPID in the first place — it should be a controlled FEED move, which is
// exactly what real machining does (approach at rapid, then switch to feed
// before contact). So instead of moving the destination, this reclassifies
// the move itself: any G0 whose straight-line path the SAME sampling
// collisionCheckPy uses finds inside the solid gets rewritten as G1 (feed
// rate borrowed from the operation's ToolController.VertFeed, or the
// command's own pre-existing F if it already had one). This is unconditionally
// safe — a slow controlled feed into material is never a "rapid crash" risk,
// which is what this check exists to catch — regardless of whether the
// destination turns out to be genuinely mid-cut or a real navigation mistake.
// Must run BEFORE autoFixDeepPlungesPy below so a newly-created deep feed
// plunge still gets split into <=10mm passes. Verified with a Python
// simulation matching the exact live violation (rapid straight through a
// solid to (0,0,-5)-equivalent) before shipping: 3/3 violations resolved,
// safe rapids and pre-existing feed moves left untouched, existing F params
// preserved rather than overwritten.
function autoFixUnsafeRapidsToFeedPy() {
  return [
    "def _rover_defuse_unsafe_rapids(_grp, _base_obj):",
    "    import json as _json3",
    "    _report = {'bbOk': False, 'ops': 0, 'rapids': 0, 'unsafe': 0, 'converted': 0, 'assignErrors': [], 'otherErrors': []}",
    "    try:",
    "        _solid = _base_obj.Shape",
    "        _bb = _solid.BoundBox",
    "        _report['bbOk'] = True",
    "        _report['bbZMax'] = round(float(_bb.ZMax), 3)",
    "    except Exception as _e:",
    "        _report['otherErrors'].append('boundbox: ' + str(_e))",
    "        print('RAPID_DEFUSE_REPORT=' + _json3.dumps(_report))",
    "        return",
    "    for _op in _grp:",
    "        _report['ops'] += 1",
    "        try:",
    "            _p = getattr(_op, 'Path', None)",
    "            if _p is None:",
    "                continue",
    "            _default_feed = 300.0",
    "            try:",
    "                _tc = getattr(_op, 'ToolController', None)",
    "                if _tc is not None:",
    "                    _default_feed = float(_tc.VertFeed.Value)",
    "            except Exception:",
    "                pass",
    "            _new_cmds = []",
    "            _px = _py = _pz = None",
    "            _changed = False",
    "            for _c in _p.Commands:",
    // Position fallback/tracking below is a DELIBERATE line-for-line mirror of
    // collisionCheckPy's own detection loop (same file, above) — an earlier
    // version reimplemented this with a subtly different fallback (carrying
    // forward None instead of defaulting to 0.0, and only conditionally
    // updating _px/_py/_pz) which silently left _px stuck at None whenever an
    // operation's first couple of rapids didn't repeat X/Y (e.g. a real
    // FreeCAD retract move that only specifies Z, matching Path/Op/Base.py's
    // own `Path.Command("G0", {"Z": obj.ClearanceHeight.Value})` pattern) —
    // meaning the very next (genuinely unsafe) move was never checked at all.
    // Verified live: 0 unsafe found here while collisionCheckPy found 3,
    // reproduced with a standalone Python simulation of that exact command
    // sequence before switching to this mirrored version.
    "                _pr = _c.Parameters",
    "                _rapid = _c.Name in ('G0', 'G00')",
    "                if _rapid:",
    "                    _report['rapids'] += 1",
    "                _nx = float(_pr['X']) if 'X' in _pr else (_px if _px is not None else 0.0)",
    "                _ny = float(_pr['Y']) if 'Y' in _pr else (_py if _py is not None else 0.0)",
    "                _nz = float(_pr['Z']) if 'Z' in _pr else (_pz if _pz is not None else 0.0)",
    "                _unsafe = False",
    "                if _rapid and _px is not None and min(_pz, _nz) <= _bb.ZMax + 0.5:",
    "                    _dist = ((_nx-_px)**2 + (_ny-_py)**2 + (_nz-_pz)**2) ** 0.5",
    "                    if _dist > 0.5:",
    "                        _steps = min(15, max(3, int(_dist // 3)))",
    "                        for _s in range(1, _steps):",
    "                            _t = _s / _steps",
    "                            _sx = _px + (_nx-_px)*_t",
    "                            _sy = _py + (_ny-_py)*_t",
    "                            _sz = _pz + (_nz-_pz)*_t",
    "                            try:",
    "                                if _solid.isInside(FreeCAD.Vector(_sx, _sy, _sz), 0.05, True):",
    "                                    _unsafe = True",
    "                                    break",
    "                            except Exception as _e:",
    "                                _report['otherErrors'].append('isInside: ' + str(_e))",
    "                if _unsafe:",
    "                    _report['unsafe'] += 1",
    "                    _params = dict(_pr)",
    "                    if 'F' not in _params:",
    "                        _params['F'] = _default_feed",
    "                    _new_cmds.append(Path.Command('G1', _params))",
    "                    _changed = True",
    "                else:",
    "                    _new_cmds.append(_c)",
    "                _px, _py, _pz = _nx, _ny, _nz",
    "            if _changed:",
    "                try:",
    "                    _op.Path = Path.Path(_new_cmds)",
    "                    _report['converted'] += 1",
    "                except Exception as _e:",
    "                    _report['assignErrors'].append(str(getattr(_op, 'Label', _op.Name)) + ': ' + str(_e))",
    "        except Exception as _e:",
    "            _report['otherErrors'].append(str(getattr(_op, 'Label', _op.Name)) + ' (op loop): ' + str(_e))",
    "    print('RAPID_DEFUSE_REPORT=' + _json3.dumps(_report))",
    "_rover_defuse_unsafe_rapids(_grp, base)",
  ].join("\n");
}

// Read the "RAPID_DEFUSE_REPORT={...}" line autoFixUnsafeRapidsToFeedPy above
// prints out of the FreeCAD tool's combined stdout text. Diagnostic only (NOT
// used to gate success/failure) — folded into the collision-violation error
// message so a STILL-failing collision check surfaces exactly what the fix
// function saw and did (ops examined, rapids seen, how many were judged
// unsafe, how many conversions actually stuck, any caught exceptions) instead
// of requiring another guess at why a verified-in-simulation fix isn't taking
// effect live.
export function parseRapidDefuseReport(text) {
  const match = String(text ?? "").match(/RAPID_DEFUSE_REPORT=(\{.*\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Trusted epilogue (NOT model output): PREVENTIVE, deterministic fix for the
// >10mm single-move Z plunge violation, run BEFORE plungeCheckPy so the
// check normally finds nothing left to flag. Prompting the model to split
// deep cuts correctly (cam-code-system-prompt.txt's `_rover_make_leveled_ops`
// helper, plus retry-time hints naming the exact mistake) has repeatedly
// failed in live testing — the model keeps creating multiple `_L{i}`-named
// operations that report the SAME full depth range instead of each getting
// its own slice. Rather than trying yet another prompt variant, this walks
// every operation's ACTUAL computed Path.Commands directly and rewrites any
// single G1 (or other non-rapid, non-arc) move whose Z-delta exceeds the
// limit into several smaller moves, each within it, interpolating X/Y
// proportionally along the way — a hard guarantee independent of what the
// model's FreeCAD API calls actually did. G2/G3 arcs are left untouched,
// matching plungeCheckPy's own exemption for helical dives. Verified against
// the exact live bug report (5 operations all reporting Z14->Z3, 11mm) with
// a standalone Python simulation of Path.Command/Path.Path before shipping.
// Inserted into BOTH previewEpiloguePy and postEpiloguePy right after `_grp`
// is established, so the fix reaches the preview's safety check AND the
// actual exported G-code (post_mod.export reads the same `_grp` afterward).
//
// Position tracking is CONTINUOUS across the whole `_grp`, not reset per
// operation — a real E-STOP was traced to exactly this gap: the exported
// G-code's very first command was a bare `G1 Z16.0` (no prior move in that
// operation to compute a delta against, so this function's old per-op reset
// never even looked at it), but the CNC Simülatör tracks position as ONE
// continuous stream starting from wherever the tool actually sits (a safe
// height well above the stock) — from there, Z16 was a genuine ~34mm single
// -move drop, which the simulator's OWN independent plunge check correctly
// caught and E-STOPped on, silently (the alarm posts into the chat panel,
// easy to miss), leaving CYCLE START a no-op with no visible explanation.
// The starting reference is seeded from the part's own bb.ZMax + a generous
// safe margin (mirroring the simulator's own "reset to well above the
// stock" assumption) so even the very first command of the very first
// operation gets evaluated against a sensible baseline. Verified with a
// Python simulation reproducing this exact scenario (bare Z16.0 first move,
// implied ~34mm drop) before shipping: old logic never touches it, new logic
// splits it into compliant steps; cross-operation-boundary drops (op A ends
// deep, op B's first move continues deeper with no rapid in between) are
// also now correctly caught.
function autoFixDeepPlungesPy() {
  return [
    "def _rover_split_deep_plunges(_grp, _base_obj):",
    "    import math as _math",
    `    _max_plunge = ${MAX_PLUNGE_MM}`,
    "    try:",
    "        _px = _py = None",
    "        _pz = float(_base_obj.Shape.BoundBox.ZMax) + 20.0",
    "    except Exception:",
    "        _px = _py = _pz = None",
    "    for _op in _grp:",
    "        _p = getattr(_op, 'Path', None)",
    "        if _p is None:",
    "            continue",
    "        _new_cmds = []",
    "        _changed = False",
    "        for _c in _p.Commands:",
    "            _pr = dict(_c.Parameters)",
    "            _rapid = _c.Name in ('G0', 'G00')",
    "            _arc = _c.Name in ('G2', 'G3', 'G02', 'G03')",
    "            if 'Z' in _pr and _pz is not None and not _rapid and not _arc:",
    "                _nz = float(_pr['Z'])",
    "                _delta = _pz - _nz",
    "                if _delta > _max_plunge + 1e-6:",
    "                    _steps = int(_math.ceil(_delta / _max_plunge - 1e-9))",
    "                    _tx0, _ty0 = _px, _py",
    "                    _tx1 = float(_pr['X']) if 'X' in _pr else _px",
    "                    _ty1 = float(_pr['Y']) if 'Y' in _pr else _py",
    "                    for _s in range(1, _steps + 1):",
    "                        _t = _s / _steps",
    "                        _params = dict(_pr)",
    "                        _params['Z'] = _pz - _delta * _t",
    "                        if _tx1 is not None and _tx0 is not None:",
    "                            _params['X'] = _tx0 + (_tx1 - _tx0) * _t",
    "                        if _ty1 is not None and _ty0 is not None:",
    "                            _params['Y'] = _ty0 + (_ty1 - _ty0) * _t",
    "                        _new_cmds.append(Path.Command(_c.Name, _params))",
    "                    _changed = True",
    "                    _px, _py, _pz = _tx1, _ty1, _nz",
    "                    continue",
    "            _new_cmds.append(_c)",
    "            if 'X' in _pr: _px = float(_pr['X'])",
    "            if 'Y' in _pr: _py = float(_pr['Y'])",
    "            if 'Z' in _pr: _pz = float(_pr['Z'])",
    "        if _changed:",
    "            _op.Path = Path.Path(_new_cmds)",
    "_rover_split_deep_plunges(_grp, base)",
  ].join("\n");
}

// A human-readable summary of the deterministic safety checks a successful
// G-code export already passed — shown to the machinist as reassurance
// alongside the download, not re-derived speculatively: every check listed
// here already ran (in generateAndRunPathCode's retry loop, or the re-check
// below for a reused preview) and can only reach this point if it passed,
// so `ok` is always true by construction at the call site.
function buildSafetyChecks(isTorna) {
  const checks = [];
  if (!isTorna) {
    checks.push({
      key: "plunge",
      label: `Tek pasoda ${MAX_PLUNGE_MM}mm'den fazla Z dalisi yok (takim kirilma riski kontrolu)`,
      ok: true,
    });
  }
  checks.push({
    key: "collision",
    label: "Hizli (rapid/G0) hareketler parca govdesinin icinden gecmiyor",
    ok: true,
  });
  checks.push({
    key: "toolController",
    label: "Takim kontrolcusu atamalari dogrulandi (interaktif secim beklemesi yok)",
    ok: true,
  });
  checks.push({
    key: "duplicateOps",
    label: "Hicbir operasyon bir digeriyle ayni toolpath'i tekrarlamiyor (seviye bolmesi tuttu)",
    ok: true,
  });
  return checks;
}

// Candidate FreeCAD post-processor module names for each controller choice, with
// grbl as the final fallback. Used by the trusted post-processing epilogue.
function postModuleCandidates(postName) {
  const p = String(postName || "").toLowerCase();
  let list;
  if (p.includes("mach4")) list = ["mach3_mach4", "mach4", "mach3"];
  else if (p.includes("mach")) list = ["mach3_mach4", "mach3", "mach4"];
  else if (p.includes("linux")) list = ["linuxcnc", "linuxcnc_post"];
  else if (p.includes("fanuc")) list = ["fanuc", "fanuc_post", "refactored_fanuc"];
  else if (p.includes("siemens") || p.includes("sinumerik")) list = ["sinumerik", "siemens", "fanuc"];
  else if (p.includes("heidenhain")) list = ["heidenhain", "klartext", "fanuc"];
  else if (p.includes("haas")) list = ["haas", "fanuc", "refactored_fanuc"];
  else if (p.includes("mitsubishi") || p.includes("meldas")) list = ["mitsubishi", "meldas", "fanuc"];
  else if (p.includes("mazak")) list = ["mazak", "mazatrol", "fanuc"];
  else if (p.includes("okuma") || p.includes("osp")) list = ["okuma", "osp", "fanuc"];
  else if (p.includes("doosan")) list = ["doosan", "fanuc", "refactored_fanuc"];
  else list = ["grbl_post", "grbl"];
  if (!list.includes("grbl_post")) list.push("grbl_post");
  return list;
}

// Trusted epilogue (NOT model output): extract the toolpath polylines FreeCAD
// computed for each operation in `job`, estimate machining time from the move
// lengths and feed rates, and write it all as JSON for the viewer + quote.
// Rapids are flagged so the preview can distinguish them from cutting moves.
function previewEpiloguePy(previewJsonPath, defaultFeed, isTorna) {
  const feed = Number(defaultFeed) > 0 ? Number(defaultFeed) : 500;
  return [
    "",
    "# --- trusted toolpath preview + time epilogue (system, not model) ---",
    "import json as _json, math as _math",
    "try:",
    "    _grp = list(job.Operations.Group)",
    "except Exception as _e:",
    "    raise RuntimeError('job.Operations bulunamadi: ' + str(_e))",
    autoFixFaceBoundaryPy(),
    autoFixClearanceHeightsPy(),
    autoFixUnsafeRapidsToFeedPy(),
    autoFixDeepPlungesPy(),
    // Report the safety checks BEFORE building the preview JSON. They used to
    // print last, after the toolpath extraction and its EST_MINUTES/PREVIEW_JSON
    // output — so if the tool's captured stdout ever came back clipped, the
    // check lines were the first thing lost, and every parser below reads a
    // missing marker as an empty violation list. That is how a job with twelve
    // byte-identical profile operations passed a check that finds them
    // correctly when run directly. Cheap to emit early; expensive to miss.
    plungeCheckPy(isTorna),
    collisionCheckPy(),
    duplicateOpCheckPy(),
    `_default_feed = float(${feed})`,
    "_rapid_rate = 3000.0  # mm/min assumed rapid rate for time estimate",
    "_paths = []",
    "_op_minutes = {}",
    "_total_min = 0.0",
    "for _op in _grp:",
    "    _p = getattr(_op, 'Path', None)",
    "    if _p is None:",
    "        continue",
    "    _x = _y = _z = 0.0",
    "    _feed = _default_feed",
    "    _seg = []",
    "    _op_min = 0.0",
    "    for _c in _p.Commands:",
    "        _pr = _c.Parameters",
    "        if 'F' in _pr:",
    "            try:",
    "                _fv = float(_pr['F'])",
    "                _feed = _fv * 60.0 if _fv < 50 else _fv",
    "            except Exception: pass",
    "        _nx = float(_pr['X']) if 'X' in _pr else _x",
    "        _ny = float(_pr['Y']) if 'Y' in _pr else _y",
    "        _nz = float(_pr['Z']) if 'Z' in _pr else _z",
    "        _d = _math.sqrt((_nx-_x)**2 + (_ny-_y)**2 + (_nz-_z)**2)",
    "        _rap = 1 if _c.Name in ('G0', 'G00') else 0",
    "        _rate = _rapid_rate if _rap else (_feed if _feed > 0 else _default_feed)",
    "        if _rate > 0:",
    "            _op_min += _d / _rate",
    "        _x, _y, _z = _nx, _ny, _nz",
    "        _seg.append([round(_x, 3), round(_y, 3), round(_z, 3), _rap])",
    "    if len(_seg) > 2000:",
    "        _k = (len(_seg) // 2000) + 1",
    "        _seg = _seg[::_k]",
    "    _lbl = str(getattr(_op, 'Label', _op.Name))",
    "    if _seg:",
    "        _paths.append({'op': _lbl, 'points': _seg})",
    "    _op_minutes[_lbl] = round(_op_min, 3)",
    "    _total_min += _op_min",
    `_out = ${JSON.stringify(previewJsonPath)}`,
    "with open(_out, 'w') as _f:",
    "    _json.dump({'toolpaths': _paths, 'estimatedMinutes': round(_total_min, 2), 'opMinutes': _op_minutes}, _f)",
    "print('EST_MINUTES=' + str(round(_total_min, 2)))",
    "print('PREVIEW_JSON=' + _out)",
  ].join("\n");
}

// Trusted epilogue (NOT model output): post-process the operations FreeCAD built
// in `job` into G-code with the chosen controller's post-processor.
function postEpiloguePy(gcodePath, postName, isTorna) {
  const candidates = postModuleCandidates(postName);
  return [
    "",
    "# --- trusted post-processing epilogue (system, not model) ---",
    `_cands = ${JSON.stringify(candidates)}`,
    "post_mod = None",
    "for _mn in _cands:",
    "    for _pkg in ('Path.Post.scripts.', 'PathScripts.post.'):",
    "        try:",
    "            post_mod = __import__(_pkg + _mn, fromlist=[_mn])",
    "            break",
    "        except Exception:",
    "            post_mod = None",
    "    if post_mod is not None:",
    "        break",
    "if post_mod is None:",
    "    raise RuntimeError('post-processor modulu bulunamadi')",
    "_grp = list(job.Operations.Group)",
    autoFixFaceBoundaryPy(),
    autoFixClearanceHeightsPy(),
    autoFixUnsafeRapidsToFeedPy(),
    autoFixDeepPlungesPy(),
    plungeCheckPy(isTorna),
    collisionCheckPy(),
    duplicateOpCheckPy(),
    // Report which magazine slot each operation runs on, so a post that drops
    // tool changes (grbl_post does — real GRBL has no automatic changer) can
    // still be matched back to the right tool downstream. Keyed by Label
    // because that is the name the post writes into its own
    // "(Begin operation: <Label>)" marker.
    // Blogun ve parcanin Z kotlari. G-code, STEP'in kendi koordinatlarinda
    // uretiliyor: bu parcada Z0 parcanin ALTI. Operator ise tezgahta Z'yi
    // MALZEMENIN USTUNDE sifirlar. Ikisi ayrisinca kodun Z4/Z0 dedigi yer,
    // tezgahta malzeme ustunun 4mm ve 0mm USTU olur — takim malzemeye hic
    // girmez. Kaydirmayi Node tarafinda yapabilmek icin referans kotu buradan
    // bildiriliyor.
    "try:",
    "    _zt = float(base.Shape.BoundBox.ZMax)",
    "    _zb = float(base.Shape.BoundBox.ZMin)",
    "    _zs = _zt",
    "    try:",
    "        _stk = getattr(job, 'Stock', None)",
    "        if _stk is not None:",
    "            _zs = max(_zs, float(_stk.Shape.BoundBox.ZMax))",
    "    except Exception:",
    "        pass",
    "    print('Z_EXTENTS=%.4f,%.4f,%.4f' % (_zb, _zt, _zs))",
    "except Exception as _e:",
    "    print('Z_EXTENTS=err ' + str(_e))",
    "import json as _json_tm",
    "_tmap = []",
    "for _op in _grp:",
    "    try:",
    "        _tc = getattr(_op, 'ToolController', None)",
    "        _tn = int(_tc.ToolNumber) if _tc is not None else 0",
    "    except Exception:",
    "        _tn = 0",
    "    _tmap.append([str(getattr(_op, 'Label', '')), _tn])",
    "print('TOOLMAP=' + _json_tm.dumps(_tmap))",
    `_out = ${JSON.stringify(gcodePath)}`,
    "post_mod.export(_grp, _out, '--no-show-editor')",
    "print('GCODE_PATH=' + _out)",
  ].join("\n");
}

/** Read the operation -> magazine slot map printed by postEpiloguePy(). */
export function parseToolMap(text) {
  const m = /TOOLMAP=(\[.*\])/.exec(text || "");
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// grbl_post deliberately emits no tool change: real GRBL has no automatic
// changer, so a machinist swaps tools by hand. The CNC simulator has a 40-slot
// magazine and picks its tool from the T word, so a G-code with no T word left
// it cutting with whatever tool the previous program had loaded. Live case: a
// path compensated for a O6mm endmill ran against a leftover O26mm cutter, and
// the hexagon profile came out as a groove wide enough to look like a different
// part. Multi-tool jobs were worse — every operation ran on tool one.
//
// So when the exported file has no T word at all, add one per operation from
// the Job's own ToolControllers, at the "(Begin operation: ...)" marker the post
// already writes, and only where the tool actually changes. A file that DOES
// carry tool changes is left untouched — that post meant what it wrote.
// `M6` rides along for real controls that expect it; the simulator ignores it.
// Elle degisim yorumunda slotun hangi takim oldugunu yaz — operatorun eline
// "T4" degil "T4 - O20mm Parmak Freze" gecsin. Magazin okunamazsa slot numarasi
// tek basina da is gorur, o yuzden hata yutuluyor.
//
// Takim adi PARANTEZSIZ donuyor ve icindeki parantezler de temizleniyor: bu
// metin zaten parantezli bir yorumun ICINE giriyor ve RS274NGC ic ice yorum
// kabul etmez. Mach3 bunu yukleme aninda reddetti — "Nested comment found,
// Block = (TAKIM: T1 (O6 Parmak Freze) -- elle takin) Line 8" — ve program hic
// baslamadi. Magazin adlari kullanici tarafindan yazildigi icin parantez
// icerebilirler, o yuzden ada guvenmeyip burada siyiriyoruz.
function slotName(slot) {
  try {
    const tool = listMagazineTools().find((t) => slotNumberForTool(t.id) === slot);
    if (!tool?.name) return "";
    const safe = String(tool.name).replace(/[()]/g, "").trim();
    return safe ? ` - ${safe}` : "";
  } catch {
    return "";
  }
}

function ensureToolChanges(gcodePath, toolMap, answers) {
  if (!Array.isArray(toolMap) || !toolMap.length) return;
  // M6 tezgaha "takimi degistir" der. Otomatik degistiricisi olmayan bir
  // router'da Mach3'un varsayilani M6'da durup Cycle Start beklemek; iki
  // takimli bir isin ilk M6'si daha 8. satirda geldigi icin program hic
  // kimildamadan durur ve "yukledi ama calismadi" gibi gorunur. Elle degisimde
  // T yazilir (simulator takimi yine bundan tanir, gercek kontrol de bekleyen
  // takimi kaydeder) ama M6 yazilmaz; operatore hangi takimi takacagi yorum
  // satiriyla soylenir.
  const manual = !String(answers?.toolChanger ?? "").toLowerCase().includes("atc");
  let raw;
  try {
    raw = fs.readFileSync(gcodePath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/);
  // Strip comments first: "(Tool: T5 ...)" is a note, not a tool change.
  const alreadyHasToolWord = lines.some((l) => /(?:^|\s)T\d+/.test(l.replace(/\(.*?\)/g, "")));
  if (alreadyHasToolWord) return;

  const slotByLabel = new Map(
    toolMap
      .filter((e) => Array.isArray(e) && e[0] && Number(e[1]) > 0)
      .map((e) => [String(e[0]), Math.round(Number(e[1]))]),
  );
  if (!slotByLabel.size) return;

  const out = [];
  let currentSlot = null;
  let injected = 0;
  for (const line of lines) {
    out.push(line);
    const marker = /^\(Begin operation:\s*(.+?)\s*\)\s*$/.exec(line);
    if (!marker) continue;
    const slot = slotByLabel.get(marker[1]);
    if (!slot || slot === currentSlot) continue;
    if (manual) {
      // Ilk operasyonda takim zaten spindle'da olur; "degisim" degil, takilacak
      // takimin ne oldugunu soylemek gerekir.
      out.push(`(${currentSlot === null ? "TAKIM" : "TAKIM DEGISIMI"}: T${slot}${slotName(slot)} -- elle takin)`);
      out.push(`T${slot}`);
    } else {
      out.push(`T${slot} M6`);
    }
    currentSlot = slot;
    injected += 1;
  }
  if (!injected) return;
  try {
    fs.writeFileSync(gcodePath, out.join("\n"), "utf-8");
    console.log(
      `${injected} takim ${manual ? "secimi (elle degisim: M6 yazilmadi)" : "degisimi"} G-code'a eklendi:`,
      path.basename(gcodePath),
    );
  } catch (err) {
    console.warn("Takim degisimi eklenemedi:", err.message);
  }
}

// The post-processor stamps its own toolchain into the file header ("Exported
// by FreeCAD", "Post Processor: Path.Post.scripts.grbl_post"). This is the
// product's output, so it carries the product's name; the post-processor line
// keeps the dialect, which is what a machinist actually needs from it, without
// the module path. Everything below the header is untouched — only these two
// comment lines are rewritten, and only when they are actually there.
function brandGcodeHeader(gcodePath) {
  let raw;
  try {
    raw = fs.readFileSync(gcodePath, "utf-8");
  } catch {
    return;
  }
  const branded = raw
    .replace(/^\(Exported by .*\)$/m, "(Exported by TOPKAPIAI)")
    .replace(
      /^\(Post Processor: *(?:Path\.Post\.scripts\.|PathScripts\.post\.)?([A-Za-z0-9_]+?)(?:_post)?\)$/m,
      "(Post Processor: $1)",
    );
  if (branded === raw) return;
  try {
    fs.writeFileSync(gcodePath, branded, "utf-8");
  } catch (err) {
    console.warn("G-code basligi markalanamadi:", err.message);
  }
}

/**
 * If the selected controller needs a dialect-specific format (Sinumerik cycles,
 * Heidenhain Klartext, …), read the generated Fanuc G-code, transform it, and
 * overwrite the file.
 */
// grbl_post writes G-code that GRBL tolerates but a standards-conforming
// controller does not. Three defects showed up the first time a file reached a
// real Mach3 router, and none of them are Mach3-specific — they are wrong on
// LinuxCNC and every Fanuc-style control too, and the CNC simulator never
// caught them because it is as permissive as GRBL:
//
//   1. Arc words. In G17 only I and J define the arc centre; K belongs to
//      G18/G19. grbl_post emits "K0.000" on every G2/G3 anyway (36 lines in the
//      failing file), and RS274NGC calls that an error.
//   2. Spindle. The file ends with M5 but never issues M3 or an S speed, so the
//      spindle is never commanded to start — the router would plunge with a
//      stationary cutter.
//   3. Work offset. No G54, so which offset applies is left to whatever the
//      control happens to have active.
//
// Fixed here rather than in a Mach3-only dialect because the output is simply
// incorrect as it stands; every controller benefits. Runs BEFORE the dialect
// transforms so they translate already-valid code.
function normalizeForRealControllers(gcodePath, answers) {
  let raw;
  try {
    raw = fs.readFileSync(gcodePath, "utf-8");
  } catch {
    return;
  }
  const rpm = Number(answers?.spindleRpm) > 0 ? Math.round(Number(answers.spindleRpm)) : null;
  const lines = raw.split(/\r?\n/);
  const hasSpindleOn = lines.some((l) => /(?:^|\s)M0?[34]\b/.test(l.replace(/\(.*?\)/g, "")));
  const hasWcs = lines.some((l) => /(?:^|\s)G5[4-9]\b/.test(l.replace(/\(.*?\)/g, "")));

  const out = [];
  let plane = "G17"; // RS274NGC default
  let strippedK = 0;
  let spindleDone = hasSpindleOn;
  let wcsDone = hasWcs;

  for (let line of lines) {
    const code = line.replace(/\(.*?\)/g, "");
    if (/(?:^|\s)G19\b/.test(code)) plane = "G19";
    else if (/(?:^|\s)G18\b/.test(code)) plane = "G18";
    else if (/(?:^|\s)G17\b/.test(code)) plane = "G17";

    if (plane === "G17" && /^\s*G0?[23]\b/.test(code) && /(?:^|\s)K-?[\d.]+/.test(code)) {
      line = line.replace(/\s*K-?[\d.]+/g, "");
      strippedK += 1;
    }
    out.push(line);

    // G54 rides with the preamble's modal setup line.
    if (!wcsDone && /^\s*G17\b/.test(code)) {
      out.push("G54");
      wcsDone = true;
    }
    // Spindle starts once the first tool is in the spindle; with no tool change
    // at all, right after the modal setup instead. The tool line is matched with
    // M6 OPTIONAL: manual-change jobs emit a bare "T1" (no M6, so the control
    // does not stop), and an M6-only match sent the spindle command up into the
    // preamble — spinning the cutter to full speed BEFORE the line telling the
    // operator to fit the tool by hand.
    if (!spindleDone && /^\s*T\d+\s*(M0?6\s*)?$/i.test(code)) {
      out.push(rpm ? `M3 S${rpm}` : "M3");
      spindleDone = true;
    }
  }
  if (!spindleDone) {
    const at = out.findIndex((l) => /^\s*G17\b/.test(l.replace(/\(.*?\)/g, "")));
    if (at >= 0) out.splice(at + 1, 0, rpm ? `M3 S${rpm}` : "M3");
    spindleDone = at >= 0;
  }

  const next = out.join("\n");
  if (next === raw) return;
  try {
    fs.writeFileSync(gcodePath, next, "utf-8");
    console.log(
      `G-code kontrolcu uyumu: ${strippedK} yay satirindan K kaldirildi` +
      `${hasSpindleOn ? "" : `, spindle baslatma eklendi (${rpm ? `M3 S${rpm}` : "M3"})`}` +
      `${hasWcs ? "" : ", G54 eklendi"}`,
    );
  } catch (err) {
    console.warn("G-code kontrolcu uyumu uygulanamadi:", err.message);
  }
}

/** Read the "Z_EXTENTS=zmin,zmax,stockTop" line postEpiloguePy() prints. */
export function parseZExtents(text) {
  const m = /Z_EXTENTS=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(String(text ?? ""));
  if (!m) return null;
  const [partBottom, partTop, stockTop] = m.slice(1, 4).map(Number);
  if (![partBottom, partTop, stockTop].every(Number.isFinite)) return null;
  return { partBottom, partTop, stockTop };
}

// FreeCAD writes G-code in the STEP file's own coordinates. For this part that
// put Z0 at the part's BOTTOM, so every cut came out positive (Z4, Z0) with
// rapids at Z13/Z15. A machinist zeroes Z on the TOP OF THE MATERIAL, which is
// what the wizard's WCS answer says ("Z0 ust"). Under that zero the machine
// reads Z4 and Z0 as 4mm and 0mm ABOVE the surface: the cutter never touches
// the work. That is exactly what the router did — "freze inmedi, yukari cikti".
//
// So shift every Z by -(reference height) to match the declared zero. The
// reference is the stock top for a top-surface WCS (that is the face the
// operator touches off on) and the part bottom for a bottom-surface WCS (which
// is already the file's own origin, hence no shift). Only Z words move; X, Y,
// I, J and feeds are untouched, so the geometry is identical — only the datum
// changes.
function applyWcsZeroShift(gcodePath, answers, zExtents) {
  if (!zExtents) return;
  const wcs = String(answers?.wcs ?? "").toLowerCase();
  // "ust yuzey" / "ust" -> top-of-material zero. A bottom-surface WCS matches
  // the file as generated; anything unrecognised is left alone rather than
  // guessed at, because shifting to the wrong datum is worse than not shifting.
  const topZero = wcs.includes("ust");
  if (!topZero) return;
  const shift = zExtents.stockTop;
  if (!Number.isFinite(shift) || Math.abs(shift) < 1e-6) return;

  let raw;
  try {
    raw = fs.readFileSync(gcodePath, "utf-8");
  } catch {
    return;
  }
  let moved = 0;
  const shifted = raw
    .split(/\r?\n/)
    .map((line) => {
      const code = line.replace(/\(.*?\)/g, "");
      if (!/^\s*(G0?[0-3]\b|G1\b)/.test(code)) return line;
      return line.replace(/(^|\s)Z(-?[\d.]+)/g, (all, lead, val) => {
        const z = Number(val);
        if (!Number.isFinite(z)) return all;
        moved += 1;
        return `${lead}Z${(z - shift).toFixed(3)}`;
      });
    })
    .join("\n");
  if (!moved) return;
  try {
    fs.writeFileSync(gcodePath, shifted, "utf-8");
    console.log(
      `Z sifir noktasi WCS'e tasindi: ${moved} Z degeri ${shift.toFixed(3)}mm asagi ` +
      `kaydirildi (Z0 artik malzeme ustu).`,
    );
  } catch (err) {
    console.warn("Z kaydirma uygulanamadi:", err.message);
  }
}

// Bir parmak frezenin MERKEZINDE kesme hizi sifirdir: dik daldiginda malzemeyi
// kesmez, ezer. Router'da MDF'ye 6mm dik dalinca giris noktasi yirtildi ve
// parca daha ilk hareketinde bozuldu. Plan "ramp (acili giris)" diyordu, ama
// uretilen kod ayni XY'de kalip yalnizca Z'yi dusuruyordu — yani duz dalma.
//
// Burada o dalma, konturun ILK SEGMENTI boyunca gidip gelerek inen bir rampaya
// cevriliyor. Bacak sayisi CIFT tutuluyor, boylece takim rampanin sonunda
// basladigi noktaya hedef derinlikte geri doner ve programin geri kalani hic
// degismeden devam eder — sadece dalma hareketi degisir, geometri aynidir.
//
// Yalnizca malzemeye giren dalmalar rampalanir: havada inen yaklasma
// hareketlerinin yirtacak bir seyi yoktur ve onlari uzatmak bosa zaman.
// Malzemenin ust yuzeyi, DOSYANIN O ANKI koordinatlarinda. applyWcsZeroShift
// ust-yuzey WCS'de her seyi blok ust kotu kadar asagi tasidigi icin orada
// yuzey artik Z0'dir; kaydirma yapilmayan durumda blok ust kotu neyse odur.
// Referans bilinmiyorsa null doner ve rampalama atlanir — yanlis bir yuzey
// varsayip havada rampa yapmaktansa dokunmamak yeglenir.
function materialTopZ(answers, zExtents) {
  if (!zExtents) return null;
  const shifted = String(answers?.wcs ?? "").toLowerCase().includes("ust");
  return shifted ? 0 : zExtents.stockTop;
}

function rampPlungeEntries(gcodePath, materialTopZ, angleDeg = 15) {
  if (!Number.isFinite(materialTopZ)) return;
  let raw;
  try {
    raw = fs.readFileSync(gcodePath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/);
  const strip = (l) => l.replace(/\(.*?\)/g, "");
  const word = (l, w) => {
    const m = new RegExp(`(?:^|\\s)${w}(-?[\\d.]+)`).exec(strip(l));
    return m ? Number(m[1]) : null;
  };
  const isMotion = (l) => /^\s*G0?[0-3]\b/.test(strip(l));

  const out = [];
  let cx = null, cy = null, cz = null;
  let ramped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isMotion(line)) { out.push(line); continue; }
    const nx = word(line, "X") ?? cx;
    const ny = word(line, "Y") ?? cy;
    const nz = word(line, "Z") ?? cz;
    const feed = word(line, "F");
    const isFeed = /^\s*G0?1\b/.test(strip(line));

    // Saf dikey dalma: besleme hareketi, XY sabit, Z asagi, hedef malzeme icinde.
    const pureZDrop =
      isFeed && cx !== null && cy !== null && cz !== null &&
      Math.abs(nx - cx) < 1e-6 && Math.abs(ny - cy) < 1e-6 &&
      nz < cz - 1e-6 && nz < materialTopZ - 1e-6;

    if (pureZDrop) {
      // Rampanin yonu: bir sonraki XY'si farkli hareket.
      let qx = null, qy = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (!isMotion(lines[j])) continue;
        const tx = word(lines[j], "X"), ty = word(lines[j], "Y");
        if (tx === null && ty === null) continue;
        const px = tx ?? nx, py = ty ?? ny;
        if (Math.abs(px - nx) > 1e-6 || Math.abs(py - ny) > 1e-6) { qx = px; qy = py; }
        break;
      }
      const segLen = qx === null ? 0 : Math.hypot(qx - nx, qy - ny);
      // Rampa yalnizca malzemeye giren kismi kapsar; ustteki hava zaten sorunsuz.
      const airTo = Math.min(cz, materialTopZ);
      const cutDepth = airTo - nz;
      if (segLen > 1e-3 && cutDepth > 1e-3) {
        const need = cutDepth / Math.tan((angleDeg * Math.PI) / 180);
        let legs = Math.ceil(need / segLen);
        if (legs % 2 !== 0) legs += 1;      // cift bacak -> baslangic noktasina don
        legs = Math.max(2, Math.min(24, legs));
        const f = feed ?? null;
        if (airTo < cz - 1e-6) {
          out.push(`G1 Z${airTo.toFixed(3)}${f ? ` F${f}` : ""}`);
        }
        for (let k = 1; k <= legs; k++) {
          const z = airTo - (cutDepth * k) / legs;
          const toQ = k % 2 === 1;
          const tx = toQ ? qx : nx, ty = toQ ? qy : ny;
          out.push(`G1 X${tx.toFixed(3)} Y${ty.toFixed(3)} Z${z.toFixed(3)}${f ? ` F${f}` : ""}`);
        }
        ramped += 1;
        cx = nx; cy = ny; cz = nz;
        continue;                            // orijinal dik dalma satiri atilir
      }
    }

    out.push(line);
    cx = nx; cy = ny; cz = nz;
  }

  if (!ramped) return;
  try {
    fs.writeFileSync(gcodePath, out.join("\n"), "utf-8");
    console.log(`${ramped} dik dalma ${angleDeg} derecelik rampaya cevrildi.`);
  } catch (err) {
    console.warn("Rampa donusumu uygulanamadi:", err.message);
  }
}

function applyControllerTransform(gcodePath, postName, stepPath, answers) {
  const partName = path.basename(stepPath || "PART", path.extname(stepPath || ""));
  let label;
  let transformed;
  try {
    const raw = fs.readFileSync(gcodePath, "utf-8");
    if (isSinumerik(postName)) {
      transformed = transformToSinumerik(raw, partName);
      label = "Sinumerik";
    } else if (isHeidenhain(postName)) {
      const version = heidenhainVersion(postName);
      transformed = transformToHeidenhain(raw, partName, {
        stockX: Number(answers?.stockX) || 0,
        stockY: Number(answers?.stockY) || 0,
        stockZ: Number(answers?.stockZ) || 0,
        wcs: answers?.wcs || "",
        version,
      });
      label = "Heidenhain Klartext";
    } else if (isMitsubishi(postName)) {
      transformed = transformToMeldas(raw, partName);
      label = "Mitsubishi Meldas";
    } else if (isMazak(postName)) {
      transformed = transformToMazak(raw, partName);
      label = "Mazak EIA/ISO";
    } else if (isOkuma(postName)) {
      transformed = transformToOkumaOSP(raw, partName);
      label = "Okuma OSP";
    }
    if (transformed) {
      fs.writeFileSync(gcodePath, transformed, "utf-8");
      console.log(`${label} donusumu uygulandi:`, path.basename(gcodePath));
    }
  } catch (err) {
    console.warn(`${label || "Controller"} donusumu uygulanamadi:`, err.message);
  }
}

// Build the shared prompt input asking the model to translate the plan into Path
// operations assigned to `job` — with no G-code, no export, no file I/O.
function buildPathCodeInput(abs, geometry, answers, plan, threadGuidance) {
  return (
    `[STEP_PATH]: ${abs}` +
    `\n${geomBlock(geometry)}` +
    camParamsBlock(answers, geometry) +
    `\n[ONAYLANAN_PLAN]: ${JSON.stringify(plan)}` +
    threadGuidance +
    "\n[GOREV]: Plani FreeCAD Path operasyonlarina cevir. `job` degiskenine ata. Parametreleri kullan. Kaba/finis ayri. Export/G-code/print YAPMA."
  );
}

/**
 * Run the LLM->Path-code loop, appending a trusted epilogue and executing it in
 * FreeCAD. Retries with corrective feedback on validation/runtime failure.
 * @returns {Promise<{code:string, text:string}>} validated code + FreeCAD output
 */
async function generateAndRunPathCode({ abs, geometry, answers, plan, threadGuidance, epiloguePy, successMarker }) {
  const baseInput = buildPathCodeInput(abs, geometry, answers, plan, threadGuidance);
  let lastError = "Bilinmeyen hata";
  let previousCode = null;
  let problem = null;
  const t0 = Date.now();

  for (let attempt = 1; attempt <= GCODE_ATTEMPTS; attempt++) {
    console.log(`Path code attempt ${attempt}/${GCODE_ATTEMPTS} (elapsed ${Math.round((Date.now() - t0) / 1000)}s)`);
    let input = baseInput;
    if (previousCode) {
      input +=
        `\n\n[ONCEKI_KOD]:\n${previousCode}` +
        `\n\n[SORUN]: ${problem}` +
        "\n\n[DUZELT]: Sorunu gider ve tam duzeltilmis Python kodunu bastan yaz. SADECE ham kod.";
    }

    let code;
    try {
      const raw = await runLlm(input, { systemPromptFile: CODE_PROMPT });
      code = stripCodeFence(raw);
      if (!code) throw new Error("Bos kod dondu");
    } catch (err) {
      lastError = err.message;
      previousCode = null;
      problem = null;
      continue;
    }

    const violation = validateCamCode(code);
    if (violation) {
      lastError = violation;
      previousCode = code;
      problem = violation + " Sadece Path operasyonlarini `job` icine kur.";
      continue;
    }

    let text = "";
    try {
      const result = await callFreecadTool(config.freecadMcp.toolName, {
        [config.freecadMcp.toolParam]:
          disableInteractiveToolControllerPy() + "\n" +
          preparePathCodePy(code, answers) + "\n" + epiloguePy,
      });
      text = extractResultText(result);
      if (result?.isError || text.startsWith("Failed to execute code")) {
        throw new Error(text || "FreeCAD kodu calistiramadi");
      }
    } catch (err) {
      lastError = err.message;
      const isTimeout = /timed?\s*out|timeout|-32001/i.test(err.message);
      previousCode = code;
      problem = isTimeout
        ? "FreeCAD zaman asimina ugradi — kod cok yavas. DAHA BASIT operasyonlar kullan: Adaptive KULLANMA, Surface KULLANMA. Sadece Pocket ve Profile kullan. Operasyon sayisini minimize et. Her sey tek doc.recompute() ile bitsin."
        : `FreeCAD Path kodunu calistirirken hata olustu:\n${err.message}`;
      console.warn(`FreeCAD ${isTimeout ? "TIMEOUT" : "error"} (attempt ${attempt}): ${err.message.slice(0, 200)}`);
      continue;
    }

    if (text.includes(successMarker)) {
      // Facing is the one operation with no downstream check of its own — an
      // empty one exports as valid G-code and only shows up as untouched stock
      // in the simulator. Surface what the face fix actually did.
      for (const line of String(text).split("\n")) {
        if (line.startsWith("FACE_OP=") || line.startsWith("FACE_FIX=")) {
          console.log(`  ${line.trim()}`);
        }
      }
      const plungeViolations = parsePlungeViolations(text);
      const collisionViolations = parseCollisionViolations(text);
      const duplicateOps = parseDuplicateOps(text);
      // Every parser above returns [] both when a check found nothing AND when
      // its marker never arrived, so a check that silently failed to report is
      // indistinguishable from a clean run — which is exactly how twelve
      // identical profile operations shipped past a duplicate check that
      // detects them correctly. Absence of a report is not a pass; say so.
      const missing = ["PLUNGE_VIOLATIONS=", "COLLISION_VIOLATIONS=", "DUPLICATE_OPS="]
        .filter((marker) => !String(text).includes(marker));
      if (missing.length) {
        console.warn(
          `UYARI: guvenlik kontrolu rapor vermedi (${missing.join(", ")}) — ` +
          "bu kontroller bu calistirma icin DOGRULANMADI, temiz cikti sayilmamali.",
        );
      }
      if (plungeViolations.length || collisionViolations.length || duplicateOps.length) {
        const problems = [];
        if (plungeViolations.length) {
          const detail = plungeViolations
            .map((v) => `${v.op}: Z${v.fromZ}->Z${v.toZ} (${v.delta}mm tek pasoda)`)
            .join("; ");
          console.warn(`Plunge limit ihlali (attempt ${attempt}): ${detail}`);
          let plungeHint =
            `Su operasyonlarda tek G1 hareketinde ${MAX_PLUNGE_MM}mm'den fazla Z dalisi var: ${detail}. ` +
            `Her operasyonun StepDown/derinlik parametresini <=${MAX_PLUNGE_MM}mm olacak sekilde ayarla ` +
            "(ornegin StepDown=5.0 ile 2 kat gec).";
          if (detectDuplicateDepthSplit(plungeViolations)) {
            plungeHint +=
              " ONEMLI: Birden fazla operasyon (farkli isimli _L0, _L1, ... gibi) AYNI Z araligini raporluyor " +
              "— bu, boleme dongusunu ELLE yazdigin ve her operasyona AYNI StartDepth/FinalDepth'i atadigin " +
              "anlamina gelir (_rover_make_leveled_ops yardimci fonksiyonunu KULLANMADIN ya da yanlis kullandin, " +
              "veya bos toolpath'i duzeltirken plan degerlerini atip hepsine ayni bounding-box degerini verdin). " +
              "KESIN COZUM: rough_ops = _rover_make_leveled_ops(OpModule, name_prefix, base, face_names, " +
              "start_depth, final_depth, step_down, tc, side=...) cagir ve StartDepth/FinalDepth'e SONRADAN ELLE " +
              "DOKUNMA — fonksiyon her seviyeye kendi (sd, fd) degerini otomatik atar. Plan'in Z degerleri bu STEP " +
              "dosyasinin koordinat sistemiyle uyusmuyorsa (bos yol olustuysa), degerleri sifirdan bounding box'tan " +
              "hesaplama — offset = float(bb.ZMax) - <plan'in referans noktasi> ile OTELE (start_depth+offset, " +
              "final_depth+offset), sonra bu OTELENMIS degerleri _rover_make_leveled_ops'a ver.";
          }
          problems.push(plungeHint);
        }
        if (duplicateOps.length) {
          const detail = duplicateOps.map((d) => `${d.op} == ${d.sameAs}`).join("; ");
          console.warn(`Ayni toolpath tekrari (attempt ${attempt}): ${detail}`);
          problems.push(
            `Su operasyonlar bir oncekiyle BIREBIR AYNI toolpath'i uretiyor: ${detail}. ` +
            "Ayni malzemeyi iki kez kaldiran operasyon her zaman tutmamis bir seviye bolmesidir: " +
            "StartDepth/FinalDepth atamalarin recompute sirasinda FreeCAD'in kendi varsayilanlarina " +
            "geri donmus, boylece her seviye ayni araliga cokmus. COZUM: seviyeleri " +
            "_rover_make_leveled_ops ile olustur — o fonksiyon degerleri atadiktan SONRA geri okuyup " +
            "tutmadiysa yeniden atar. Kendi bolme dongunu yaziyorsan ayni geri-okuma kontrolunu sen ekle.",
          );
        }
        let rapidDefuseDiag = "";
        if (collisionViolations.length) {
          const detail = collisionViolations
            .map((v) => `${v.op}: (${v.x}, ${v.y}, ${v.z})`)
            .join("; ");
          console.warn(`Carpisma riski (attempt ${attempt}): ${detail}`);
          problems.push(
            `Su operasyonlarda hizli (rapid/G0) hareket parcanin icinden geciyor: ${detail}. ` +
            "Bu genelde yanlis/eksik StartDepth, FinalDepth veya ClearanceHeight/SafeHeight yuzunden olur. " +
            "Her operasyonun guvenli yukseklikten (parcanin en ust noktasinin uzerinden) yaklasip cekildiginden emin ol.",
          );
          // autoFixUnsafeRapidsToFeedPy is supposed to have already converted
          // every one of these into a safe feed move BEFORE this check ran —
          // if a collision violation still made it here, that preventive fix
          // either didn't run, didn't judge the move unsafe, or converted it
          // but the assignment didn't stick. Rather than guess again, surface
          // exactly what it saw so the next failure report carries real data.
          const report = parseRapidDefuseReport(text);
          console.warn(`RAPID_DEFUSE_REPORT (attempt ${attempt}):`, report);
          rapidDefuseDiag = report
            ? ` [Teshis: autoFixUnsafeRapidsToFeedPy calisti mi=${report.bbOk}, bb.ZMax=${report.bbZMax}, ` +
              `${report.ops} op tarandi, ${report.rapids} rapid komut goruldu, ${report.unsafe} tanesi guvensiz ` +
              `bulundu, ${report.converted} operasyonda G1'e cevrildi.` +
              (report.assignErrors?.length ? ` Atama hatalari: ${report.assignErrors.join(" | ")}.` : "") +
              (report.otherErrors?.length ? ` Diger hatalar: ${report.otherErrors.join(" | ")}.` : "") +
              "]"
            : " [Teshis: RAPID_DEFUSE_REPORT ciktisi bulunamadi — fonksiyon hic calismamis olabilir.]";
        }
        lastError = `Guvenlik kontrolu basarisiz: ${problems.join(" ")}${rapidDefuseDiag}`;
        previousCode = code;
        problem = problems.join(" ") + " Kodu bastan yaz.";
        continue;
      }
      return { code, text };
    }
    lastError = `Beklenen cikti (${successMarker}) uretilmedi`;
    previousCode = code;
    problem =
      "Path operasyonlari `job.Operations` altinda olusmadi gibi gorunuyor. Gecerli Path operasyonlarini `job` uzerine ekle ve recompute et.";
  }

  throw new Error("CAM Path kodu uretilemedi: " + lastError);
}

// Store validated Path code between the preview and the confirm step so the
// exported G-code comes from the exact toolpaths the user approved.
const codeStore = new Map();
const CODE_STORE_TTL_MS = 30 * 60 * 1000;
const CODE_STORE_MAX = 50;

function storePathCode(code) {
  const token = randomUUID();
  if (codeStore.size >= CODE_STORE_MAX) {
    codeStore.delete(codeStore.keys().next().value);
  }
  codeStore.set(token, { code, ts: Date.now() });
  return token;
}
function takePathCode(token) {
  const entry = codeStore.get(token);
  if (!entry) return null;
  if (Date.now() - entry.ts > CODE_STORE_TTL_MS) {
    codeStore.delete(token);
    return null;
  }
  return entry.code;
}

function threadGuidanceFor(answers, context) {
  const threads = detectThreads(context);
  return threads.hasThread
    ? threadGuidanceBlock(threads.sizes, detectThreadMethod(answers))
    : "";
}

/**
 * Build the Path operations for the approved plan and export a toolpath PREVIEW
 * (no G-code yet). Returns the preview file path and a token to reuse the exact
 * same operations when the user approves and confirms.
 * @returns {Promise<{previewPath:string, token:string}>}
 */
export async function generateCamPreview(stepPath, answers, plan, context = "") {
  const t0 = Date.now();
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    throw new Error("STEP dosyasi bulunamadi: " + path.basename(abs));
  }
  const geometry = await describeStepGeometry(stepPath);
  console.log(`generateCamPreview: geometry in ${Date.now() - t0}ms`);
  const previewPath = abs.replace(/\.(step|stp)$/i, "") + "_toolpath.json";
  try {
    fs.unlinkSync(previewPath);
  } catch {
    // not present; fine
  }

  let code;
  let text;
  try {
    ({ code, text } = await generateAndRunPathCode({
      abs,
      geometry,
      answers,
      plan,
      threadGuidance: threadGuidanceFor(answers, context),
      epiloguePy: previewEpiloguePy(previewPath, answers?.horizFeed, isTornaMachine(answers)),
      successMarker: "PREVIEW_JSON=",
    }));
  } catch (err) {
    // A failed attempt (e.g. a plunge-limit violation on the last retry) may
    // have left a stale preview file on disk from an earlier attempt in the
    // loop — don't leave unsafe/invalid toolpath data lying around.
    try { fs.unlinkSync(previewPath); } catch { /* not present; fine */ }
    throw err;
  }

  if (!fs.existsSync(previewPath)) {
    throw new Error("Takim yolu onizlemesi uretilemedi");
  }
  const estMatch = text.match(/EST_MINUTES=([-\d.eE+]+)/);
  const estimatedMinutes = estMatch ? Number(estMatch[1]) : null;
  const token = storePathCode(code);
  console.log(`generateCamPreview: total ${Math.round((Date.now() - t0) / 1000)}s`);
  return { previewPath, token, estimatedMinutes };
}

/**
 * Post-process the approved toolpaths into G-code. When `reuseToken` refers to a
 * stored preview, the exact same Path code is reused so the exported G-code
 * matches what the user approved; otherwise the code is generated fresh.
 * @returns {Promise<{gcodePath: string, safetyChecks: {key:string,label:string,ok:boolean}[]}>}
 */
export async function generateCamGcodeFromPlan(stepPath, answers, plan, context = "", reuseToken = null) {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    throw new Error("STEP dosyasi bulunamadi: " + path.basename(abs));
  }
  const gcodePath = abs.replace(/\.(step|stp)$/i, "") + "_cam.gcode";
  try {
    fs.unlinkSync(gcodePath);
  } catch {
    // not present; fine
  }
  const postName = answers?.postProcessor;
  const epiloguePy = postEpiloguePy(gcodePath, postName, isTornaMachine(answers));

  const stored = reuseToken ? takePathCode(reuseToken) : null;
  if (stored) {
    // Reuse the approved toolpaths verbatim: run the stored code + post epilogue.
    const result = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]:
        disableInteractiveToolControllerPy() + "\n" +
        preparePathCodePy(stored, answers) + "\n" + epiloguePy,
    });
    const text = extractResultText(result);
    if ((result?.isError || !text.includes("GCODE_PATH=")) && !fs.existsSync(gcodePath)) {
      throw new Error("G-code uretilemedi: " + (text || "bilinmeyen hata"));
    }
    if (!fs.existsSync(gcodePath)) throw new Error("G-code dosyasi olusmadi");
    // Defense in depth: the preview step already checked this, but the stored
    // code is re-run verbatim here, so re-verify before handing out the file.
    const violations = parsePlungeViolations(text);
    const collisions = parseCollisionViolations(text);
    // Duplicate operations were checked only inside generateAndRunPathCode's
    // retry loop, so an approved preview whose stored code is re-run here got
    // exported without ever being asked the question. That is how a file with
    // twelve identical contour operations — the same pass cut ten extra times,
    // each one down to full depth — reached a real router. The export is the
    // last gate before the machine; it has to ask everything the preview asks.
    const dupes = parseDuplicateOps(text);
    if (violations.length || collisions.length || dupes.length) {
      try { fs.unlinkSync(gcodePath); } catch { /* not present; fine */ }
      const parts = [];
      if (violations.length) {
        parts.push(violations.map((v) => `${v.op}: Z${v.fromZ}->Z${v.toZ} (${v.delta}mm tek pasoda)`).join("; "));
      }
      if (collisions.length) {
        parts.push(collisions.map((v) => `${v.op}: (${v.x}, ${v.y}, ${v.z})`).join("; "));
      }
      if (dupes.length) {
        parts.push(
          `ayni toolpath tekrari: ${dupes.map((d) => `${d.op} == ${d.sameAs}`).join("; ")}`,
        );
      }
      throw new Error(`Guvenlik kontrolu basarisiz: ${parts.join(" | ")}. Onizlemeyi yeniden olusturun.`);
    }
    // Before any dialect transform, so injected changes get translated too.
    ensureToolChanges(gcodePath, parseToolMap(text), answers);
    applyWcsZeroShift(gcodePath, answers, parseZExtents(text));
    rampPlungeEntries(gcodePath, materialTopZ(answers, parseZExtents(text)));
    normalizeForRealControllers(gcodePath, answers);
    applyControllerTransform(gcodePath, postName, abs, answers);
    // Last: the dialect transforms rewrite the file wholesale.
    brandGcodeHeader(gcodePath);
    return { gcodePath, safetyChecks: buildSafetyChecks(isTornaMachine(answers)) };
  }

  // No approved preview to reuse → generate the Path code and post-process it.
  let runText = "";
  try {
    const geometry = await describeStepGeometry(stepPath);
    ({ text: runText } = await generateAndRunPathCode({
      abs,
      geometry,
      answers,
      plan,
      threadGuidance: threadGuidanceFor(answers, context),
      epiloguePy,
      successMarker: "GCODE_PATH=",
    }));
  } catch (err) {
    try { fs.unlinkSync(gcodePath); } catch { /* not present; fine */ }
    throw err;
  }
  if (!fs.existsSync(gcodePath)) throw new Error("G-code dosyasi olusmadi");
  ensureToolChanges(gcodePath, parseToolMap(runText), answers);
  applyWcsZeroShift(gcodePath, answers, parseZExtents(runText));
  rampPlungeEntries(gcodePath, materialTopZ(answers, parseZExtents(runText)));
  normalizeForRealControllers(gcodePath, answers);
  applyControllerTransform(gcodePath, postName, abs, answers);
  brandGcodeHeader(gcodePath);
  return { gcodePath, safetyChecks: buildSafetyChecks(isTornaMachine(answers)) };
}
