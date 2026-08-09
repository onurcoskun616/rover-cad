import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";
import { resolveStepPath } from "./camService.js";

// Only top-level solids matter for export/measure. A parametric Part::Cut keeps
// its Base/Tool operands in the document with a non-null .Shape (HANDOFF #8);
// including them would overlay the uncut base + cutter on the drawing and
// inflate the bounding box. An operand is always referenced by its parent
// feature's OutList, so we drop any object that appears as another object's
// child and keep only the results. This same filter is reused everywhere so
// export, bbox and TechDraw all agree on what "the model" is. Falls back to the
// unfiltered list if filtering would leave nothing (defensive).
const SHAPE_OBJS_PY = [
  "_children = set()",
  "for _o in doc.Objects:",
  "    for _c in _o.OutList:",
  "        _children.add(_c.Name)",
  'def _has_shape(o): return hasattr(o, "Shape") and o.Shape and not o.Shape.isNull()',
  "shape_objs = [o for o in doc.Objects if _has_shape(o) and o.Name not in _children]",
  "if not shape_objs:",
  "    shape_objs = [o for o in doc.Objects if _has_shape(o)]",
].join("\n");

// Fast path: reset the document, run the generated model code, export STEP+STL
// and read the bounding box — all in ONE FreeCAD round-trip instead of four. The
// generated Python is injected inline; it runs against the fresh document, then
// the export/measure epilogue picks up whatever solids it left behind. Collapsing
// the calls avoids re-parsing the document and re-deriving shape_objs three times
// and removes three MCP round-trips per attempt.
// Export + measure epilogue (shared by the generate and upload flows): pick the
// top-level solids in the active document, export STEP + a coarse preview STL,
// and print the paths and bounding box. Runs in the same round-trip as whatever
// produced the geometry.
function exportEpiloguePy(outputDir, stepPath, stlPath) {
  return [
    "import Part, Mesh, os",
    "doc = FreeCAD.ActiveDocument",
    "if doc is None:",
    '    raise RuntimeError("No active FreeCAD document found")',
    `os.makedirs(${JSON.stringify(outputDir)}, exist_ok=True)`,
    SHAPE_OBJS_PY,
    "if not shape_objs:",
    '    raise RuntimeError("No exportable solid produced")',
    `Part.export(shape_objs, ${JSON.stringify(stepPath)})`,
    "# Coarse, preview-quality tessellation: much faster to mesh and smaller to",
    "# download than FreeCAD's default. Falls back to Mesh.export if MeshPart is",
    "# unavailable.",
    "try:",
    "    import MeshPart",
    "    _mesh = Mesh.Mesh()",
    "    for _o in shape_objs:",
    "        _mesh.addMesh(MeshPart.meshFromShape(Shape=_o.Shape, LinearDeflection=0.5, AngularDeflection=0.6))",
    `    _mesh.write(${JSON.stringify(stlPath)})`,
    "except Exception:",
    `    Mesh.export(shape_objs, ${JSON.stringify(stlPath)})`,
    "bb = None",
    "for o in shape_objs:",
    "    b = o.Shape.BoundBox",
    "    if bb is None:",
    "        bb = FreeCAD.BoundBox(b)",
    "    else:",
    "        bb.add(b)",
    `print("STEP_PATH=" + ${JSON.stringify(stepPath)})`,
    `print("STL_PATH=" + ${JSON.stringify(stlPath)})`,
    'print("BBOX_X=" + str(bb.XLength))',
    'print("BBOX_Y=" + str(bb.YLength))',
    'print("BBOX_Z=" + str(bb.ZLength))',
    'print("BBOX_CX=" + str(bb.Center.x))',
    'print("BBOX_CY=" + str(bb.Center.y))',
    'print("BBOX_CZ=" + str(bb.Center.z))',
  ].join("\n");
}

function freshDocPy() {
  return [
    "import FreeCAD",
    "if FreeCAD.ActiveDocument is not None:",
    "    try:",
    "        FreeCAD.closeDocument(FreeCAD.ActiveDocument.Name)",
    "    except Exception:",
    "        pass",
    'FreeCAD.newDocument("RoverCAD")',
  ].join("\n");
}

