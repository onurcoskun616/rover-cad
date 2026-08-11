import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const filePath = path.join(config.dataDir, "accounts.json");
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function emptyDb() { return { users: [], usage: [], payments: [] }; }
function load() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(filePath)) return emptyDb();
  try { return { ...emptyDb(), ...JSON.parse(fs.readFileSync(filePath, "utf8")) }; }
  catch { throw new Error("Account database could not be read"); }
}
function save(db) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, filePath);
}
function monthKey(date = new Date()) { return date.toISOString().slice(0, 7); }
function publicUser(user, db) {
  const used = db.usage.filter((x) => x.userId === user.id && x.month === monthKey())
    .reduce((sum, x) => sum + x.tokens, 0);
  const allowance = user.monthlyTokens ?? config.freeMonthlyTokens;
  return { id: user.id, name: user.name, email: user.email, role: user.role,
    plan: user.plan ?? "free", status: user.status ?? "active", monthlyTokens: allowance,
    usedTokens: used, remainingTokens: Math.max(0, allowance - used), createdAt: user.createdAt };
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", config.authSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function register({ name, email, password }) {
  const db = load();
  email = String(email).trim().toLowerCase();
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email) || String(password).length < 8)
    throw Object.assign(new Error("Ad, geçerli e-posta ve en az 8 karakterli parola gereklidir"), { status: 400 });
  if (db.users.some((u) => u.email === email))
    throw Object.assign(new Error("Bu e-posta zaten kayıtlı"), { status: 409 });
  const pass = hashPassword(password);
  const user = { id: crypto.randomUUID(), name: name.trim(), email, ...pass,
    role: email === config.adminEmail ? "admin" : "user", plan: "free", status: "active",
    monthlyTokens: config.freeMonthlyTokens, createdAt: new Date().toISOString() };
  db.users.push(user); save(db);
  return { token: sign({ sub: user.id, exp: Date.now() + SESSION_MS }), user: publicUser(user, db) };
}

export function login({ email, password }) {
  const db = load();
  const user = db.users.find((u) => u.email === String(email).trim().toLowerCase());
  if (!user || user.status === "blocked") throw Object.assign(new Error("E-posta veya parola hatalı"), { status: 401 });
  const check = hashPassword(String(password), user.salt).hash;
  if (!crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(user.hash, "hex")))
    throw Object.assign(new Error("E-posta veya parola hatalı"), { status: 401 });
  return { token: sign({ sub: user.id, exp: Date.now() + SESSION_MS }), user: publicUser(user, db) };
}

export function verifySession(token) {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", config.authSecret).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.exp < Date.now()) return null;
  const db = load(); const user = db.users.find((u) => u.id === payload.sub && u.status !== "blocked");
  return user ? publicUser(user, db) : null;
}

export function consumeTokens(userId, tokens, action) {
  const db = load(); const user = db.users.find((u) => u.id === userId);
  if (!user) throw Object.assign(new Error("Kullanıcı bulunamadı"), { status: 401 });
  const view = publicUser(user, db);
  if (view.remainingTokens < tokens) throw Object.assign(new Error("Aylık token bakiyeniz yetersiz. Paket yükseltin."), { status: 402 });
  db.usage.push({ id: crypto.randomUUID(), userId, month: monthKey(), tokens, action, createdAt: new Date().toISOString() });
  save(db); return publicUser(user, db);
}

export function listUsage(userId, limit = 50) {
  const db = load(); return db.usage.filter((x) => x.userId === userId).slice(-limit).reverse();
}
export function listUsers() { const db = load(); return db.users.map((u) => publicUser(u, db)); }
export function updateUser(id, changes) {
  const db = load(); const user = db.users.find((u) => u.id === id);
  if (!user) throw Object.assign(new Error("Kullanıcı bulunamadı"), { status: 404 });
  if (changes.status) user.status = changes.status;
  if (changes.role) user.role = changes.role;
  if (changes.plan) user.plan = changes.plan;
  if (Number.isFinite(Number(changes.monthlyTokens))) user.monthlyTokens = Math.max(0, Number(changes.monthlyTokens));
  save(db); return publicUser(user, db);
}
export function stats() {
  const db = load(); const month = monthKey();
  return { users: db.users.length, activeUsers: db.users.filter((u) => u.status !== "blocked").length,
    monthlyTokensUsed: db.usage.filter((x) => x.month === month).reduce((s, x) => s + x.tokens, 0),
    payments: db.payments.length };
}
