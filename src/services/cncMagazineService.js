import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

// File-based JSON store for the CNC Simülatör's tool magazine — a separate
// collection from the CAD/CAM "Takım Kütüphanesi" (inventoryService.js),
// scoped to the simulator's own 40-slot magazine and its own simplified tool
// shape (dia/fluteLen/totalLen/maxRpm — matches ToolMagazine in cnc-sim.html).
const CAPACITY = 40;
const VALID_TYPES = ["endmill", "roughing", "drill", "ballmill", "chamfer"];

function filePath(name) {
  return path.join(config.dataDir, `${name}.json`);
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), "utf8");
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2));
}

const num = (v, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const str = (v) => (v === undefined || v === null ? "" : String(v));

function normalizeTool(data) {
  return {
    name: str(data.name).trim(),
    type: VALID_TYPES.includes(str(data.type)) ? str(data.type) : "endmill",
    dia: num(data.dia),
    fluteLen: num(data.fluteLen),
    totalLen: num(data.totalLen),
    maxRpm: num(data.maxRpm, 10000),
  };
}

export function listMagazineTools() {
  return readJson("cnc-magazine-tools", []);
}

export function addMagazineTool(data) {
  const tool = { id: randomUUID(), ...normalizeTool(data) };
  if (!tool.name) throw new Error("Takim adi zorunludur");
  if (tool.dia <= 0) throw new Error("Takim capi 0'dan buyuk olmalidir");
  const list = listMagazineTools();
  list.push(tool);
  writeJson("cnc-magazine-tools", list);
  return tool;
}

export function updateMagazineTool(id, data) {
  const list = listMagazineTools();
  const i = list.findIndex((t) => t.id === id);
  if (i === -1) return null;
  const merged = { ...list[i], ...normalizeTool({ ...list[i], ...data }), id };
  if (!merged.name) throw new Error("Takim adi zorunludur");
  if (merged.dia <= 0) throw new Error("Takim capi 0'dan buyuk olmalidir");
  list[i] = merged;
  writeJson("cnc-magazine-tools", list);
  return merged;
}

export function removeMagazineTool(id) {
  const list = listMagazineTools();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  writeJson("cnc-magazine-tools", next);
  // Drop the removed tool from the layout so slots never point at a dead id.
  const layout = listMagazineLayout();
  const cleaned = layout.map((toolId) => (toolId === id ? null : toolId));
  writeJson("cnc-magazine-layout", cleaned);
  return true;
}

// slots[i] holds a tool id (or null for an empty slot), i = 0..CAPACITY-1.
export function listMagazineLayout() {
  const raw = readJson("cnc-magazine-layout", []);
  const slots = new Array(CAPACITY).fill(null);
  for (let i = 0; i < CAPACITY; i++) slots[i] = raw[i] ?? null;
  return slots;
}

// The simulator's 12 built-in tools live only in the frontend and are
// referenced from a saved layout as "builtin:1".."builtin:12" — always
// considered valid here since the backend has no record of them itself.
const BUILTIN_SLOT_RE = /^builtin:(?:[1-9]|1[0-2])$/;

export function setMagazineLayout(slots) {
  if (!Array.isArray(slots)) throw new Error("layout bir dizi olmalidir");
  const validIds = new Set(listMagazineTools().map((t) => t.id));
  const cleaned = new Array(CAPACITY).fill(null);
  for (let i = 0; i < CAPACITY; i++) {
    const value = slots[i];
    cleaned[i] = value && (validIds.has(value) || BUILTIN_SLOT_RE.test(value)) ? value : null;
  }
  writeJson("cnc-magazine-layout", cleaned);
  return cleaned;
}