function buildRunExportCode(outputDir, baseName, generatedCode) {
  const stepPath = path.join(outputDir, `${baseName}.step`);
  const stlPath = path.join(outputDir, `${baseName}.stl`);

  return [
    freshDocPy(),
    "",
    "# --- generated model code ---",
    generatedCode,
    "",
    "# --- export + measure epilogue (single round-trip) ---",
    exportEpiloguePy(outputDir, stepPath, stlPath),
  ].join("\n");
}

// Import an uploaded STEP/IGES file into a fresh document and run the same
// export epilogue, normalising it to a STEP + preview STL the rest of the
// pipeline (preview, CAM, TechDraw) understands. Part.insert dispatches by file
// extension, so it handles both STEP and IGES.
function buildImportExportCode(outputDir, baseName, uploadedPath) {
  const stepPath = path.join(outputDir, `${baseName}.step`);
  const stlPath = path.join(outputDir, `${baseName}.stl`);

  return [
    freshDocPy(),
    "import Part",
    `Part.insert(${JSON.stringify(uploadedPath)}, FreeCAD.ActiveDocument.Name)`,
    "",
    exportEpiloguePy(outputDir, stepPath, stlPath),
  ].join("\n");
}

// Import a DXF (2D). With a thickness > 0 the closed contours are extruded to a
// solid (STEP + STL, so it flows through the normal 3D CAM path). With no
// thickness the raw contours are kept as a wire compound (STEP for CAM's 2D
// Contour/Profile) plus a polyline JSON for the 2D preview.
function buildDxfImportCode(outputDir, baseName, uploadedPath, thickness) {
  const stepPath = path.join(outputDir, `${baseName}.step`);
  const stlPath = path.join(outputDir, `${baseName}.stl`);
  const contourPath = path.join(outputDir, `${baseName}_contour.json`);
  const t = Number(thickness) > 0 ? Number(thickness) : 0;

  return [
    freshDocPy(),
    "import Part, Mesh, os, json, FreeCAD",
    "import importDXF",
    "doc = FreeCAD.ActiveDocument",
    `os.makedirs(${JSON.stringify(outputDir)}, exist_ok=True)`,
    `importDXF.insert(${JSON.stringify(uploadedPath)}, doc.Name)`,
    "doc.recompute()",
    "edges = []",
    "for o in list(doc.Objects):",
    "    sh = getattr(o, 'Shape', None)",
    "    if sh is not None and not sh.isNull():",
    "        edges.extend(sh.Edges)",
    "if not edges:",
    "    raise RuntimeError('DXF icinde cizgi/kontur bulunamadi')",
    "try:",
    "    clusters = Part.sortEdges(edges)",
    "except Exception:",
    "    clusters = [[e] for e in edges]",
    "wires = []",
    "for cl in clusters:",
    "    try:",
    "        wires.append(Part.Wire(cl))",
    "    except Exception:",
    "        pass",
    `THK = ${t}`,
    "if THK > 0:",
    "    faces = []",
    "    for w in wires:",
    "        if w.isClosed():",
    "            try: faces.append(Part.Face(w))",
    "            except Exception: pass",
    "    if not faces:",
    "        raise RuntimeError('Kapali kontur bulunamadi; 3D icin kapali profil gerekir')",
    "    faces.sort(key=lambda f: f.Area, reverse=True)",
    "    result = faces[0].extrude(FreeCAD.Vector(0, 0, THK))",
    "    for hf in faces[1:]:",
    "        try: result = result.cut(hf.extrude(FreeCAD.Vector(0, 0, THK)))",
    "        except Exception: pass",
    "else:",
    "    result = Part.makeCompound(wires if wires else edges)",
    "for o in list(doc.Objects):",
    "    try: doc.removeObject(o.Name)",
    "    except Exception: pass",
    "obj = doc.addObject('Part::Feature', 'RoverDXF')",
    "obj.Shape = result",
    "doc.recompute()",
    `Part.export([obj], ${JSON.stringify(stepPath)})`,
    `print("STEP_PATH=" + ${JSON.stringify(stepPath)})`,
    "if THK > 0:",
    "    try:",
    "        import MeshPart",
    "        _m = Mesh.Mesh()",
    "        _m.addMesh(MeshPart.meshFromShape(Shape=result, LinearDeflection=0.5, AngularDeflection=0.6))",
    `        _m.write(${JSON.stringify(stlPath)})`,
    `        print("STL_PATH=" + ${JSON.stringify(stlPath)})`,
    "    except Exception as _e:",
    "        pass",
    "else:",
    "    _paths = []",
    "    for w in wires:",
    "        _pts = []",
    "        try:",
    "            for p in w.discretize(Distance=1.0):",
    "                _pts.append([round(p.x, 3), round(p.y, 3), round(p.z, 3), 0])",
    "        except Exception:",
    "            for e in w.Edges:",
    "                for p in e.discretize(Number=8):",
    "                    _pts.append([round(p.x, 3), round(p.y, 3), round(p.z, 3), 0])",
    "        if len(_pts) > 1:",
    "            _paths.append({'op': '2D Kontur', 'points': _pts})",
    `    with open(${JSON.stringify(contourPath)}, 'w') as _f:`,
    "        json.dump({'toolpaths': _paths}, _f)",
    `    print("CONTOUR_JSON=" + ${JSON.stringify(contourPath)})`,
    "bb = result.BoundBox",
    'print("BBOX_X=" + str(bb.XLength))',
    'print("BBOX_Y=" + str(bb.YLength))',
    'print("BBOX_Z=" + str(bb.ZLength))',
  ].join("\n");
}

