import fs from "node:fs";
import path from "node:path";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";
import { resolveStepPath } from "./camService.js";

const EXTRACT_DIMS_PY = (stepPath) =>
  [
    "import FreeCAD, Part, json, math",
    "if FreeCAD.ActiveDocument is not None:",
    "    try:",
    "        FreeCAD.closeDocument(FreeCAD.ActiveDocument.Name)",
    "    except Exception:",
    "        pass",
    'doc = FreeCAD.newDocument("DimExtract")',
    `Part.insert(${JSON.stringify(stepPath)}, doc.Name)`,
    'shape_objs = [o for o in doc.Objects if hasattr(o, "Shape") and o.Shape and not o.Shape.isNull()]',
    "if not shape_objs:",
    '    raise RuntimeError("No shapes found")',
    "",
    "compound = Part.makeCompound([o.Shape for o in shape_objs])",
    "bb = compound.BoundBox",
    "cx, cy, cz = bb.Center.x, bb.Center.y, bb.Center.z",
    "pad = max(bb.XLength, bb.YLength, bb.ZLength) * 0.15",
    "dims = []",
    "",
    "# Bounding box dimensions",
    "dims.append({",
    "    'id': 'width', 'label': 'Genislik', 'value': round(bb.XLength, 2),",
    "    'unit': 'mm', 'editable': True,",
    "    'p1': [round(bb.XMin, 2), round(bb.YMin - pad, 2), round(bb.ZMin, 2)],",
    "    'p2': [round(bb.XMax, 2), round(bb.YMin - pad, 2), round(bb.ZMin, 2)],",
    "    'ext1': [round(bb.XMin, 2), round(bb.YMin, 2), round(bb.ZMin, 2)],",
    "    'ext2': [round(bb.XMax, 2), round(bb.YMin, 2), round(bb.ZMin, 2)],",
    "})",
    "dims.append({",
    "    'id': 'depth', 'label': 'Derinlik', 'value': round(bb.YLength, 2),",
    "    'unit': 'mm', 'editable': True,",
    "    'p1': [round(bb.XMax + pad, 2), round(bb.YMin, 2), round(bb.ZMin, 2)],",
    "    'p2': [round(bb.XMax + pad, 2), round(bb.YMax, 2), round(bb.ZMin, 2)],",
    "    'ext1': [round(bb.XMax, 2), round(bb.YMin, 2), round(bb.ZMin, 2)],",
    "    'ext2': [round(bb.XMax, 2), round(bb.YMax, 2), round(bb.ZMin, 2)],",
    "})",
    "dims.append({",
    "    'id': 'height', 'label': 'Yukseklik', 'value': round(bb.ZLength, 2),",
    "    'unit': 'mm', 'editable': True,",
    "    'p1': [round(bb.XMin - pad, 2), round(bb.YMin, 2), round(bb.ZMin, 2)],",
    "    'p2': [round(bb.XMin - pad, 2), round(bb.YMin, 2), round(bb.ZMax, 2)],",
    "    'ext1': [round(bb.XMin, 2), round(bb.YMin, 2), round(bb.ZMin, 2)],",
    "    'ext2': [round(bb.XMin, 2), round(bb.YMin, 2), round(bb.ZMax, 2)],",
    "})",
    "",
    "# Cylinder analysis",
    "cylinders = {}",
    "for face in compound.Faces:",
    "    sn = face.Surface.__class__.__name__",
    "    if sn == 'Cylinder':",
    "        r = round(face.Surface.Radius, 2)",
    "        c = face.CenterOfMass",
    "        ax = face.Surface.Axis",
    "        cylinders.setdefault(r, []).append({",
    "            'center': [round(c.x, 2), round(c.y, 2), round(c.z, 2)],",
    "            'axis': [round(abs(ax.x), 4), round(abs(ax.y), 4), round(abs(ax.z), 4)],",
    "        })",
    "",
    "if cylinders:",
    "    max_r = max(cylinders.keys())",
    "    outer = cylinders[max_r]",
    "    if outer:",
    "        c = outer[0]['center']",
    "        ax = outer[0]['axis']",
    "        d = round(max_r * 2, 2)",
    "        if ax[2] > 0.9:",
    "            dims.append({",
    "                'id': 'outer_dia', 'label': 'Cap', 'value': d, 'symbol': 'dia',",
    "                'unit': 'mm', 'editable': True,",
    "                'p1': [round(c[0] - max_r, 2), c[1], c[2]],",
    "                'p2': [round(c[0] + max_r, 2), c[1], c[2]],",
    "            })",
    "        else:",
    "            dims.append({",
    "                'id': 'outer_dia', 'label': 'Cap', 'value': d, 'symbol': 'dia',",
    "                'unit': 'mm', 'editable': True,",
    "                'p1': [c[0], round(c[1] - max_r, 2), c[2]],",
    "                'p2': [c[0], round(c[1] + max_r, 2), c[2]],",
    "            })",
    "",
    "    seen = set()",
    "    for r in sorted(cylinders.keys()):",
    "        if abs(r - max_r) < 0.1:",
    "            continue",
    "        if r in seen:",
    "            continue",
    "        seen.add(r)",
    "        faces = cylinders[r]",
    "        d = round(r * 2, 2)",
    "        c = faces[0]['center']",
    "        ax = faces[0]['axis']",
    "        if ax[2] > 0.9:",
    "            p1 = [round(c[0] - r, 2), c[1], c[2]]",
    "            p2 = [round(c[0] + r, 2), c[1], c[2]]",
    "        else:",
    "            p1 = [c[0], round(c[1] - r, 2), c[2]]",
    "            p2 = [c[0], round(c[1] + r, 2), c[2]]",
    "        dims.append({",
    "            'id': f'hole_{d}', 'label': 'Delik', 'value': d, 'symbol': 'dia',",
    "            'unit': 'mm', 'editable': True, 'count': len(faces),",
    "            'p1': p1, 'p2': p2,",
    "        })",
    "",
    "result = {'dimensions': dims, 'center': [round(cx, 2), round(cy, 2), round(cz, 2)]}",
    "print('DIMS_JSON=' + json.dumps(result))",
    "try:",
    "    FreeCAD.closeDocument(doc.Name)",
    "except Exception:",
    "    pass",
  ].join("\n");

/**
 * Extract measurable dimensions from a STEP file for interactive 3D labels.
 * Returns bounding box dims, cylinder diameters, and hole sizes with 3D
 * anchor points for label placement.
 * @param {string} stepPath basename or path of a STEP file in the output dir
 * @returns {Promise<{dimensions: object[], center: number[]}>}
 */
export async function extractDimensions(stepPath) {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    throw new Error("STEP dosyasi bulunamadi: " + path.basename(abs));
  }
  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: EXTRACT_DIMS_PY(abs),
  });
  const text = extractResultText(result);
  const match = text.match(/DIMS_JSON=(.+)/);
  if (!match) {
    throw new Error("Olcu verisi alinamadi: " + text);
  }
  return JSON.parse(match[1]);
}
