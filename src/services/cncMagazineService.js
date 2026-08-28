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
// Takım Ömrü Takibi (tool life/wear tracking): a general, typical
// carbide-tool "time to inspect/replace" reminder threshold (8 saat kesme) --
// a conservative shop-floor default, not a precise per-tool engineering
// figure. A custom tool may override it via its own `wearLimitMinutes`.
const DEFAULT_WEAR_LIMIT_MINUTES = 480;

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
    // Used by the CAM Assistant when it sources tool selection from this same
    // magazine (single shared source across simulator + real production).
    flutes: num(data.flutes, 2) || 2,
    material: str(data.material).trim() || "Karbur",
    wearLimitMinutes: num(data.wearLimitMinutes, DEFAULT_WEAR_LIMIT_MINUTES) || DEFAULT_WEAR_LIMIT_MINUTES,
  };
}

// Human-readable option label — mirrors inventoryService's toolLabel() shape
// so the CAM Assistant wizard's tool dropdown reads the same either way.
export function magazineToolLabel(t) {
  return `${t.name} (O${t.dia}mm, ${t.flutes ?? 2} agiz, ${t.material || "Karbur"})`;
}

// Tools that can actually mill a profile or pocket. A drill or a chamfer mill
// in the magazine is real and stays selectable, but it must never be the
// DEFAULT answer to "main endmill diameter" — which is what a purely
// diameter-based sort produced the moment the built-ins became visible: the
// recommended O8mm matched "O8 Matkap" exactly, so the wizard offered a drill
// as the part's roughing/finishing cutter.
const MILLING_TYPES = new Set(["endmill", "roughing", "ballmill"]);

// Magazine tools for the wizard's cutter picker: milling tools first, then by
// how close each diameter is to the recommended one.
export function suitableMagazineTools(recommendedDiameter) {
  const rec = num(recommendedDiameter);
  const rank = (t) => (MILLING_TYPES.has(t.type) ? 0 : 1);
  return listMagazineTools()
    .slice()
    .sort((a, b) => rank(a) - rank(b) || Math.abs(a.dia - rec) - Math.abs(b.dia - rec));
}

// The simulator ships 12 stock tools that live in cnc-sim.html's own
// TOOL_LIBRARY and are never written to this store — only user-added tools are.
// That left the CAM Assistant's wizard reading an empty magazine and telling the
// machinist "Magazinde kayitli takim yok; once CNC Simulator > Magazin'den takim
// ekleyin" while the simulator right next to it was happily showing T01 O6 /
// T02 O10 / T05 O26. Mirroring the built-ins here makes both sides agree on one
// magazine, which is what slotNumberForTool's "builtin:N" refs already assumed.
// Kept in the same shape normalizeTool() produces (flutes/material defaulted the
// same way) so a built-in and a custom tool are interchangeable downstream.
// Read-only by design: add/update/remove only ever touch the stored custom list.
const BUILTIN_TOOLS = [
  { name: "O6 Parmak Freze", type: "endmill", dia: 6, fluteLen: 20, totalLen: 50, maxRpm: 12000 },
  { name: "O10 Parmak Freze", type: "endmill", dia: 10, fluteLen: 25, totalLen: 60, maxRpm: 10000 },
  { name: "O16 Parmak Freze", type: "endmill", dia: 16, fluteLen: 30, totalLen: 70, maxRpm: 9000 },
  { name: "O20 Parmak Freze", type: "endmill", dia: 20, fluteLen: 35, totalLen: 75, maxRpm: 8000 },
  { name: "O26 Parmak Freze", type: "endmill", dia: 26, fluteLen: 26, totalLen: 70, maxRpm: 7000 },
  { name: "O32 Kaba Freze", type: "roughing", dia: 32, fluteLen: 35, totalLen: 80, maxRpm: 6000 },
  { name: "O8 Matkap", type: "drill", dia: 8, fluteLen: 40, totalLen: 80, maxRpm: 6000 },
  { name: "O12 Matkap", type: "drill", dia: 12, fluteLen: 50, totalLen: 90, maxRpm: 5000 },
  { name: "O5 Top Freze", type: "ballmill", dia: 5, fluteLen: 15, totalLen: 45, maxRpm: 15000 },
  { name: "O10 Top Freze", type: "ballmill", dia: 10, fluteLen: 20, totalLen: 55, maxRpm: 12000 },
  { name: "O3 Pah Freze", type: "chamfer", dia: 3, fluteLen: 10, totalLen: 40, maxRpm: 18000 },
  { name: "O6 Pah Freze", type: "chamfer", dia: 6, fluteLen: 12, totalLen: 45, maxRpm: 15000 },
].map((t, i) => ({ id: `builtin:${i + 1}`, ...normalizeTool(t) }));

