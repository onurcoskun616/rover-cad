import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import {
  disableInteractiveToolControllerPy,
  wrapWithTracebackPy,
  previewEpiloguePy,
  postEpiloguePy,
  parsePlungeViolations,
  parseCollisionViolations,
  applyControllerTransform,
  unsupportedControllerWarning,
} from "./camAssistantService.js";
import { OPERATION_TYPES } from "./stockCamPlanService.js";

// Faz 4/5/7: turns a stock-based plan's CONFIRMED operations (Faz 1's
// validated, structured data — never free text, never LLM output) into
// real FreeCAD Path operations, deterministically. Unlike CAM Asistanı's
// STEP-file flow, no LLM writes this Python at all: every value here was
// already validated by stockCamPlanService.validateOperationParams(), so
// generation is a straight, fixed template substitution — the same
// discipline as camAssistantService.js's autoFix*Py functions, applied one
// level earlier (building the job in the first place, not just correcting
// it afterward).
//
// Editing an operation never patches a live FreeCAD document — every call
// rebuilds the WHOLE job from `plan.operations[0..n]` in a fresh FreeCAD
// document, then runs it through the exact trusted-epilogue chain every
// other CAM flow in this codebase uses (autoFixClearanceHeightsPy ->
// autoFixPrematureDescentPy -> autoFixUnsafeRapidsToFeedPy ->
// autoFixDeepPlungesPy -> plungeCheckPy -> collisionCheckPy, all inside
// previewEpiloguePy/postEpiloguePy). That's what makes Faz 5's "correct an
// earlier step after 5 more were added" safe: there is no partial state to
// get wrong, only ever a full, freshly-verified rebuild.

function pyFloat(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`Beklenmeyen sayisal olmayan deger: ${n}`);
  // Always emit an explicit decimal point so Python parses this as a float,
  // never as int-then-surprise-integer-division somewhere downstream.
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

function pyStr(s) {
  return JSON.stringify(String(s));
}

function stockPy(stock) {
  const w = pyFloat(stock.w), d = pyFloat(stock.d), h = pyFloat(stock.h);
  return [
    "import FreeCAD as App",
    "import Part, Path",
    "try:",
    "    from Path.Main import Job as PathJob",
    // Path.Op.Pocket is FreeCAD 1.1's "CAM 3D Pocket Operation": its
    // areaOpShapes() does env.cut(base[0].Shape) expecting base[0] to be a
    // real 3D solid feature with an actual modeled cavity — cutting a solid
    // envelope by our flat, zero-volume Part::Feature profile face isn't a
    // valid solid boolean there, which is exactly what produced the "Null
    // shape" ValueError seen live (confirmed by reading FreeCAD 1.1.3's real
    // source, src/Mod/CAM/Path/Op/Pocket.py vs PocketShape.py). PocketShape
    // ("CAM Pocket Shape Operation") is the one built for exactly our case:
    // classifySubFace() recognizes a flat face whose plane normal is
    // vertical, translates it to FinalDepth and extrudes it up to
    // StartDepth to make the removal solid — precisely the profile shape
    // rectFacePy/circFacePy already build. Same base class (PathPocketBase
    // -> PathAreaOp -> PathOp), so Base/StartDepth/FinalDepth/StepDown/
    // ToolController all still work unchanged; only the import needs to
    // point at the right module.
    "    import Path.Op.PocketShape as PathPocket",
    "    import Path.Op.Drilling as PathDrilling",
    // Path.Op.Profile — confirmed real module (Path/Op/Profile.py,
    // class ObjectProfile), used for the "Kontur Kesme" operation: cuts
    // along a boundary wire/face rather than clearing its interior. Its
    // Side property ("Outside"/"Inside", confirmed enum values from the
    // same source) picks which side of the boundary the tool removes
    // material from.
    "    import Path.Op.Profile as PathProfile",
    "except Exception:",
    "    from PathScripts import PathJob, PathPocket, PathDrilling, PathProfile",
    "try:",
    "    import Path.Tool.Controller as PathToolController",
    "except Exception:",
    "    try:",
    "        from Path.Main.Tool import Controller as PathToolController",
    "    except Exception:",
    "        from PathScripts import PathToolController",
    "",
    // Force-close any document left open from a previous run before opening
    // a fresh one — the same guard camService.js's stepInsertPy uses for the
    // STEP-file CAM flow. Skipping this is what caused a live "GUI dispatch
    // timed out after 90s" failure: FreeCAD's shared, persistent GUI process
    // still had a document open (from an earlier attempt — including a
    // same-operation double-confirm, since two concurrent runs both call
    // this), and something about that stale state blocked the GUI thread.
    "if App.ActiveDocument is not None:",
    "    try:",
    "        App.closeDocument(App.ActiveDocument.Name)",
    "    except Exception:",
    "        pass",
    "doc = App.newDocument('RoverStockJob')",
    `_stock_w, _stock_d, _stock_h = ${w}, ${d}, ${h}`,
    "_stock_solid = Part.makeBox(_stock_w, _stock_d, _stock_h, App.Vector(-_stock_w/2.0, -_stock_d/2.0, 0.0))",
    "base = doc.addObject('Part::Feature', 'Stok')",
    "base.Shape = _stock_solid",
    "doc.recompute()",
    "job = PathJob.Create('RoverStockJob', [base], None)",
    "doc.recompute()",
    "tc = job.Tools.Group[0]",
    "tc.HorizFeed = '600 mm/min'",
    "tc.VertFeed = '150 mm/min'",
    "tc.SpindleSpeed = 4000.0",
    "tc.Tool.Diameter = 6.0",
  ].join("\n");
}

