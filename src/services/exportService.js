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

// The model is asked to emit a `# ROVER_DIMENSIONS: {"Cap": "30 mm", ...}` JSON
// comment describing the part's key dimensions. We can't draw real TechDraw
// dimension lines on arbitrary generated geometry (they need stable edge
// references we don't have), so instead we render this dict as a plain text
// table in the corner of the drawing. Returns [] if no valid comment is present.
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
  const scale = computeScale(bbox);
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

  if (dimLines.length) {
    const pyList = "[" + dimLines.map((l) => pyStr(l)).join(", ") + "]";
    lines.push(
      'ann = doc.addObject("TechDraw::DrawViewAnnotation", "DimTable")',
      "page.addView(ann)",
      `ann.Text = ${pyList}`,
      "ann.TextSize = 3.0",
      `ann.X = ${(PAGE_W - 45).toFixed(2)}`,
      `ann.Y = ${(PAGE_H - 25).toFixed(2)}`,
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
    const match = text.match(/PDF_PATH=(.+)/);
    if (result?.isError || !match) {
      return { pdfPath: null, error: text || "TechDraw PDF olusturulamadi" };
    }
    return { pdfPath: match[1].trim() };
  } catch (err) {
    return { pdfPath: null, error: err.message };
  }
}
