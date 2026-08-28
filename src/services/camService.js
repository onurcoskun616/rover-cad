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

// Üretilebilirlik Analizi (DFM) V1 -- two checks a round milling tool's own
// geometry genuinely limits, both computed directly from real B-Rep face
// data (never a guess):
//
// 1) Derin/dar delikler: every Cylinder face is either a real hole/boss (its
//    ParameterRange spans close to a full 2*pi revolution) or a small fillet
//    blend along an edge (spans a much smaller angle) -- OCCT represents a
//    fillet as literally a partial cylindrical surface, so this angular
//    split is exact, not heuristic. For a real hole/boss, depth is the
//    face's own bounding-box extent projected onto the cylinder's axis
//    (correct for ANY axis orientation, not just X/Y/Z-aligned holes,
//    since it's a true projection of the face's own corners onto that
//    direction). Depth-to-diameter > 5 is a widely-used real shop-floor
//    threshold for standard twist-drill reach before deflection/chip
//    evacuation becomes a real risk (this is the same L/D>5 threshold
//    PartGo's own "Delikler" check surfaces).
// 2) Kucuk ic kose radusu: the OTHER half of that same cylinder split --
//    fillet-blend faces (partial angle) with a radius below
//    MIN_CORNER_RADIUS_MM. A genuinely SHARP (radius 0, unfilleted)
//    internal corner has no cylindrical face at all to inspect (it's just
//    two planar faces meeting at a line) and is completely normal in a
//    milled pocket's design intent -- only an ALREADY-filleted corner
//    that's too small for a standard end mill to reproduce is flagged.
//
// Deliberately NOT attempted here (a real accessibility/visibility
// computation, not just B-Rep face inspection): whether a feature is
// reachable at all from a single tool-approach direction ("Ters Aci ve
// Capraz Eksenler" / undercuts) -- left for a future round.
const MIN_CORNER_RADIUS_MM = 0.5; // common minimum end-mill corner radius
const DEEP_HOLE_RATIO = 5; // depth/diameter -- standard twist-drill L/D guideline

const DFM_CODE_TMPL = (stepPath) =>
  [
    stepInsertPy(stepPath, "RoverDFM_analyze"),
    "import json, math",
    "holes = []",
    "fillets = []",
    "for o in shape_objs:",
    "    for f in o.Shape.Faces:",
    "        if f.Surface.__class__.__name__ != 'Cylinder':",
    "            continue",
    "        radius = f.Surface.Radius",
    "        if radius <= 0:",
    "            continue",
    "        try:",
    "            u0, u1, v0, v1 = f.ParameterRange",
    "        except Exception:",
    "            continue",
    "        angular_extent = abs(u1 - u0)",
    "        axis = f.Surface.Axis",
    "        bb = f.BoundBox",
    "        corners = [",
    "            FreeCAD.Vector(bb.XMin, bb.YMin, bb.ZMin), FreeCAD.Vector(bb.XMax, bb.YMin, bb.ZMin),",
    "            FreeCAD.Vector(bb.XMin, bb.YMax, bb.ZMin), FreeCAD.Vector(bb.XMin, bb.YMin, bb.ZMax),",
    "            FreeCAD.Vector(bb.XMax, bb.YMax, bb.ZMin), FreeCAD.Vector(bb.XMax, bb.YMin, bb.ZMax),",
    "            FreeCAD.Vector(bb.XMin, bb.YMax, bb.ZMax), FreeCAD.Vector(bb.XMax, bb.YMax, bb.ZMax),",
    "        ]",
    "        projections = [c.dot(axis) for c in corners]",
    "        depth = max(projections) - min(projections)",
    "        if angular_extent > (2 * math.pi - 0.1):",
    "            holes.append({'radiusMm': round(radius, 2), 'depthMm': round(depth, 2)})",
    "        else:",
    "            fillets.append({'radiusMm': round(radius, 2)})",
    `deep_holes = [h for h in holes if (h['depthMm'] / (2 * h['radiusMm'])) > ${DEEP_HOLE_RATIO}]`,
    `small_corners = [c for c in fillets if c['radiusMm'] < ${MIN_CORNER_RADIUS_MM}]`,
    "checks = [",
    "    {",
    "        'key': 'deepHoles',",
    "        'label': 'Delikler (Derin Delik Orani)',",
    "        'ok': len(deep_holes) == 0,",
    "        'detail': ('Hata tespit edilmedi.' if not deep_holes else",
    "                   str(len(deep_holes)) + ' delik capinin 5 katindan derin (L/D>5) -- takim sapmasi/talas tahliyesi riski tasir.'),",
    "    },",
    "    {",
    "        'key': 'smallCorners',",
    "        'label': 'Ic Koseler (Kose Radusu)',",
    "        'ok': len(small_corners) == 0,",
    `        'detail': ('Hata tespit edilmedi.' if not small_corners else str(len(small_corners)) + ' ic kose ${MIN_CORNER_RADIUS_MM}mm den kucuk radusle modellenmis -- standart bir freze ile ulasilamayabilir.'),`,
    "    },",
    "]",
    "passed = sum(1 for c in checks if c['ok'])",
    "score = round(100 * passed / len(checks))",
    "result = {'score': score, 'checks': checks, 'holeCount': len(holes), 'filletCount': len(fillets)}",
    "print('DFM_JSON=' + json.dumps(result))",
    "try:",
    "    FreeCAD.closeDocument(doc.Name)",
    "except Exception:",
    "    pass",
  ].join("\n");

/**
 * @param {string} stepPath basename or path of a STEP file in the output dir
 * @returns {Promise<{score:number, checks:Array, holeCount:number, filletCount:number}>}
 */
export async function analyzeManufacturability(stepPath) {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    throw new Error("STEP dosyasi bulunamadi: " + path.basename(abs));
  }
  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: DFM_CODE_TMPL(abs),
  });
  const text = extractResultText(result);
  const match = text.match(/DFM_JSON=(.+)/);
  if (!match) {
    throw new Error("Uretilebilirlik analizi alinamadi: " + text);
  }
  return JSON.parse(match[1]);
}
