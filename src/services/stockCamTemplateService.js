import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

// Plan Şablonları (Kaydet/Yükle): a persisted library of reusable stock-cam
// plans -- stock dims + material + the full ordered operation list. File-
// based JSON store, same pattern as cncMagazineService.js's own tool/layout
// stores. Loading a template never bypasses the normal confirm pipeline
// (see stockCamAssistant.js's own routes): the client replays each saved
// operation through the exact same /stock-cam/confirm flow (validate +
// real FreeCAD verify) a brand-new operation goes through, since the
// template's stock/material could differ from what was originally saved,
// or the tool magazine could have changed since -- a template is a
// starting point to re-run through every safety check, never a shortcut
// past them.

function filePath() {
  return path.join(config.dataDir, "stock-cam-templates.json");
}

function readTemplates() {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTemplates(list) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(list, null, 2));
}

// Keeps only the reusable shape (type + params, + note if present) --
// deliberately drops toolDia/toolNum/toolRefId: those are per-run
// tool-magazine matches (cnc-sim.html's stockCamApplyMagazineTool) that
// should always be re-resolved fresh against whatever tools are registered
// when the template is LOADED, never replayed from whenever it was first
// saved (the magazine's contents may have changed entirely by then). A
// shop-floor note (İşlem Notları), unlike those, is worth carrying over --
// it's advice about the cut itself ("ince cidar, yavaş ilerle"), still
// relevant on every future run of the same template.
function sanitizeOperation(op) {
  const { toolDia, toolNum, toolRefId, ...rest } = op.params || {};
  const sanitized = { type: op.type, params: rest };
  if (op.note) sanitized.note = op.note;
  return sanitized;
}

// Summary shape only (no operations array) -- kept small for a "pick one"
// list; the full template (with operations) is fetched separately by id
// only when the operator actually loads it.
export function listTemplates() {
  return readTemplates().map(({ id, name, stock, machine, material, operations, createdAt }) => ({
    id,
    name,
    stock,
    machine: machine === "lathe" ? "lathe" : "mill",
    material,
    operationCount: operations.length,
    createdAt,
  }));
}

export function getTemplate(id) {
  return readTemplates().find((t) => t.id === id) || null;
}

// A turning plan's stock is a round bar ({dia,len}), a milling plan's a block
// ({w,d,h}) -- a template has to keep whichever one it was saved from, or
// reloading a lathe template would silently hand the wizard a 0x0x0 block.
function normalizeStock(stock) {
  if (Number.isFinite(Number(stock?.dia)) && Number.isFinite(Number(stock?.len))) {
    return { dia: Number(stock.dia), len: Number(stock.len) };
  }
  return { w: Number(stock?.w), d: Number(stock?.d), h: Number(stock?.h) };
}

function isValidStock(stock) {
  if (Number.isFinite(Number(stock?.dia)) && Number.isFinite(Number(stock?.len))) return true;
  return [stock?.w, stock?.d, stock?.h].every((v) => Number.isFinite(Number(v)));
}

export function saveTemplate(name, plan) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Şablon adı zorunludur.");
  if (!plan?.operations?.length) throw new Error("Boş bir plan şablon olarak kaydedilemez.");
  const template = {
    id: randomUUID(),
    name: trimmedName,
    stock: normalizeStock(plan.stock),
    machine: plan.machine === "lathe" ? "lathe" : "mill",
    material: plan.material || "steel",
    operations: plan.operations.map(sanitizeOperation),
    createdAt: Date.now(),
  };
  const list = readTemplates();
  list.push(template);
  writeTemplates(list);
  return template;
}

export function deleteTemplate(id) {
  const list = readTemplates();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  writeTemplates(next);
  return true;
}

// Şablon Dışa/İçe Aktarma (yedekleme): the FULL stored records (including
// operations), unlike listTemplates()'s summary shape -- this is what gets
// downloaded as a single backup JSON file.
export function listFullTemplates() {
  return readTemplates();
}

// Imports a previously-exported backup. Always ADDITIVE (fresh ids,
// fresh createdAt) -- never overwrites or replaces an existing template,
// even one with the same name, so importing a backup can never silently
// destroy templates already on this machine. Malformed entries (missing
// name/stock/operations) are silently skipped rather than rejecting the
// whole file, so one corrupted entry in an old backup doesn't block
// restoring the rest of it.
export function importTemplates(rawList) {
  if (!Array.isArray(rawList)) throw new Error("İçe aktarılacak veri bir dizi olmalıdır.");
  const list = readTemplates();
  const imported = [];
  for (const raw of rawList) {
    const name = String(raw?.name || "").trim();
    if (!name) continue;
    if (!isValidStock(raw?.stock)) continue;
    const operations = Array.isArray(raw.operations)
      ? raw.operations
          .filter((op) => typeof op?.type === "string" && op.type && op.params && typeof op.params === "object")
          .map((op) => (op.note ? { type: op.type, params: op.params, note: String(op.note) } : { type: op.type, params: op.params }))
      : [];
    if (!operations.length) continue;
    const template = {
      id: randomUUID(),
      name,
      stock: normalizeStock(raw.stock),
      machine: raw.machine === "lathe" ? "lathe" : "mill",
      material: typeof raw.material === "string" && raw.material ? raw.material : "steel",
      operations,
      createdAt: Date.now(),
    };
    list.push(template);
    imported.push(template);
  }
  writeTemplates(list);
  return imported;
}
