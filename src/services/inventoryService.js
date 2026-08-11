import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

// Simple file-based JSON store for the user's machine/tool inventory. This is a
// single-firm, single-process tool, so synchronous read/write of small JSON
// arrays is plenty — no DB dependency needed.
function filePath(name) {
  return path.join(config.dataDir, `${name}.json`);
}

function readCollection(name) {
  try {
    const raw = fs.readFileSync(filePath(name), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeCollection(name, arr) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(arr, null, 2));
}

const num = (v, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const str = (v) => (v === undefined || v === null ? "" : String(v));

// --- Machines ---------------------------------------------------------------

function normalizeMachine(data) {
  return {
    name: str(data.name).trim(),
    axisCount: [3, 4, 5].includes(num(data.axisCount)) ? num(data.axisCount) : 3,
    postProcessor: str(data.postProcessor).trim() || "GRBL",
    maxSpindleRpm: num(data.maxSpindleRpm),
    workArea: {
      x: num(data.workArea?.x),
      y: num(data.workArea?.y),
      z: num(data.workArea?.z),
    },
    hourlyRate: num(data.hourlyRate),
  };
}

export function listMachines() {
  return readCollection("machines");
}

export function addMachine(data) {
  const machine = { id: randomUUID(), ...normalizeMachine(data) };
  if (!machine.name) throw new Error("Makine adi zorunludur");
  const list = listMachines();
  list.push(machine);
  writeCollection("machines", list);
  return machine;
}

export function updateMachine(id, data) {
  const list = listMachines();
  const i = list.findIndex((m) => m.id === id);
  if (i === -1) return null;
  const merged = { ...list[i], ...normalizeMachine({ ...list[i], ...data }), id };
  if (!merged.name) throw new Error("Makine adi zorunludur");
  list[i] = merged;
  writeCollection("machines", list);
  return merged;
}

export function removeMachine(id) {
  const list = listMachines();
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  writeCollection("machines", next);
  return true;
}

export function findMachineByName(name) {
  return listMachines().find((m) => m.name === name) ?? null;
}

// --- Tools ------------------------------------------------------------------

function normalizeTool(data) {
  return {
    name: str(data.name).trim(),
    type: str(data.type).trim() || "Duz uclu freze",
    diameter: num(data.diameter),
    flutes: num(data.flutes),
    material: str(data.material).trim() || "Karbur",
    cuttingSpeedMin: num(data.cuttingSpeedMin),
    cuttingSpeedMax: num(data.cuttingSpeedMax),
    stock: data.stock === undefined || data.stock === "" ? null : num(data.stock),
  };
}

export function listTools() {
  return readCollection("tools");
}

export function addTool(data) {
  const tool = { id: randomUUID(), ...normalizeTool(data) };
  if (!tool.name) throw new Error("Takim adi/kodu zorunludur");
  const list = listTools();
  list.push(tool);
  writeCollection("tools", list);
  return tool;
}

export function updateTool(id, data) {
  const list = listTools();
  const i = list.findIndex((t) => t.id === id);
  if (i === -1) return null;
  const merged = { ...list[i], ...normalizeTool({ ...list[i], ...data }), id };
  if (!merged.name) throw new Error("Takim adi/kodu zorunludur");
  list[i] = merged;
  writeCollection("tools", list);
  return merged;
}

export function removeTool(id) {
  const list = listTools();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  writeCollection("tools", next);
  return true;
}

// Human-readable option label used both in the wizard dropdown and when
// resolving a selected tool back to its profile (must match exactly).
export function toolLabel(t) {
  return `${t.name} (O${t.diameter}mm, ${t.flutes} agiz, ${t.material})`;
}

// Tools sorted by how close their diameter is to the recommended one.
export function suitableTools(recommendedDiameter) {
  const rec = num(recommendedDiameter);
  return listTools()
    .slice()
    .sort((a, b) => Math.abs(a.diameter - rec) - Math.abs(b.diameter - rec));
}

/**
 * Resolve a wizard answers object against the saved inventory: when a machine or
 * tool profile is selected, its stored values take precedence over the manual
 * fields. Returns a shallow copy with effective values (and _machineHourlyRate,
 * _toolMaterial, _toolFlutes hints for the quote/plan).
 */
export function effectiveAnswers(answers) {
  const a = { ...(answers ?? {}) };
  const machine = a.machine ? findMachineByName(a.machine) : null;
  if (machine) {
    a.axisCount = `${machine.axisCount} eksen`;
    a.postProcessor = machine.postProcessor;
    a._machineHourlyRate = machine.hourlyRate;
    a._machineName = machine.name;
  }
  if (a.tool) {
    const tool = listTools().find((t) => toolLabel(t) === a.tool);
    if (tool) {
      a.endmillDiameter = tool.diameter;
      a._toolMaterial = tool.material;
      a._toolFlutes = tool.flutes;
      a._toolName = tool.name;
    }
  }
  return a;
}
