import fs from "node:fs";
import path from "node:path";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";

// Fixed machining parameters. These are conservative aluminium settings for a
// 6mm flat endmill; exposing them to the user is a future step (HANDOFF #10).
const TOOL_DIAMETER_MM = 6;
const SPINDLE_RPM = 10000;
// IMPORTANT: FreeCAD ToolController feeds are App::PropertySpeed. A bare number
// is interpreted as mm/SECOND, so 500 would be dangerously fast. Always pass a
// unit-tagged string (HANDOFF #7).
const HORIZ_FEED = "500 mm/min";
const VERT_FEED = "120 mm/min";

// Resolve a caller-supplied step name to an absolute path locked inside the
// output directory (defends against path traversal, HANDOFF §4).
export function resolveStepPath(stepPath) {
  const name = path.basename(String(stepPath || ""));
  return path.join(config.outputDir, name);
}

function stepInsertPy(stepPath, docName) {
  return [
    "import FreeCAD, Part, os",
    `_p = ${JSON.stringify(stepPath)}`,
    "if not os.path.isfile(_p):",
    '    raise RuntimeError("STEP file not found: " + _p)',
    "if FreeCAD.ActiveDocument is not None:",
    "    try:",
    "        FreeCAD.closeDocument(FreeCAD.ActiveDocument.Name)",
    "    except Exception:",
    "        pass",
    `doc = FreeCAD.newDocument(${JSON.stringify(docName)})`,
    "Part.insert(_p, doc.Name)",
    'shape_objs = [o for o in doc.Objects if hasattr(o, "Shape") and o.Shape and not o.Shape.isNull()]',
    "if not shape_objs:",
    '    raise RuntimeError("No shapes found in imported STEP")',
  ].join("\n");
}

// Analyse the geometry of a STEP file. A part is "simple" (2.5D millable) only
// if every face is either planar or a cylinder whose axis is vertical (parallel
// to Z) — i.e. drillable holes / vertical walls. Spheres, cones, tilted
// cylinders, tori and free-form (B-spline) faces make it "complex".
const ANALYZE_CODE_TMPL = (stepPath) =>
  [
    stepInsertPy(stepPath, "RoverCAM_analyze"),
    "simple = True",
    'reason = ""',
    "for o in shape_objs:",
    "    for f in o.Shape.Faces:",
    "        t = f.Surface.__class__.__name__",
    "        if t == 'Plane':",
    "            continue",
    "        elif t == 'Cylinder':",
    "            ax = f.Surface.Axis",
    "            if abs(abs(ax.z) - 1.0) > 1e-3:",
    "                simple = False; reason = 'egik silindir'; break",
    "        else:",
    "            simple = False; reason = t; break",
    "    if not simple:",
    "        break",
    "print('CAM_SIMPLE=' + ('1' if simple else '0'))",
    "print('CAM_REASON=' + reason)",
    "try:",
    "    FreeCAD.closeDocument(doc.Name)",
    "except Exception:",
    "    pass",
  ].join("\n");

/**
 * @param {string} stepPath basename or path of a STEP file in the output dir
 * @returns {Promise<{simple: boolean, reason: string}>}
 */
export async function analyzeStepGeometry(stepPath) {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    return { simple: false, reason: "STEP dosyasi bulunamadi" };
  }
  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: ANALYZE_CODE_TMPL(abs),
  });
  const text = extractResultText(result);
  const simpleMatch = text.match(/CAM_SIMPLE=([01])/);
  const reasonMatch = text.match(/CAM_REASON=(.*)/);
  if (!simpleMatch) {
    return { simple: false, reason: "Geometri analizi basarisiz: " + text };
  }
  return {
    simple: simpleMatch[1] === "1",
    reason: reasonMatch ? reasonMatch[1].trim() : "",
  };
}