// Tool diameter picked from the operation's own geometry, matching the
// simple convention CNC Simülatör's local taiRunMillWithTool already uses.
// The proper magazine-based selection this comment used to call a
// "documented follow-up" is now wired in — cnc-sim.html's own ToolMagazine
// (real registered tools, findSlotForOp()) resolves a real tool BEFORE
// confirming an operation and sends its diameter through as `toolDia` in
// the op's own params. When present, that real diameter wins outright;
// the geometry-based guesses below only run as a fallback (magazine has no
// fitting tool, or an older client that doesn't send one yet).
function toolDiameterFor(type, p) {
  const explicit = Number(p?.toolDia);
  // No 20mm cap here, unlike the geometry-based guesses below: this is a
  // REAL registered tool the magazine actually selected (and already told
  // the operator about) — silently substituting a smaller one would leave
  // the exported G-code's cutter-compensation assuming a different
  // diameter than the tool the operator was told to load. Confirmed live:
  // a 32mm magazine tool got capped to 20mm here, while the chat message
  // still said "Ø32mm" — FreeCAD's own toolpath comment correctly showed
  // "DIAMETER: 20.0", i.e. it silently used the WRONG (smaller) tool.
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (type === "drill") return Math.min(20, Number(p.dia));
  if (type === "rectPocket") return Math.min(20, Math.max(1, Math.min(p.pw, p.pl) * 0.5));
  if (type === "circPocket") return Math.min(20, Math.max(1, Number(p.dia) * 0.4));
  if (type === "contour") return 10;
  return 6;
}

// ROOT CAUSE (confirmed by reading FreeCAD 1.1.3's actual source,
// src/Mod/CAM/Path/Op/Base.py + Path/Base/SetupSheet.py — this workbench is
// "CAM" now, "Path" is just its still-importable Python namespace): every
// new operation's setDefaultValues() calls
// applyExpression(obj, 'FinalDepth', job.SetupSheet.FinalDepthExpression),
// and SetupSheet.DefaultFinalDepthExpression is the literal string
// "OpFinalDepth" (same for StartDepth/OpStartDepth) — so StartDepth/FinalDepth
// come out of Create() already bound to a LIVE FreeCAD Expression, not a
// plain number. Assigning a plain value on top does not remove that binding;
// the next doc.recompute() just re-evaluates the expression and overwrites
// it again. And Base.py's updateDepths() (which onChanged() reruns on every
// Base/StartDepth/FinalDepth write) computes OpFinalDepth from the model's
// bounding box top when the op has no `.Base` (true for our Drilling and,
// after the profile face is Base'd, still true for the derived OpFinalDepth
// itself) — i.e. FinalDepth keeps getting pulled back to the stock's TOP
// surface, a zero-depth op: the tool visibly plunges to that height and
// retracts, but nothing is ever removed. A single reassert-after-recompute
// (previously tried here) cannot fix this because the expression reasserts
// itself on EVERY subsequent recompute, not just the first. The actual fix
// is FreeCAD's own idiom for this exact situation (used throughout
// Path/Base/SetupSheet.py): clear the bound expression with
// setExpression(prop, None) BEFORE assigning our literal value, so there is
// no live expression left to re-overwrite it on the next recompute.
function setDepthPy(varName, prop, value) {
  return [
    `${varName}.setExpression('${prop}', None)`,
    `${varName}.${prop} = ${value}`,
  ].join("\n");
}