/**
 * Run the generated code and export/measure in a single FreeCAD call.
 * @param {string} generatedCode FreeCAD Python for the model
 * @returns {Promise<{ok: boolean, error?: string, stepPath?: string,
 *   stlPath?: string, baseName?: string, bbox?: {x:number,y:number,z:number}}>}
 */
export async function runGeneratedCodeAndExport(generatedCode) {
  const baseName = `rover_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const code = buildRunExportCode(config.outputDir, baseName, generatedCode);

  // callFreecadTool throws on transport/timeout faults; let those propagate so
  // the pipeline can treat them as transient and retry.
  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: code,
  });
  const text = extractResultText(result);

  const stepMatch = text.match(/STEP_PATH=(.+)/);
  if (result?.isError || text.startsWith("Failed to execute code") || !stepMatch) {
    return { ok: false, error: text || "FreeCAD kodu calistiramadi" };
  }

  const stlMatch = text.match(/STL_PATH=(.+)/);
  const x = text.match(/BBOX_X=([-\d.eE+]+)/);
  const y = text.match(/BBOX_Y=([-\d.eE+]+)/);
  const z = text.match(/BBOX_Z=([-\d.eE+]+)/);
  const cx = text.match(/BBOX_CX=([-\d.eE+]+)/);
  const cy = text.match(/BBOX_CY=([-\d.eE+]+)/);
  const cz = text.match(/BBOX_CZ=([-\d.eE+]+)/);
  const anchorsMatch = text.match(/ROVER_ANCHORS_JSON=(.+)/);
  let anchors = null;
  if (anchorsMatch) {
    try { anchors = JSON.parse(anchorsMatch[1]); } catch { /* ignore */ }
  }

  return {
    ok: true,
    stepPath: stepMatch[1].trim(),
    stlPath: stlMatch ? stlMatch[1].trim() : null,
    baseName,
    bbox: {
      x: x ? Number(x[1]) : null,
      y: y ? Number(y[1]) : null,
      z: z ? Number(z[1]) : null,
    },
    center: cx && cy && cz
      ? [Number(cx[1]), Number(cy[1]), Number(cz[1])]
      : null,
    anchors,
  };
}

/**
 * Import an uploaded STEP/IGES file, normalise it to STEP + preview STL, and
 * read the bounding box — all in one FreeCAD round-trip. A corrupt or
 * unsupported file makes FreeCAD raise, which surfaces as ok:false + a message.
 * @param {string} uploadedPath absolute path of the uploaded CAD file
 * @returns {Promise<{ok: boolean, error?: string, stepPath?: string,
 *   stlPath?: string, baseName?: string, bbox?: {x:number,y:number,z:number}}>}
 */
export async function runImportAndExport(uploadedPath) {
  const baseName = `rover_upload_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const code = buildImportExportCode(config.outputDir, baseName, uploadedPath);

  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: code,
  });
  const text = extractResultText(result);

  const stepMatch = text.match(/STEP_PATH=(.+)/);
  if (result?.isError || text.startsWith("Failed to execute code") || !stepMatch) {
    return {
      ok: false,
      error:
        "CAD dosyasi FreeCAD'e aktarilamadi (bozuk ya da desteklenmeyen dosya olabilir): " +
        (text || "bilinmeyen hata"),
    };
  }

  const stlMatch = text.match(/STL_PATH=(.+)/);
  const x = text.match(/BBOX_X=([-\d.eE+]+)/);
  const y = text.match(/BBOX_Y=([-\d.eE+]+)/);
  const z = text.match(/BBOX_Z=([-\d.eE+]+)/);

  return {
    ok: true,
    stepPath: stepMatch[1].trim(),
    stlPath: stlMatch ? stlMatch[1].trim() : null,
    baseName,
    bbox: {
      x: x ? Number(x[1]) : null,
      y: y ? Number(y[1]) : null,
      z: z ? Number(z[1]) : null,
    },
  };
}

