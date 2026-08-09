import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { freshDocPy } from "./exportService.js";
import {
  callFreecadTool,
  extractResultText,
} from "./freecadMcpClient.js";

/**
 * Run a kinematic simulation script in FreeCAD.
 *
 * The script is expected to:
 *   1. Build geometry parts with distinct names
 *   2. Export each part as a separate STL  (print PART_STL:<name>=<path>)
 *   3. Write a kinematics.json file        (print KINEMATICS_PATH=<path>)
 *
 * Returns { ok, parts: [{name,stlPath}], kinematicsPath } on success.
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
    code,
  ].join("\n");

  try {
    const result = await callFreecadTool(config.freecadMcp.toolName, {
      [config.freecadMcp.toolParam]: fullCode,
    });
    const text = extractResultText(result);

    if (result?.isError) {
      return { ok: false, error: text || "Simulation script failed" };
    }

    const parts = [];
    const partRe = /PART_STL:(\w+)=(.+)/g;
    let m;
    while ((m = partRe.exec(text)) !== null) {
      const stlPath = m[2].trim();
      if (fs.existsSync(stlPath)) {
        parts.push({ name: m[1], stlPath });
      }
    }

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

    return { ok: true, parts, kinematicsPath: kinPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