// Kept as defense-in-depth: re-assert once more after a recompute, in case
// something else (not the expression above, now cleared) still nudges the
// value away from what we set.
function assertDepthPy(varName, sd, fd) {
  return [
    "doc.recompute()",
    `if abs(float(${varName}.StartDepth.Value) - ${sd}) > 1e-6 or abs(float(${varName}.FinalDepth.Value) - ${fd}) > 1e-6:`,
    `    ${varName}.setExpression('StartDepth', None)`,
    `    ${varName}.setExpression('FinalDepth', None)`,
    `    ${varName}.StartDepth = ${sd}`,
    `    ${varName}.FinalDepth = ${fd}`,
    "    doc.recompute()",
  ].join("\n");
}

function drillOpPy(index, p, stock) {
  const varName = `drill_${index}`;
  const toolVar = `tc_${index}`;
  const dia = toolDiameterFor("drill", p);
  const sd = pyFloat(stock.h);
  const fd = pyFloat(Number(stock.h) - Number(p.depth));
  return [
    `${toolVar}_tool_dia = ${pyFloat(dia)}`,
    `${varName} = PathDrilling.Create(${pyStr(`Drilling_${index}`)})`,
    `${varName}.Locations = [App.Vector(${pyFloat(p.x)}, ${pyFloat(p.y)}, 0.0)]`,
    setDepthPy(varName, "StartDepth", sd),
    setDepthPy(varName, "FinalDepth", fd),
    `${varName}.ToolController = tc`,
    assertDepthPy(varName, sd, fd),
  ].join("\n");
}

// Pocket profiles are built as a Part::Feature holding a real Part.Face
// (NOT a Sketcher::SketchObject) and referenced with an EXPLICIT "Face1"
// sub-element — verified against the real FreeCAD source
// (Path/Op/Pocket.py's areaOpShapes): `if obj.Base:` iterates
// `for sub in base[1]:` and does NOTHING when that sub-element list is
// empty (the earlier `Base = [(_sk, [])]` version silently found zero
// faces to remove — Sketches don't reliably expose `.Face1` either, and
// an empty sub-list isn't a "use the whole object" shorthand the way the
// job's own `Base` property's truthiness check might suggest). Every
// working reference pattern in this codebase (cam-code-system-prompt.txt)
// always passes real, named faces — never an empty list.
function rectFacePy(index, p, stock) {
  const feat = `_face_${index}`;
  const hw = pyFloat(Number(p.pw) / 2), hl = pyFloat(Number(p.pl) / 2);
  const cx = pyFloat(p.x), cy = pyFloat(p.y), z = pyFloat(stock.h);
  return [
    `_hw_${index}, _hl_${index}, _z_${index} = ${hw}, ${hl}, ${z}`,
    `_cx_${index}, _cy_${index} = ${cx}, ${cy}`,
    `_fp0_${index} = App.Vector(_cx_${index}-_hw_${index}, _cy_${index}-_hl_${index}, _z_${index})`,
    `_fp1_${index} = App.Vector(_cx_${index}+_hw_${index}, _cy_${index}-_hl_${index}, _z_${index})`,
    `_fp2_${index} = App.Vector(_cx_${index}+_hw_${index}, _cy_${index}+_hl_${index}, _z_${index})`,
    `_fp3_${index} = App.Vector(_cx_${index}-_hw_${index}, _cy_${index}+_hl_${index}, _z_${index})`,
    `_fwire_${index} = Part.makePolygon([_fp0_${index}, _fp1_${index}, _fp2_${index}, _fp3_${index}, _fp0_${index}])`,
    `${feat} = doc.addObject('Part::Feature', ${pyStr(`PocketProfile_${index}`)})`,
    `${feat}.Shape = Part.Face(_fwire_${index})`,
    "doc.recompute()",
  ].join("\n");
}

