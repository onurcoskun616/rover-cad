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
    "    import Path.Op.Pocket as PathPocket",
    "    import Path.Op.Drilling as PathDrilling",
    "except Exception:",
    "    from PathScripts import PathJob, PathPocket, PathDrilling",
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
// simple convention CNC Simülatör's local taiRunMillWithTool already uses
// (proper magazine-based selection is a documented follow-up, not required
// to prove this pipeline safe/correct end to end).
function toolDiameterFor(type, p) {
  if (type === "drill") return Math.min(20, Number(p.dia));
  if (type === "rectPocket") return Math.min(20, Math.max(1, Math.min(p.pw, p.pl) * 0.5));
  if (type === "circPocket") return Math.min(20, Math.max(1, Number(p.dia) * 0.4));
  return 6;
}

function drillOpPy(index, p, stock) {
  const varName = `drill_${index}`;
  const toolVar = `tc_${index}`;
  const dia = toolDiameterFor("drill", p);
  return [
    `${toolVar}_tool_dia = ${pyFloat(dia)}`,
    `${varName} = PathDrilling.Create(${pyStr(`Drilling_${index}`)})`,
    `${varName}.Locations = [App.Vector(${pyFloat(p.x)}, ${pyFloat(p.y)}, 0.0)]`,
    `${varName}.StartDepth = ${pyFloat(stock.h)}`,
    `${varName}.FinalDepth = ${pyFloat(Number(stock.h) - Number(p.depth))}`,
    `${varName}.ToolController = tc`,
    "doc.recompute()",
  ].join("\n");
}

function rectSketchPy(index, p, stock) {
  const sk = `_sk_${index}`;
  const hw = pyFloat(Number(p.pw) / 2), hl = pyFloat(Number(p.pl) / 2);
  const cx = pyFloat(p.x), cy = pyFloat(p.y);
  return [
    `${sk} = doc.addObject('Sketcher::SketchObject', ${pyStr(`PocketSketch_${index}`)})`,
    `${sk}.Placement = App.Placement(App.Vector(0.0, 0.0, ${pyFloat(stock.h)}), App.Rotation(0, 0, 0, 1))`,
    `_hw_${index}, _hl_${index} = ${hw}, ${hl}`,
    `_cx_${index}, _cy_${index} = ${cx}, ${cy}`,
    `_p0_${index} = App.Vector(_cx_${index}-_hw_${index}, _cy_${index}-_hl_${index}, 0.0)`,
    `_p1_${index} = App.Vector(_cx_${index}+_hw_${index}, _cy_${index}-_hl_${index}, 0.0)`,
    `_p2_${index} = App.Vector(_cx_${index}+_hw_${index}, _cy_${index}+_hl_${index}, 0.0)`,
    `_p3_${index} = App.Vector(_cx_${index}-_hw_${index}, _cy_${index}+_hl_${index}, 0.0)`,
    `${sk}.addGeometry(Part.LineSegment(_p0_${index}, _p1_${index}), False)`,
    `${sk}.addGeometry(Part.LineSegment(_p1_${index}, _p2_${index}), False)`,
    `${sk}.addGeometry(Part.LineSegment(_p2_${index}, _p3_${index}), False)`,
    `${sk}.addGeometry(Part.LineSegment(_p3_${index}, _p0_${index}), False)`,
    "doc.recompute()",
  ].join("\n");
}

function circSketchPy(index, p, stock) {
  const sk = `_sk_${index}`;
  return [
    `${sk} = doc.addObject('Sketcher::SketchObject', ${pyStr(`PocketSketch_${index}`)})`,
    `${sk}.Placement = App.Placement(App.Vector(0.0, 0.0, ${pyFloat(stock.h)}), App.Rotation(0, 0, 0, 1))`,
    `${sk}.addGeometry(Part.Circle(App.Vector(${pyFloat(p.x)}, ${pyFloat(p.y)}, 0.0), App.Vector(0, 0, 1), ${pyFloat(Number(p.dia) / 2)}), False)`,
    "doc.recompute()",
  ].join("\n");
}

function pocketOpPy(index, p, stock, sketchPy) {
  const varName = `pocket_${index}`;
  const depth = Number(p.depth);
  const stepDown = Math.min(depth, 3.0);
  return [
    sketchPy,
    `${varName} = PathPocket.Create(${pyStr(`Pocket_${index}`)})`,
    `${varName}.Base = [(_sk_${index}, [])]`,
    `${varName}.StartDepth = ${pyFloat(stock.h)}`,
    `${varName}.FinalDepth = ${pyFloat(Number(stock.h) - depth)}`,
    `${varName}.StepDown = ${pyFloat(stepDown)}`,
    `${varName}.ToolController = tc`,
    "doc.recompute()",
  ].join("\n");
}

// MVP scope (Faz 4): drill, rectPocket, circPocket. hexPocket/slot/face/
// contour/chamfer intentionally raise here rather than silently machine
// something wrong — see task Faz 4 follow-up.
const SUPPORTED_TYPES = new Set(["drill", "rectPocket", "circPocket"]);

export function isStockGenerationSupported(type) {
  return SUPPORTED_TYPES.has(type);
}

function operationPy(index, op, stock) {
  if (!OPERATION_TYPES[op.type]) {
    throw new Error(`Bilinmeyen islem tipi: ${op.type}`);
  }
  if (!isStockGenerationSupported(op.type)) {
    throw new Error(
      `'${OPERATION_TYPES[op.type].label}' islemi henuz gercek FreeCAD uretimini desteklemiyor ` +
      "(MVP kapsaminda sadece Delik Delme, Dikdortgen Cep, Daire Cep var).",
    );
  }
  const p = op.params;
  if (op.type === "drill") return drillOpPy(index, p, stock);
  if (op.type === "rectPocket") return pocketOpPy(index, p, stock, rectSketchPy(index, p, stock));
  if (op.type === "circPocket") return pocketOpPy(index, p, stock, circSketchPy(index, p, stock));
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
  const body = operationPy(index, op, stock);
  if (index === 0) return body;
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
      return { ok: false, error: text || "FreeCAD onizleme uretemedi." };
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
    return { ok: true, gcodePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
