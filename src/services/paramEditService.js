/**
 * Deterministic parameter editing for FreeCAD Python code.
 * Parses the ROVER_PARAMS block, substitutes a value, and re-runs the code
 * in FreeCAD — no LLM call needed.
 */

import { runGeneratedCodeAndExport } from "./exportService.js";

const PARAMS_START = "# ROVER_PARAMS_START";
const PARAMS_END = "# ROVER_PARAMS_END";

/**
 * Parse the parameter block from generated FreeCAD Python code.
 * @param {string} code
 * @returns {{name: string, value: number, unit: string, line: number}[]}
 */
export function parseParams(code) {
  if (!code) return [];
  const lines = code.split("\n");
  const params = [];
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === PARAMS_START) {
      inBlock = true;
      continue;
    }
    if (trimmed === PARAMS_END) break;
    if (!inBlock) continue;

    const match = trimmed.match(
      /^(\w+)\s*=\s*([\d.eE+-]+)\s*(?:#\s*(.*))?$/,
    );
    if (match) {
      params.push({
        name: match[1],
        value: parseFloat(match[2]),
        unit: match[3]?.trim() || "mm",
        line: i,
      });
    }
  }
  return params;
}

/**
 * Replace a parameter's value in the code string. Returns the modified code.
 * @param {string} code
 * @param {string} paramName
 * @param {number} newValue
 * @returns {string} modified code
 */
export function applyParamChange(code, paramName, newValue) {
  const lines = code.split("\n");
  let found = false;
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === PARAMS_START) {
      inBlock = true;
      continue;
    }
    if (trimmed === PARAMS_END) break;
    if (!inBlock) continue;

    const regex = new RegExp(
      `^(\\s*${paramName}\\s*=\\s*)[\\d.eE+-]+(\\s*#.*)$`,
    );
    const match = lines[i].match(regex);
    if (match) {
      lines[i] = `${match[1]}${newValue}${match[2]}`;
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error(`Parametre bulunamadi: ${paramName}`);
  }

  return updateRoverDimensions(lines.join("\n"));
}

const PARAM_LABEL_MAP = {
  uzunluk: "Uzunluk", genislik: "Genislik", yukseklik: "Yukseklik",
  derinlik: "Derinlik", kalinlik: "Kalinlik", cap: "Cap",
  ic_cap: "Ic Cap", dis_cap: "Dis Cap", yaricap: "Yaricap",
  delik_capi: "Delik Capi", delik_derinlik: "Delik Derinlik",
  delik_sayisi: "Delik Sayisi", pah: "Pah", radyus: "Radyus",
  agiz_capi: "Agiz Capi", taban_capi: "Taban Capi",
  boy: "Boy", en: "En", cikinti: "Cikinti",
};

function labelForParam(name) {
  if (PARAM_LABEL_MAP[name]) return PARAM_LABEL_MAP[name];
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function updateRoverDimensions(code) {
  const params = parseParams(code);
  if (!params.length) return code;

  const dimObj = {};
  for (const p of params) {
    const unit = p.unit === "adet" ? "adet" : "mm";
    dimObj[labelForParam(p.name)] = `${p.value} ${unit}`;
  }
  const newDimLine = `# ROVER_DIMENSIONS: ${JSON.stringify(dimObj)}`;

  const dimRegex = /^#\s*ROVER_DIMENSIONS:\s*\{.*\}.*$/m;
  if (dimRegex.test(code)) {
    return code.replace(dimRegex, newDimLine);
  }

  const endIdx = code.indexOf(PARAMS_END);
  if (endIdx !== -1) {
    const insertPos = code.indexOf("\n", endIdx);
    if (insertPos !== -1) {
      return code.slice(0, insertPos) + "\n" + newDimLine + code.slice(insertPos);
    }
  }
  return code;
}

/**
 * Edit a parameter and re-run the code in FreeCAD deterministically.
 * No LLM is involved — the parameter value is substituted directly in the
 * source code and the modified script is executed.
 *
 * @param {string} code current FreeCAD Python code (with ROVER_PARAMS block)
 * @param {string} paramName parameter variable name to change
 * @param {number} newValue new numeric value
 * @returns {Promise<{ok: boolean, error?: string, stepPath?: string,
 *   stlPath?: string, bbox?: object, generatedCode?: string}>}
 */
export async function runParamEdit(code, paramName, newValue) {
  const updatedCode = applyParamChange(code, paramName, newValue);
  const result = await runGeneratedCodeAndExport(updatedCode);

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      generatedCode: updatedCode,
    };
  }

  return {
    ok: true,
    stepPath: result.stepPath,
    stlPath: result.stlPath,
    bbox: result.bbox,
    anchors: result.anchors,
    center: result.center,
    generatedCode: updatedCode,
  };
}