function circFacePy(index, p, stock) {
  const feat = `_face_${index}`;
  return [
    `_fcircle_${index} = Part.Circle(App.Vector(${pyFloat(p.x)}, ${pyFloat(p.y)}, ${pyFloat(stock.h)}), App.Vector(0, 0, 1), ${pyFloat(Number(p.dia) / 2)})`,
    `${feat} = doc.addObject('Part::Feature', ${pyStr(`PocketProfile_${index}`)})`,
    `${feat}.Shape = Part.Face(Part.Wire(_fcircle_${index}.toShape()))`,
    "doc.recompute()",
  ].join("\n");
}

function pocketOpPy(index, p, stock, facePy) {
  const varName = `pocket_${index}`;
  const depth = Number(p.depth);
  const stepDown = Math.min(depth, 3.0);
  const sd = pyFloat(stock.h);
  const fd = pyFloat(Number(stock.h) - depth);
  return [
    facePy,
    `${varName} = PathPocket.Create(${pyStr(`Pocket_${index}`)})`,
    `${varName}.Base = [(_face_${index}, ["Face1"])]`,
    setDepthPy(varName, "StartDepth", sd),
    setDepthPy(varName, "FinalDepth", fd),
    // StepDown defaults to a live expression too (SetupSheet's
    // DefaultStepDownExpression = "OpToolDiameter") - same class of bug as
    // StartDepth/FinalDepth above, so clear it before assigning our own
    // safe per-pass value.
    setDepthPy(varName, "StepDown", pyFloat(stepDown)),
    // PocketBase.py's own setDefaultValues() defaults ClearingPattern to
    // "Offset" (confirmed by reading FreeCAD 1.1.3's real source) — a pure
    // inward-ring pattern that stops once the next ring would collapse to
    // a degenerate size, which left a real square boss uncut in the exact
    // center of a live rectPocket test (the tool's own radius didn't reach
    // past the innermost ring). "ZigZagOffset" fixes that (offset pass for
    // clean straight walls + zigzag fill for the interior, reaching
    // dead-center regardless of tool-to-pocket ratio). A live test briefly
    // switched this to plain "ZigZag" over an apparent ~2mm wall gap, but
    // that gap was a misdiagnosis (from assuming the wrong tool diameter —
    // toolDiameterFor() actually auto-selects a tool sized so the
    // toolpath's own radius reaches exactly the true wall); plain "ZigZag"
    // has no dedicated wall-following pass at all, and a live rectPocket
    // test with it came out looking like a stepped octagon instead of a
    // rectangle (its 45-degree raster lines clipped against the square
    // boundary, with nothing to square off the corners afterward) — so
    // ZigZagOffset is correct and stays.
    `${varName}.ClearingPattern = 'ZigZagOffset'`,
    `${varName}.ToolController = tc`,
    assertDepthPy(varName, sd, fd),
  ].join("\n");
}

