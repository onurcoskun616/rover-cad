import fs from "node:fs";
import path from "node:path";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";

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

// Produce a compact geometry summary of a STEP file for the CAM assistant to
// reason about (it never sees the CAD itself). Includes the bounding box, per
// surface-type face counts, distinct cylinder radii, volume, area and the
// distinct horizontal (Z-normal) plane levels — a part with more than two levels
// (top + bottom) is stepped/multi-level, which the assistant uses to add a
// per-step machining question.
const DESCRIBE_CODE_TMPL = (stepPath) =>
  [
    stepInsertPy(stepPath, "RoverCAM_describe"),
    "import json",
    "bb = None",
    "faces = {}",
    "radii = []",
    "radiusCounts = {}",
    "levels = set()",
    "for o in shape_objs:",
    "    for f in o.Shape.Faces:",
    "        t = f.Surface.__class__.__name__",
    "        faces[t] = faces.get(t, 0) + 1",
    "        if t == 'Cylinder':",
    "            r = round(f.Surface.Radius, 2)",
    "            radii.append(r)",
    "            key = str(r)",
    "            radiusCounts[key] = radiusCounts.get(key, 0) + 1",
    "        elif t == 'Plane':",
    "            n = f.Surface.Axis",
    "            if abs(abs(n.z) - 1.0) < 1e-3:",
    "                levels.add(round(f.Surface.Position.z, 3))",
    "    b = o.Shape.BoundBox",
    "    if bb is None:",
    "        bb = FreeCAD.BoundBox(b)",
    "    else:",
    "        bb.add(b)",
    "vol = sum(o.Shape.Volume for o in shape_objs)",
    "area = sum(o.Shape.Area for o in shape_objs)",
    "summary = {",
    "    'boundingBoxMm': {'x': round(bb.XLength, 2), 'y': round(bb.YLength, 2), 'z': round(bb.ZLength, 2)},",
    "    'volumeMm3': round(vol, 2),",
    "    'surfaceAreaMm2': round(area, 2),",
    "    'faceCountsByType': faces,",
    "    'cylinderRadiiMm': sorted(set(radii)),",
    "    'cylinderRadiusCounts': radiusCounts,",
    "    'horizontalLevelsMm': sorted(levels),",
    "    'horizontalLevelCount': len(levels),",
    "    'solidCount': len(shape_objs),",
    "}",
    "print('GEOM_JSON=' + json.dumps(summary))",
    "try:",
    "    FreeCAD.closeDocument(doc.Name)",
    "except Exception:",
    "    pass",
  ].join("\n");

/**
 * @param {string} stepPath basename or path of a STEP file in the output dir
 * @returns {Promise<object>} geometry summary object (throws on failure)
 */
export async function describeStepGeometry(stepPath) {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    throw new Error("STEP dosyasi bulunamadi: " + path.basename(abs));
  }
  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: DESCRIBE_CODE_TMPL(abs),
  });
  const text = extractResultText(result);
  const match = text.match(/GEOM_JSON=(.+)/);
  if (!match) {
    throw new Error("Geometri ozeti alinamadi: " + text);
  }
  return JSON.parse(match[1]);
}
