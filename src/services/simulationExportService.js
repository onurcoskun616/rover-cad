import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { freshDocPy, sanitizeFreeCADCode } from "./exportService.js";
import {
  callFreecadTool,
  extractResultText,
} from "./freecadMcpClient.js";

const STEP_EXPORT_SUFFIX = `
# --- Rover CAD file export (appended automatically) ---
try:
    _asm_objs = [_o for _o in doc.Objects if hasattr(_o, 'Shape') and not _o.Name.startswith('Mesh_')]
    for _o in _asm_objs:
        _ps = os.path.join(_rover_sim_out, f"sim_{_rover_sim_ts}_{_o.Name}.step")
        Part.export([_o], _ps)
        print(f"PART_STEP:{_o.Name}={_ps}")
    if _asm_objs:
        _as = os.path.join(_rover_sim_out, f"sim_{_rover_sim_ts}_assembly.step")
        Part.export(_asm_objs, _as)
        print(f"ASSEMBLY_STEP={_as}")
except Exception as _e:
    print(f"STEP_EXPORT_ERROR={_e}")
`;

/**
 * Run a kinematic simulation script in FreeCAD.
 *
 * The script is expected to:
 *   1. Build geometry parts with distinct names
 *   2. Export each part as a separate STL  (print PART_STL:<name>=<path>)
 *   3. Write a kinematics.json file        (print KINEMATICS_PATH=<path>)
 *
 * Returns { ok, parts: [{name,stlPath}], partSteps: [{name,stepPath}],
 *           kinematicsPath, assemblyStepPath } on success.
 */
export async function runSimulationExport(code) {
  const ts = Date.now();
  const outDir = config.outputDir;

  const fullCode = [
    freshDocPy(),
    "",
    `_rover_sim_out = ${JSON.stringify(outDir)}`,
    `_rover_sim_ts = "${ts}"`,
    "",
    sanitizeFreeCADCode(code),
    STEP_EXPORT_SUFFIX,
  ].join("\n");

  try {
    console.log("[simExport] calling FreeCAD MCP…");
    const result = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]: fullCode,
    });
    const text = extractResultText(result);
    console.log("[simExport] FreeCAD returned, isError=%s, text length=%d", result?.isError, text?.length ?? 0);
    if (text) console.log("[simExport] output:\n%s", text.slice(0, 2000));

    if (result?.isError) {
      return { ok: false, error: text || "Simulation script failed" };
    }

    const parts = [];
    const partRe = /PART_STL:(\w+)=(.+)/g;
    let m;
    while ((m = partRe.exec(text)) !== null) {
      const stlPath = m[2].trim();
      if (fs.existsSync(stlPath)) {
        const stat = fs.statSync(stlPath);
        console.log("[simExport] found PART_STL:%s size=%d bytes path=%s", m[1], stat.size, stlPath);
        if (stat.size > 0) {
          parts.push({ name: m[1], stlPath });
        } else {
          console.warn("[simExport] PART_STL:%s is 0 bytes, skipping", m[1]);
        }
      } else {
        console.warn("[simExport] PART_STL:%s file missing: %s", m[1], stlPath);
      }
    }

    const partSteps = [];
    const stepRe = /PART_STEP:(\w+)=(.+)/g;
    while ((m = stepRe.exec(text)) !== null) {
      const stepPath = m[2].trim();
      if (fs.existsSync(stepPath)) {
        partSteps.push({ name: m[1], stepPath });
      }
    }

    const asmMatch = text.match(/ASSEMBLY_STEP=(.+)/);
    const assemblyStepPath = asmMatch ? asmMatch[1].trim() : null;

    const kinMatch = text.match(/KINEMATICS_PATH=(.+)/);
    const kinPath = kinMatch ? kinMatch[1].trim() : null;

    if (!parts.length) {
      return { ok: false, error: "No PART_STL markers found in output" };
    }
    if (!kinPath || !fs.existsSync(kinPath)) {
      return {
        ok: false,
        error: "No kinematics.json produced (KINEMATICS_PATH missing)",
      };
    }

    return {
      ok: true,
      parts,
      partSteps,
      kinematicsPath: kinPath,
      assemblyStepPath: assemblyStepPath && fs.existsSync(assemblyStepPath) ? assemblyStepPath : null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