/**
 * Import a DXF (optionally extruding to a solid) and export it for the pipeline.
 * @param {string} uploadedPath absolute path of the uploaded .dxf
 * @param {number} thickness sheet thickness in mm; 0/blank => 2D contours only
 * @returns {Promise<{ok:boolean, error?:string, stepPath?:string, stlPath?:string,
 *   contourPath?:string, baseName?:string, twoD?:boolean, bbox?:object}>}
 */
export async function runImportDxfAndExport(uploadedPath, thickness = 0) {
  const baseName = `rover_dxf_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const code = buildDxfImportCode(config.outputDir, baseName, uploadedPath, thickness);

  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: code,
  });
  const text = extractResultText(result);

  const stepMatch = text.match(/STEP_PATH=(.+)/);
  if (result?.isError || text.startsWith("Failed to execute code") || !stepMatch) {
    return {
      ok: false,
      error:
        "DXF FreeCAD'e aktarilamadi (bozuk dosya, kapali kontur yoklugu veya desteklenmeyen icerik olabilir): " +
        (text || "bilinmeyen hata"),
    };
  }

  const stlMatch = text.match(/STL_PATH=(.+)/);
  const contourMatch = text.match(/CONTOUR_JSON=(.+)/);
  const x = text.match(/BBOX_X=([-\d.eE+]+)/);
  const y = text.match(/BBOX_Y=([-\d.eE+]+)/);
  const z = text.match(/BBOX_Z=([-\d.eE+]+)/);

  return {
    ok: true,
    stepPath: stepMatch[1].trim(),
    stlPath: stlMatch ? stlMatch[1].trim() : null,
    contourPath: contourMatch ? contourMatch[1].trim() : null,
    baseName,
    twoD: !(Number(thickness) > 0),
    bbox: {
      x: x ? Number(x[1]) : null,
      y: y ? Number(y[1]) : null,
      z: z ? Number(z[1]) : null,
    },
  };
}

// The model is asked to emit a `# ROVER_DIMENSIONS: {"Cap": "30 mm", ...}` JSON
// comment describing the part's key dimensions. The TechDraw PDF uses proper
// dimension lines (DistanceX/DistanceY/Diameter) placed via projected vertex
// enumeration, with a text-table fallback when vertex access fails.
// Returns [] if no valid comment is present.
export function parseRoverDimensions(code) {
  if (typeof code !== "string") return [];
  const match = code.match(/#\s*ROVER_DIMENSIONS:\s*(\{.*\})/);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[1]);
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj).map(([k, v]) => [String(k), String(v)]);
  } catch {
    return [];
  }
}