// Contour ("Kontur Kesme") cuts along the stock's OWN outer rectangular
// boundary — this MVP scope has no separate shape/position for it (see
// stockCamPlanService.js's "contour" registry entry: "footprint == stock/
// part outline"), matching its real-world use: trimming/separating the
// finished part from the raw stock along its true outer edge, after every
// other feature is already cut.
//
// Side='Inside' is a confirmed real Path.Op.Profile enum value (Path/Op/
// Profile.py) — it offsets the toolpath INWARD from the drawn boundary by
// the tool's own radius, so the cutting edge travels along the true edge
// itself. 'Outside' would offset outward into open space beyond the stock
// (nothing there to cut, since the boundary already IS the stock's edge),
// so it's deliberately not used here.
function contourOpPy(index, p, stock) {
  const varName = `contour_${index}`;
  const feat = `_cface_${index}`;
  const depth = Number(p.depth);
  const sd = pyFloat(stock.h);
  const fd = pyFloat(Number(stock.h) - depth);
  const hw = pyFloat(Number(stock.w) / 2), hl = pyFloat(Number(stock.d) / 2);
  return [
    `_chw_${index}, _chl_${index} = ${hw}, ${hl}`,
    `_cp0_${index} = App.Vector(-_chw_${index}, -_chl_${index}, ${sd})`,
    `_cp1_${index} = App.Vector(_chw_${index}, -_chl_${index}, ${sd})`,
    `_cp2_${index} = App.Vector(_chw_${index}, _chl_${index}, ${sd})`,
    `_cp3_${index} = App.Vector(-_chw_${index}, _chl_${index}, ${sd})`,
    `_cwire_${index} = Part.makePolygon([_cp0_${index}, _cp1_${index}, _cp2_${index}, _cp3_${index}, _cp0_${index}])`,
    `${feat} = doc.addObject('Part::Feature', ${pyStr(`ContourProfile_${index}`)})`,
    `${feat}.Shape = Part.Face(_cwire_${index})`,
    "doc.recompute()",
    `${varName} = PathProfile.Create(${pyStr(`Contour_${index}`)})`,
    `${varName}.Base = [(${feat}, ["Face1"])]`,
    `${varName}.Side = 'Inside'`,
    setDepthPy(varName, "StartDepth", sd),
    setDepthPy(varName, "FinalDepth", fd),
    setDepthPy(varName, "StepDown", pyFloat(Math.min(depth, 3.0))),
    `${varName}.ToolController = tc`,
    assertDepthPy(varName, sd, fd),
  ].join("\n");
}

// MVP scope (Faz 4 + Kontur follow-up): drill, rectPocket, circPocket,
// contour. hexPocket/slot/face/chamfer intentionally raise here rather
// than silently machine something wrong.
const SUPPORTED_TYPES = new Set(["drill", "rectPocket", "circPocket", "contour"]);

export function isStockGenerationSupported(type) {
  return SUPPORTED_TYPES.has(type);
}

function operationPy(index, op, stock) {
  if (!OPERATION_TYPES[op.type]) {
    throw new Error(`Bilinmeyen islem tipi: ${op.type}`);
  }
  if (!isStockGenerationSupported(op.type)) {
    throw new Error(
      `'${OPERATION_TYPES[op.type].label}' islemi henuz gercek Topkapi AI uretimini desteklemiyor ` +
      "(MVP kapsaminda sadece Delik Delme, Dikdortgen Cep, Daire Cep, Kontur Kesme var).",
    );
  }
  const p = op.params;
  if (op.type === "drill") return drillOpPy(index, p, stock);
  if (op.type === "rectPocket") return pocketOpPy(index, p, stock, rectFacePy(index, p, stock));
  if (op.type === "circPocket") return pocketOpPy(index, p, stock, circFacePy(index, p, stock));
  if (op.type === "contour") return contourOpPy(index, p, stock);
  throw new Error(`operationPy: eslesmeyen tip ${op.type}`); // unreachable given the guards above
}

// Builds the full, deterministic Python for a plan: stock + every confirmed
// operation IN ORDER, each with its own ToolController set explicitly (tool
// diameter varies per operation, so — unlike the STEP-file flow's usual
// single-tool case — every op here gets a fresh, explicitly-diametered
// ToolController; see cam-code-system-prompt.txt's own warning about never
// leaving an op's ToolController to implicit inheritance once there's more
// than one).
export function buildStockJobPy(plan) {
  const lines = [stockPy(plan.stock)];
  plan.operations.forEach((op, i) => {
    // Every operation gets its own ToolController sized to its own geometry
    // (see toolDiameterFor) rather than sharing the job's single default
    // `tc` — reusing one tool size across a 50mm pocket and an 8mm drill
    // would be geometrically wrong, not just suboptimal. operationPyWithOwnTool
    // creates that ToolController itself (tc_<i>) for every op after the
    // first, which reuses the job's own default `tc`.
    const dia = toolDiameterFor(op.type, op.params);
    lines.push(operationPyWithOwnTool(i, op, plan.stock, dia));
  });
  return lines.join("\n\n");
}