function gcodeGenPy(stepPath, gcodePath) {
  return [
    stepInsertPy(stepPath, "RoverCAM"),
    "base = shape_objs[0]",
    "",
    "# --- Import the CAM (Path) API. Module layout differs across FreeCAD",
    "# versions, so try the 1.0/1.1 layout first, then the legacy PathScripts.",
    "import Path",
    "try:",
    "    from Path.Main import Job as PathJob",
    "    import Path.Op.Profile as PathProfile",
    "    import Path.Op.Drilling as PathDrilling",
    "    _api = 'new'",
    "except Exception:",
    "    from PathScripts import PathJob",
    "    from PathScripts import PathProfile",
    "    from PathScripts import PathDrilling",
    "    _api = 'old'",
    "",
    "job = PathJob.Create('RoverJob', [base], None)",
    "doc.recompute()",
    "",
    "# The default job ships with one tool controller; reuse it as our 6mm",
    "# flat endmill and set safe aluminium feeds/speeds.",
    "tcs = list(getattr(job, 'Tools').Group) if hasattr(job, 'Tools') else []",
    "if not tcs and hasattr(job, 'ToolController'):",
    "    tcs = list(job.ToolController)",
    "if not tcs:",
    "    raise RuntimeError('Job has no tool controller to configure')",
    "tc = tcs[0]",
    `tc.HorizFeed = ${JSON.stringify(HORIZ_FEED)}`,
    `tc.VertFeed = ${JSON.stringify(VERT_FEED)}`,
    `tc.SpindleSpeed = float(${SPINDLE_RPM})`,
    "try:",
    `    tc.Tool.Diameter = '${TOOL_DIAMETER_MM} mm'`,
    "except Exception:",
    "    pass",
    "",
    "ops = []",
    "# Outer profile (contour). Do NOT process holes here — holes are drilled.",
    "prof = PathProfile.Create('Profile')",
    "prof.ToolController = tc",
    "try:",
    "    prof.processHoles = False",
    "    prof.processPerimeter = True",
    "    prof.Side = 'Outside'",
    "except Exception:",
    "    pass",
    "ops.append(prof)",
    "",
    "# Drilling for vertical cylindrical holes, if any exist.",
    "try:",
    "    drl = PathDrilling.Create('Drilling')",
    "    drl.ToolController = tc",
    "    ops.append(drl)",
    "except Exception:",
    "    pass",
    "",
    "doc.recompute()",
    "",
    "# Post-process to GRBL G-code. NEVER pass '--help' to a post processor:",
    "# argparse calls sys.exit and kills FreeCAD (HANDOFF #6).",
    "try:",
    "    from Path.Post.scripts import grbl_post",
    "except Exception:",
    "    from PathScripts.post import grbl_post",
    "",
    "postlist = []",
    "if hasattr(job, 'Operations') and hasattr(job.Operations, 'Group'):",
    "    postlist = list(job.Operations.Group)",
    "if not postlist:",
    "    postlist = ops",
    "",
    `_out = ${JSON.stringify(gcodePath)}`,
    "grbl_post.export(postlist, _out, '--no-show-editor')",
    "print('GCODE_PATH=' + _out)",
    "try:",
    "    FreeCAD.closeDocument(doc.Name)",
    "except Exception:",
    "    pass",
  ].join("\n");
}

/**
 * Generate GRBL G-code for a simple part. Analyses first; complex parts are
 * refused with a friendly message instead of producing bad toolpaths.
 * @param {string} stepPath basename or path of a STEP file in the output dir
 * @returns {Promise<{complex: boolean, message?: string, gcodePath?: string}>}
 */
export async function generateGcode(stepPath) {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    throw new Error("STEP dosyasi bulunamadi: " + path.basename(abs));
  }

  const analysis = await analyzeStepGeometry(abs);
  if (!analysis.simple) {
    return {
      complex: true,
      message: "Bu parca karmasik, CAM asistani yakinda eklenecek.",
    };
  }

  const gcodePath = abs.replace(/\.(step|stp)$/i, "") + ".gcode";
  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: gcodeGenPy(abs, gcodePath),
  });
  const text = extractResultText(result);
  const match = text.match(/GCODE_PATH=(.+)/);
  if (result?.isError || !match) {
    throw new Error("G-code uretilemedi: " + (text || "bilinmeyen hata"));
  }
  return { complex: false, gcodePath: match[1].trim() };
}
