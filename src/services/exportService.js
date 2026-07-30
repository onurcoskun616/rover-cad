import path from "node:path";
import { randomUUID } from "node:crypto";
import { callFreecadTool, extractResultText } from "./freecadMcpClient.js";
import { config } from "../config.js";

function buildExportCode(outputDir, baseName) {
  const stepPath = path.join(outputDir, `${baseName}.step`);
  const stlPath = path.join(outputDir, `${baseName}.stl`);

  return [
    "import FreeCAD, Part, Mesh, os",
    "",
    "doc = FreeCAD.ActiveDocument",
    "if doc is None:",
    '    raise RuntimeError("No active FreeCAD document found")',
    "",
    `os.makedirs(${JSON.stringify(outputDir)}, exist_ok=True)`,
    "",
    'shape_objs = [o for o in doc.Objects if hasattr(o, "Shape") and o.Shape and not o.Shape.isNull()]',
    "if not shape_objs:",
    '    raise RuntimeError("No shapes found in active document to export")',
    "",
    `Part.export(shape_objs, ${JSON.stringify(stepPath)})`,
    `Mesh.export(shape_objs, ${JSON.stringify(stlPath)})`,
    "",
    `print("STEP_PATH=" + ${JSON.stringify(stepPath)})`,
    `print("STL_PATH=" + ${JSON.stringify(stlPath)})`,
  ].join("\n");
}

const RESET_DOCUMENT_CODE = [
  "import FreeCAD",
  "if FreeCAD.ActiveDocument is not None:",
  "    FreeCAD.closeDocument(FreeCAD.ActiveDocument.Name)",
  'FreeCAD.newDocument("RoverCAD")',
].join("\n");

export async function resetActiveDocument() {
  return callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: RESET_DOCUMENT_CODE,
  });
}

export async function exportActiveDocument() {
  const baseName = `rover_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const code = buildExportCode(config.outputDir, baseName);

  const result = await callFreecadTool(config.freecadMcp.toolName, {
    [config.freecadMcp.toolParam]: code,
  });

  const text = extractResultText(result);
  const stepMatch = text.match(/STEP_PATH=(.+)/);
  const stlMatch = text.match(/STL_PATH=(.+)/);

  return {
    stepPath: stepMatch ? stepMatch[1].trim() : null,
    stlPath: stlMatch ? stlMatch[1].trim() : null,
    raw: result,
  };
}