// Each operation gets its own ToolController (job.Proxy.addToolController)
// sized to its own geometry, built AFTER at least one operation already
// exists — see cam-code-system-prompt.txt's CRITICAL ORDERING RULE: adding
// a second ToolController before the job's first operation exists risks
// FreeCAD's interactive tool-picker (which disableInteractiveToolControllerPy
// neutralizes as a second line of defense, but avoiding it structurally is
// still the primary fix). The very first operation uses the job's default
// `tc`; every operation after that gets its own explicit ToolController.
function operationPyWithOwnTool(index, op, stock, toolDia) {
  if (index === 0) {
    // stockPy() gives the job's default `tc` a fixed placeholder diameter
    // (6mm) since it's built before any operation exists to size it from.
    // This was never corrected afterward, so operation 0 — whatever its own
    // geometry — always machined with that placeholder, not the diameter
    // toolDiameterFor() computes for it (a live 30x30mm pocket confirmed
    // this: its toolpath's outermost offset ring landed exactly where a
    // 6mm tool's radius compensation would put it, 3mm short of where a
    // properly-sized ~15mm tool's would). Set the real diameter on `tc`
    // BEFORE building the operation, so whatever FreeCAD derives from the
    // tool (OpToolDiameter, offset spacing, etc.) sees the right size from
    // the start rather than the placeholder.
    return [`tc.Tool.Diameter = ${pyFloat(toolDia)}`, operationPy(index, op, stock)].join("\n");
  }
  const body = operationPy(index, op, stock);
  const tcVar = `tc_${index}`;
  const setup = [
    `def _rover_make_endmill_tool(_diameter, _label):`,
    "    try:",
    "        from Path.Tool.toolbit import ToolBit",
    "        _t = ToolBit.from_shape_id('endmill.fcstd').attach_to_doc(doc=doc)",
    "        _t.Diameter = float(_diameter)",
    "        try:",
    "            _t.Label = _label",
    "        except Exception:",
    "            pass",
    "        return _t",
    "    except Exception:",
    "        _t = Path.Tool()",
    "        _t.Diameter = float(_diameter)",
    "        _t.ToolType = 'EndMill'",
    "        try:",
    "            _t.Name = _label",
    "        except Exception:",
    "            pass",
    "        return _t",
  ];
  const create = [
    `_endmill_${index} = _rover_make_endmill_tool(${pyFloat(toolDia)}, ${pyStr(`Tool_${index}`)})`,
    `${tcVar} = PathToolController.Create(${pyStr(`TC_${index}`)}, tool=_endmill_${index}, toolNumber=${index + 1})`,
    "job.Proxy.addToolController(" + tcVar + ")",
    `${tcVar}.HorizFeed = '600 mm/min'`,
    `${tcVar}.VertFeed = '150 mm/min'`,
    `${tcVar}.SpindleSpeed = 4000.0`,
    "doc.recompute()",
  ];
  // Rewrite the body's own ".ToolController = tc" to point at this op's own controller.
  const rewired = body.replace(/\.ToolController = tc$/m, `.ToolController = ${tcVar}`);
  return [...setup, ...create, rewired].join("\n");
}

const SUCCESS_PREVIEW = "PREVIEW_JSON=";
const SUCCESS_GCODE = "GCODE_PATH=";

function checkSafety(text) {
  const plungeViolations = parsePlungeViolations(text);
  const collisionViolations = parseCollisionViolations(text);
  if (!plungeViolations.length && !collisionViolations.length) return null;
  const parts = [];
  if (plungeViolations.length) {
    parts.push(
      "Tek pasoda asiri dalis: " +
      plungeViolations.map((v) => `${v.op}: Z${v.fromZ}->Z${v.toZ} (${v.delta}mm)`).join("; "),
    );
  }
  if (collisionViolations.length) {
    parts.push(
      "Hizli hareket carpismasi: " +
      collisionViolations.map((v) => `${v.op}: (${v.x}, ${v.y}, ${v.z})`).join("; "),
    );
  }
  return parts.join(" | ");
}

/**
 * Faz 4/5 shared entry point: build the WHOLE job fresh from `plan`'s
 * current operations list and run it through the exact same safety-checked
 * preview epilogue every other CAM flow in this codebase uses. No partial
 * rebuild, no patching — see module doc comment.
 * @returns {Promise<{ok:true, previewPath:string, estimatedMinutes:number} | {ok:false, error:string}>}
 */