export function listMagazineTools() {
  return [...BUILTIN_TOOLS, ...readJson("cnc-magazine-tools", [])];
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
  // Nothing saved yet -> mirror the simulator's own loadDefaults(), which seats
  // the built-ins in T01..T12. Without this every stock tool reads as "not
  // placed in the magazine" and the CAM Assistant falls back to placeholder
  // T90+ numbers, while the simulator is showing those same tools in T01..T12.
  // A saved layout is honoured exactly as stored — including the nulls that
  // record slots the machinist deliberately emptied.
  if (!Array.isArray(raw) || raw.length === 0) {
    for (let i = 0; i < BUILTIN_TOOLS.length && i < CAPACITY; i++) slots[i] = BUILTIN_TOOLS[i].id;
    return slots;
  }
  for (let i = 0; i < CAPACITY; i++) slots[i] = raw[i] ?? null;
  return slots;
}

// The 1-indexed magazine slot the given tool id currently sits in (matching
// the T-numbers shown on the CNC Simülatör and physically labeled on the
// machine's magazine), or null if it isn't placed in any slot. Lets the CAM
// Assistant emit G-code tool numbers a machinist can act on directly instead
// of an arbitrary sequential count.
export function slotNumberForTool(toolId) {
  if (!toolId) return null;
  const idx = listMagazineLayout().indexOf(toolId);
  return idx === -1 ? null : idx + 1;
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

// ---------------------------------------------------------------------------
// Takım Ömrü Takibi (tool life/wear tracking): a persisted, cumulative
// estimated-cutting-minutes counter per tool ref-id ("builtin:N" or a custom
// tool's own uuid — the SAME ref-id scheme cnc-sim.html's magazine editor
// already uses for its slot layout, see magRefId() there). Recorded once per
// confirmed stock-cam operation (stockCamAssistant.js's /stock-cam/confirm
// route), using the real marginal FreeCAD time-estimate delta that operation
// added to the plan — never an invented number. Deliberately NOT
// retroactively adjusted when a plan is later edited or an operation is
// removed: once an operation was confirmed, its share of wear is treated as
// real and permanent, the same way a machinist wouldn't expect an
// already-cut test part to "un-wear" a tool just because the CAM plan was
// revised afterward. A cumulative reminder counter, not a substitute for the
// operator's own tool inspection judgement.
function readToolUsage() {
  return readJson("cnc-magazine-tool-usage", {});
}

export function getToolUsageMinutes(toolRefId) {
  if (!toolRefId) return 0;
  return Number(readToolUsage()[toolRefId]) || 0;
}

export function addToolUsageMinutes(toolRefId, minutes) {
  if (!toolRefId || !Number.isFinite(minutes) || minutes <= 0) return;
  const usage = readToolUsage();
  usage[toolRefId] = (Number(usage[toolRefId]) || 0) + minutes;
  writeJson("cnc-magazine-tool-usage", usage);
}

export function resetToolUsage(toolRefId) {
  const usage = readToolUsage();
  if (!(toolRefId in usage)) return false;
  delete usage[toolRefId];
  writeJson("cnc-magazine-tool-usage", usage);
  return true;
}

export function listToolUsage() {
  return readToolUsage();
}

// Wear-limit lookup: a custom tool may set its own `wearLimitMinutes`;
// everything else (including every built-in) falls back to the shared
// default — built-ins have no persisted record of their own to hold one.
export function wearLimitMinutesFor(toolRefId) {
  if (!toolRefId) return DEFAULT_WEAR_LIMIT_MINUTES;
  const custom = readJson("cnc-magazine-tools", []).find((t) => t.id === toolRefId);
  const limit = Number(custom?.wearLimitMinutes);
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_WEAR_LIMIT_MINUTES;
}

// Convenience rollup for the /stock-cam/confirm route and the printable
// setup sheet — both just want "how many minutes, what's the limit, is it
// already over" for a given tool ref-id.
export function toolWearStatus(toolRefId) {
  const minutes = Math.round(getToolUsageMinutes(toolRefId) * 10) / 10;
  const limit = wearLimitMinutesFor(toolRefId);
  return { minutes, limit, overLimit: minutes >= limit };
}
