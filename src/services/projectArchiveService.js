import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";

const PROJECT_SCHEMA_VERSION = 1;
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return fallback;
  }
}

function userScope(userId) {
  return sha256(String(userId)).slice(0, 32);
}

function storageRoot() {
  return path.resolve(config.projectArchive?.dir ?? path.join(config.dataDir, "user-storage"));
}

function normalizeProjectId(candidate) {
  return PROJECT_ID_RE.test(String(candidate ?? "")) ? String(candidate) : randomUUID();
}

function titleFromPrompt(prompt) {
  const cleaned = String(prompt ?? "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 80) : "Adsız proje";
}

function nextVersionNumber(manifest) {
  const versions = Array.isArray(manifest?.versions) ? manifest.versions : [];
  return versions.reduce((max, item) => Math.max(max, Number(item.number) || 0), 0) + 1;
}

function fileRecord(sourcePath, destinationPath, projectDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  fs.copyFileSync(sourcePath, destinationPath);
  const stat = fs.statSync(destinationPath);
  return {
    name: path.basename(destinationPath),
    path: path.relative(projectDir, destinationPath).split(path.sep).join("/"),
    size: stat.size,
    sha256: sha256File(destinationPath),
  };
}

/**
 * Copy a successful build into private user/project/version storage. The
 * original output files remain untouched so current previews and downloads keep
 * working. Throws internally, but the fail-open wrapper below protects requests.
 */
export function archiveProjectBuild({
  userId,
  projectId: requestedProjectId,
  projectName,
  operation,
  prompt,
  generatedCode,
  stepPath,
  stlPath,
  bbox = null,
}) {
  if (!userId) throw new Error("userId is required for private project storage");

  const projectId = normalizeProjectId(requestedProjectId);
  const userDir = path.join(storageRoot(), "users", userScope(userId));
  const projectDir = path.join(userDir, "projects", projectId);
  const manifestPath = path.join(projectDir, "project.json");
  const now = new Date().toISOString();
  const existing = readJson(manifestPath, null);
  const versionNumber = nextVersionNumber(existing);
  const versionId = `v${String(versionNumber).padStart(3, "0")}`;
  const versionDir = path.join(projectDir, "versions", versionId);
  fs.mkdirSync(versionDir, { recursive: true });

  const files = [];
  const step = fileRecord(stepPath, path.join(versionDir, "model.step"), projectDir);
  const stl = fileRecord(stlPath, path.join(versionDir, "preview.stl"), projectDir);
  if (step) files.push({ ...step, type: "step" });
  if (stl) files.push({ ...stl, type: "stl" });
  if (typeof generatedCode === "string" && generatedCode.trim()) {
    const codePath = path.join(versionDir, "model.py");
    fs.writeFileSync(codePath, generatedCode, "utf8");
    const codeStat = fs.statSync(codePath);
    files.push({
      name: "model.py",
      path: path.relative(projectDir, codePath).split(path.sep).join("/"),
      type: "source",
      size: codeStat.size,
      sha256: sha256File(codePath),
    });
  }

  const version = {
    id: versionId,
    number: versionNumber,
    operation,
    prompt: String(prompt ?? ""),
    createdAt: now,
    bbox,
    files,
  };
  const manifest = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: projectId,
    name: existing?.name || projectName || titleFromPrompt(prompt),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    latestVersion: versionId,
    versions: [...(existing?.versions ?? []), version],
  };
  atomicWriteJson(manifestPath, manifest);

  const indexPath = path.join(userDir, "projects.json");
  const index = readJson(indexPath, { schemaVersion: PROJECT_SCHEMA_VERSION, projects: [] });
  const projects = Array.isArray(index.projects) ? index.projects : [];
  const summary = {
    id: projectId,
    name: manifest.name,
    createdAt: manifest.createdAt,
    updatedAt: now,
    latestVersion: versionId,
    versionCount: manifest.versions.length,
  };
  const previousIndex = projects.findIndex((item) => item.id === projectId);
  if (previousIndex >= 0) projects[previousIndex] = summary;
  else projects.push(summary);
  projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  atomicWriteJson(indexPath, { schemaVersion: PROJECT_SCHEMA_VERSION, projects });

  return { projectId, projectName: manifest.name, versionId, files };
}

// Archiving is an additive durability feature. Disk/index failures are logged
// but never allowed to break a successful CAD result.
export function archiveProjectBuildFailOpen(options) {
  if (config.projectArchive?.enabled === false) return null;
  try {
    return archiveProjectBuild(options);
  } catch (error) {
    console.warn("[project-archive] proje kaydedilemedi:", error.message);
    return null;
  }
}