export async function verifyStockPlan(plan) {
  if (!plan.operations.length) {
    return { ok: false, error: "Planda henuz onaylanmis islem yok." };
  }
  let bodyPy;
  try {
    bodyPy = buildStockJobPy(plan);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const previewJsonPath = path.join(os.tmpdir(), `rover_stock_preview_${plan.planKey}.json`);
  const epiloguePy = previewEpiloguePy(previewJsonPath, 500, false);
  try {
    const result = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]:
        disableInteractiveToolControllerPy() + "\n" + wrapWithTracebackPy(bodyPy) + "\n" + epiloguePy,
    });
    const text = extractResultText(result);
    if (result?.isError || !text.includes(SUCCESS_PREVIEW)) {
      return { ok: false, error: text || "Topkapi AI onizleme uretemedi." };
    }
    const safetyError = checkSafety(text);
    if (safetyError) {
      return { ok: false, error: `Guvenlik kontrolu basarisiz: ${safetyError}` };
    }
    const minutesMatch = text.match(/EST_MINUTES=([\d.]+)/);
    return {
      ok: true,
      previewPath: previewJsonPath,
      estimatedMinutes: minutesMatch ? Number(minutesMatch[1]) : null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Faz 7: final G-code export for the whole plan — same rebuild discipline,
 * same safety checks, this time through postEpiloguePy so a real .gcode
 * file comes out.
 * @returns {Promise<{ok:true, gcodePath:string} | {ok:false, error:string}>}
 */
export async function exportStockPlanGcode(plan, gcodePath, postName) {
  if (!plan.operations.length) {
    return { ok: false, error: "Planda henuz onaylanmis islem yok." };
  }
  let bodyPy;
  try {
    bodyPy = buildStockJobPy(plan);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const epiloguePy = postEpiloguePy(gcodePath, postName, false);
  try {
    const result = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]:
        disableInteractiveToolControllerPy() + "\n" + wrapWithTracebackPy(bodyPy) + "\n" + epiloguePy,
    });
    const text = extractResultText(result);
    if (result?.isError || !text.includes(SUCCESS_GCODE)) {
      return { ok: false, error: text || "G-code uretilemedi." };
    }
    const safetyError = checkSafety(text);
    if (safetyError) {
      return { ok: false, error: `Guvenlik kontrolu basarisiz: ${safetyError}` };
    }
    // The stock-cam flow shares postEpiloguePy/postModuleCandidates with the
    // STEP-file CAM Asistani flow: for controllers with no native FreeCAD
    // post (Siemens/Sinumerik, Heidenhain, Mitsubishi, Mazak, Okuma), what
    // just got exported is real Fanuc-dialect G-code, which still needs the
    // same dialect transform applied here that the other flow already runs
    // (applyControllerTransform) — skipping it, as this function previously
    // did, is what left the file in Fanuc/grbl form regardless of the
    // controller the operator actually picked.
    applyControllerTransform(gcodePath, postName, `rover_stock_${plan.planKey}`, {
      stockX: Number(plan.stock?.w) || 0,
      stockY: Number(plan.stock?.d) || 0,
      stockZ: Number(plan.stock?.h) || 0,
      wcs: "merkez alt yuzey",
    });
    prependStockHeaderComment(gcodePath, plan.stock);
    return { ok: true, gcodePath, warning: unsupportedControllerWarning(postName) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// A plain .gcode file carries no stock-size information — real CNC
// controllers don't need it (the operator loads the physical stock), but
// this simulator does, to draw and align the block the toolpath is meant to
// cut. The wizard's own "generate then auto-run" path already knows the
// right size (it just built the plan), but if the operator downloads the
// file and re-opens it later — exactly what surfaced this — the simulator
// only had the toolpath's own bounding box to guess from, which is smaller
// than and centered differently from the real stock, making the cut look
// wrong relative to the (mis-sized) block drawn on screen. Fixing this
// without inventing a nonstandard G-code dialect: prepend one ordinary
// parenthesized comment line, ignored by every real controller and by our
// own parser unless it specifically looks for it (see cnc-sim.html's
// parseRoverStockHeader), carrying the exact stock the operations were
// planned against.
export function prependStockHeaderComment(gcodePath, stock) {
  const header = `(ROVER_STOCK W${pyFloat(stock.w)} D${pyFloat(stock.d)} H${pyFloat(stock.h)})\n`;
  const existing = fs.readFileSync(gcodePath, "utf-8");
  fs.writeFileSync(gcodePath, header + existing, "utf-8");
}
