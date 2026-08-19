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
    "    _safe_z = float(_bb.ZMax) + 5.0",
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
    "            _new_cmds = []",
    "            _px = _py = _pz = None",
    "            _changed = False",
    "            _default_feed = 300.0",
    "            try:",
    "                _tc = getattr(_op, 'ToolController', None)",
    "                if _tc is not None:",
    "                    _default_feed = float(_tc.VertFeed.Value)",
    "            except Exception:",
    "                pass",
    "            for _c in _p.Commands:",
    "                _pr = dict(_c.Parameters)",
    "                _rapid = _c.Name in ('G0', 'G00')",
    "                if _rapid:",
    "                    _report['rapids'] += 1",
    "                _nx = float(_pr['X']) if 'X' in _pr else _px",
    "                _ny = float(_pr['Y']) if 'Y' in _pr else _py",
    "                _nz = float(_pr['Z']) if 'Z' in _pr else _pz",
    "                _unsafe = False",
    "                if _rapid and _px is not None and _nx is not None and _ny is not None and _nz is not None:",
    "                    _dist = ((_nx-_px)**2 + (_ny-_py)**2 + (_nz-_pz)**2) ** 0.5",
    "                    if _dist > 0.5 and min(_pz, _nz) <= _bb.ZMax + 0.5:",
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
    "                if _nx is not None: _px = _nx",
    "                if _ny is not None: _py = _ny",
    "                if _nz is not None: _pz = _nz",
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
function autoFixDeepPlungesPy() {
  return [
    "def _rover_split_deep_plunges(_grp):",
    "    import math as _math",
    `    _max_plunge = ${MAX_PLUNGE_MM}`,
    "    for _op in _grp:",
    "        _p = getattr(_op, 'Path', None)",
    "        if _p is None:",
    "            continue",
    "        _new_cmds = []",
    "        _px = _py = _pz = None",
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
    "_rover_split_deep_plunges(_grp)",
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
    autoFixClearanceHeightsPy(),
    autoFixUnsafeRapidsToFeedPy(),
    autoFixDeepPlungesPy(),
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
    plungeCheckPy(isTorna),
    collisionCheckPy(),
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
    autoFixClearanceHeightsPy(),
    autoFixUnsafeRapidsToFeedPy(),
    autoFixDeepPlungesPy(),
    plungeCheckPy(isTorna),
    collisionCheckPy(),
    `_out = ${JSON.stringify(gcodePath)}`,
    "post_mod.export(_grp, _out, '--no-show-editor')",
    "print('GCODE_PATH=' + _out)",
  ].join("\n");
}

/**
 * If the selected controller needs a dialect-specific format (Sinumerik cycles,
 * Heidenhain Klartext, …), read the generated Fanuc G-code, transform it, and
 * overwrite the file.
 */
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
          wrapWithTracebackPy(sanitizeFreeCADCode(code)) + "\n" + epiloguePy,
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
      const plungeViolations = parsePlungeViolations(text);
      const collisionViolations = parseCollisionViolations(text);
      if (plungeViolations.length || collisionViolations.length) {
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
        wrapWithTracebackPy(sanitizeFreeCADCode(stored)) + "\n" + epiloguePy,
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
    if (violations.length || collisions.length) {
      try { fs.unlinkSync(gcodePath); } catch { /* not present; fine */ }
      const parts = [];
      if (violations.length) {
        parts.push(violations.map((v) => `${v.op}: Z${v.fromZ}->Z${v.toZ} (${v.delta}mm tek pasoda)`).join("; "));
      }
      if (collisions.length) {
        parts.push(collisions.map((v) => `${v.op}: (${v.x}, ${v.y}, ${v.z})`).join("; "));
      }
      throw new Error(`Guvenlik kontrolu basarisiz: ${parts.join(" | ")}. Onizlemeyi yeniden olusturun.`);
    }
    applyControllerTransform(gcodePath, postName, abs, answers);
    return { gcodePath, safetyChecks: buildSafetyChecks(isTornaMachine(answers)) };
  }

  // No approved preview to reuse → generate the Path code and post-process it.
  try {
    const geometry = await describeStepGeometry(stepPath);
    await generateAndRunPathCode({
      abs,
      geometry,
      answers,
      plan,
      threadGuidance: threadGuidanceFor(answers, context),
      epiloguePy,
      successMarker: "GCODE_PATH=",
    });
  } catch (err) {
    try { fs.unlinkSync(gcodePath); } catch { /* not present; fine */ }
    throw err;
  }
  if (!fs.existsSync(gcodePath)) throw new Error("G-code dosyasi olusmadi");
  applyControllerTransform(gcodePath, postName, abs, answers);
  return { gcodePath, safetyChecks: buildSafetyChecks(isTornaMachine(answers)) };
}