// Strip Turkish accented characters down to ASCII. FreeCAD's TechDraw vector
// text can mangle accented glyphs, so every label we bake into a drawing is
// forced to ASCII (HANDOFF #10).
function toAscii(str) {
  const map = {
    ç: "c", Ç: "C", ğ: "g", Ğ: "G", ı: "i", İ: "I",
    ö: "o", Ö: "O", ş: "s", Ş: "S", ü: "u", Ü: "U",
  };
  return String(str)
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => map[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

function pyStr(str) {
  return JSON.stringify(toAscii(str));
}

// A4 landscape usable drawing area (mm), leaving room for the title block.
const PAGE_W = 297;
const PAGE_H = 210;
const USABLE_W = 250;
const USABLE_H = 165;
const GAP_MM = 15; // spacing between the three views, in page (scaled) mm

// Pick a scale so the standard three-view arrangement fits the usable area.
// Front view spans X x Z, top view adds Y of depth above it, right view adds Y
// of depth beside it. Clamped to a sane range so tiny/huge parts stay legible.
function computeScale(bbox) {
  const x = Math.max(bbox.x || 1, 1);
  const y = Math.max(bbox.y || 1, 1);
  const z = Math.max(bbox.z || 1, 1);

  const neededW = x + y + GAP_MM;
  const neededH = z + y + GAP_MM;
  const raw = Math.min(USABLE_W / neededW, USABLE_H / neededH);

  // Round to a "nice" scale and clamp.
  const clamped = Math.min(Math.max(raw, 0.05), 10);
  return Number(clamped.toFixed(3));
}

function buildTechDrawCode(pdfPath, bbox, dimensions) {
  // Scale down 15% to leave room for dimension lines and arrows outside views.
  const scale = Number((computeScale(bbox) * 0.85).toFixed(3));
  const x = Math.max(bbox.x || 1, 1);
  const y = Math.max(bbox.y || 1, 1);
  const z = Math.max(bbox.z || 1, 1);

  // Centre the three-view block on the page. Positions below are the CENTRES of
  // each view in page mm; TechDraw positions views by their centre point.
  const blockW = (x + y + GAP_MM) * scale;
  const blockH = (z + y + GAP_MM) * scale;
  const originX = (PAGE_W - blockW) / 2;
  const originY = (PAGE_H - blockH) / 2;

  const frontX = originX + (x * scale) / 2;
  const frontY = originY + (z * scale) / 2;
  const topX = frontX;
  const topY = frontY + ((z + y) / 2 + GAP_MM) * scale;
  const rightX = frontX + ((x + y) / 2 + GAP_MM) * scale;
  const rightY = frontY;

  const dimLines = dimensions.length
    ? dimensions.map(([k, v]) => `${toAscii(k)}: ${toAscii(v)}`)
    : [];

  const lines = [
    "import FreeCAD, FreeCADGui, os",
    "doc = FreeCAD.ActiveDocument",
    "if doc is None:",
    '    raise RuntimeError("No active FreeCAD document found")',
    SHAPE_OBJS_PY,
    "if not shape_objs:",
    '    raise RuntimeError("No shapes found in active document to draw")',
    "",
    "# Find an A4 landscape template shipped with FreeCAD.",
    'tmpl_dir = os.path.join(FreeCAD.getResourceDir(), "Mod", "TechDraw", "Templates")',
    "template = None",
    "if os.path.isdir(tmpl_dir):",
    "    cands = [f for f in os.listdir(tmpl_dir) if f.lower().endswith('.svg')]",
    "    land = [f for f in cands if 'landscape' in f.lower() and 'a4' in f.lower()]",
    "    pick = land or [f for f in cands if 'a4' in f.lower()] or cands",
    "    if pick:",
    "        template = os.path.join(tmpl_dir, sorted(pick)[0])",
    "",
    'page = doc.addObject("TechDraw::DrawPage", "RoverPage")',
    'tobj = doc.addObject("TechDraw::DrawSVGTemplate", "RoverTemplate")',
    "if template:",
    "    tobj.Template = template",
    "page.Template = tobj",
    "",
    "base = shape_objs[0]",
    "",
    "def make_view(name, direction, xdir, sx, sy):",
    '    v = doc.addObject("TechDraw::DrawViewPart", name)',
    "    page.addView(v)",
    "    v.Source = shape_objs",
    "    v.Direction = FreeCAD.Vector(*direction)",
    "    v.XDirection = FreeCAD.Vector(*xdir)",
    `    v.Scale = ${scale}`,
    "    v.ScaleType = 'Custom'",
    "    # Position must be set AFTER addView(), otherwise it is overwritten.",
    "    v.X = sx",
    "    v.Y = sy",
    "    return v",
    "",
    `front = make_view("FrontView", (0, -1, 0), (1, 0, 0), ${frontX.toFixed(2)}, ${frontY.toFixed(2)})`,
    `top = make_view("TopView", (0, 0, 1), (1, 0, 0), ${topX.toFixed(2)}, ${topY.toFixed(2)})`,
    `right = make_view("RightView", (1, 0, 0), (0, 1, 0), ${rightX.toFixed(2)}, ${rightY.toFixed(2)})`,
    "",
  ];

  // Recompute to project geometry, then create proper dimension lines.
  lines.push(
    "doc.recompute()",
    "import time",
    "time.sleep(2)",
    "doc.recompute()",
    "",
    "def get_view_vertices(view):",
    "    verts = []",
    "    for i in range(500):",
    "        try:",
    "            v = view.getVertexByIndex(i)",
    "            verts.append((i, v.X, v.Y))",
    "        except Exception:",
    "            break",
    "    return verts",
    "",
    "def get_circular_edges(view):",
    "    circles = []",
    "    for i in range(500):",
    "        try:",
    "            e = view.getEdgeByIndex(i)",
    "            if hasattr(e, 'Curve') and hasattr(e.Curve, 'Radius'):",
    "                circles.append((i, e.Curve.Radius))",
    "        except Exception:",
    "            break",
    "    return circles",
    "",
    "dim_ok = False",
    "try:",
    '    print("DIM_DEBUG: starting dimension creation")',
    "    fverts = get_view_vertices(front)",
    '    print("DIM_DEBUG: front vertices = " + str(len(fverts)))',
    "    if len(fverts) >= 2:",
    "        by_x = sorted(fverts, key=lambda v: v[1])",
    "        by_y = sorted(fverts, key=lambda v: v[2])",
    "        x_span = by_x[-1][1] - by_x[0][1]",
    "        y_span = by_y[-1][2] - by_y[0][2]",
    '        print("DIM_DEBUG: x_span=" + str(round(x_span,2)) + " y_span=" + str(round(y_span,2)))',
    "        if x_span > 0.1:",
    '            d = doc.addObject("TechDraw::DrawViewDimension", "DimW")',
    "            page.addView(d)",
    '            d.Type = "DistanceX"',
    "            d.References2D = [(front, 'Vertex' + str(by_x[0][0])), (front, 'Vertex' + str(by_x[-1][0]))]",
    '            d.FormatSpec = "%.2f"',
    "            doc.recompute()",
    "            dim_ok = True",
    '            print("DIM_DEBUG: width dim OK")',
    "        if y_span > 0.1:",
    '            d = doc.addObject("TechDraw::DrawViewDimension", "DimH")',
    "            page.addView(d)",
    '            d.Type = "DistanceY"',
    "            d.References2D = [(front, 'Vertex' + str(by_y[0][0])), (front, 'Vertex' + str(by_y[-1][0]))]",
    '            d.FormatSpec = "%.2f"',
    "            doc.recompute()",
    "            dim_ok = True",
    '            print("DIM_DEBUG: height dim OK")',
    "",
    "    tverts = get_view_vertices(top)",
    '    print("DIM_DEBUG: top vertices = " + str(len(tverts)))',
    "    if len(tverts) >= 2:",
    "        by_y = sorted(tverts, key=lambda v: v[2])",
    "        y_span = by_y[-1][2] - by_y[0][2]",
    "        if y_span > 0.1:",
    '            d = doc.addObject("TechDraw::DrawViewDimension", "DimD")',
    "            page.addView(d)",
    '            d.Type = "DistanceY"',
    "            d.References2D = [(top, 'Vertex' + str(by_y[0][0])), (top, 'Vertex' + str(by_y[-1][0]))]",
    '            d.FormatSpec = "%.2f"',
    "            doc.recompute()",
    "            dim_ok = True",
    '            print("DIM_DEBUG: depth dim OK")',
    "",
    "    circles = get_circular_edges(front)",
    '    print("DIM_DEBUG: circular edges = " + str(len(circles)))',
    "    seen = set()",
    "    ci = 0",
    "    for edge_idx, radius in circles:",
    "        rk = round(radius, 1)",
    "        if rk in seen or ci >= 3:",
    "            continue",
    "        seen.add(rk)",
    '        d = doc.addObject("TechDraw::DrawViewDimension", "DimDia" + str(ci))',
    "        page.addView(d)",
    '        d.Type = "Diameter"',
    "        d.References2D = [(front, 'Edge' + str(edge_idx))]",
    '        d.FormatSpec = "%.2f"',
    "        doc.recompute()",
    "        dim_ok = True",
    "        ci += 1",
    "",
    "except Exception as dim_err:",
    '    print("DIM_WARN: " + str(dim_err))',
    "    import traceback",
    "    traceback.print_exc()",
    "",
    'print("DIM_DEBUG: dim_ok=" + str(dim_ok))',
    "",
  );

  // Fallback: text annotation if dimension lines could not be created.
  if (dimLines.length) {
    const pyList = "[" + dimLines.map((l) => pyStr(l)).join(", ") + "]";
    lines.push(
      "if not dim_ok:",
      '    print("DIM_DEBUG: falling back to text annotation")',
      '    ann = doc.addObject("TechDraw::DrawViewAnnotation", "DimTable")',
      "    page.addView(ann)",
      `    ann.Text = ${pyList}`,
      "    ann.TextSize = 3.0",
      `    ann.X = ${(PAGE_W - 45).toFixed(2)}`,
      `    ann.Y = ${(PAGE_H - 25).toFixed(2)}`,
      "",
    );
  }

  lines.push(
    "doc.recompute()",
    "# Force the views to actually render, or the exported PDF comes out blank.",
    "try:",
    "    page.ViewObject.doubleClicked()",
    "except Exception:",
    "    pass",
    "FreeCADGui.updateGui()",
    "doc.recompute()",
    "",
    "import TechDrawGui",
    `TechDrawGui.exportPageAsPdf(page, ${JSON.stringify(pdfPath)})`,
    `print("PDF_PATH=" + ${JSON.stringify(pdfPath)})`,
  );

  return lines.join("\n");
}

// On-demand PDF: re-import a previously exported STEP into a fresh document and
// render the 3-view drawing from it. This keeps the (slow) TechDraw work off the
// /generate hot path — the model returns immediately and the PDF is produced only
// when the user actually asks for it. `bbox` (from the /generate response) drives
// the view scale; `dimensions` is the parsed ROVER_DIMENSIONS table.
export async function exportTechDrawPdfFromStep(stepPath, bbox, dimensions = []) {
  const abs = resolveStepPath(stepPath);
  if (!fs.existsSync(abs)) {
    return { pdfPath: null, error: "STEP dosyasi bulunamadi" };
  }
  const baseName = path.basename(abs).replace(/\.(step|stp)$/i, "");
  const pdfPath = path.join(config.outputDir, `${baseName}.pdf`);

  const importPy = [
    "import FreeCAD, Part",
    "if FreeCAD.ActiveDocument is not None:",
    "    try:",
    "        FreeCAD.closeDocument(FreeCAD.ActiveDocument.Name)",
    "    except Exception:",
    "        pass",
    'doc = FreeCAD.newDocument("RoverPDF")',
    `Part.insert(${JSON.stringify(abs)}, doc.Name)`,
    "",
  ].join("\n");

  const code = importPy + buildTechDrawCode(pdfPath, bbox ?? {}, dimensions);

  try {
    const result = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]: code,
    });
    const text = extractResultText(result);
    const dimDebug = text.split("\n").filter(l => l.startsWith("DIM_")).join(" | ");
    if (dimDebug) console.log("[TechDraw]", dimDebug);
    const match = text.match(/PDF_PATH=(.+)/);
    if (result?.isError || !match) {
      return { pdfPath: null, error: text || "TechDraw PDF olusturulamadi" };
    }
    return { pdfPath: match[1].trim() };
  } catch (err) {
    return { pdfPath: null, error: err.message };
  }
}
