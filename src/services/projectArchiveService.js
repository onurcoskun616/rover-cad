import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";

const PROJECT_SCHEMA_VERSION = 1;
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function operationLabel(operation) {
  return {
    "cad-generate": "Metinden CAD",
    "cad-image": "Teknik resimden CAD",
    "cad-revise": "Revizyon",
    "cad-param-edit": "Parametrik düzenleme",
  }[operation] || "CAD çalışması";
}

function userDirFor(userId) {
  return path.join(storageRoot(), "users", userScope(userId));
}

function projectDirFor(userId, projectId) {
  const normalized = normalizeProjectId(projectId);
  if (normalized !== String(projectId)) throw Object.assign(new Error("Geçersiz proje kimliği"), { status: 400 });
  return path.join(userDirFor(userId), "projects", normalized);
}

function publicFile(projectId, version, file) {
  const filePath = String(file?.path ?? "");
  return {
    name: file?.name || path.basename(filePath) || "dosya",
    path: filePath,
    type: file?.type || "file",
    size: Number(file?.size) || 0,
    versionId: version.id,
    versionNumber: Number(version.number) || 0,
    operation: version.operation,
    url: `/auth/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(filePath)}`,
    createdAt: version.createdAt,
  };
}

function publicProject(manifest) {
  if (!manifest?.id) return null;
  const versions = Array.isArray(manifest?.versions) ? manifest.versions : [];
  const latest = versions.find((item) => item.id === manifest.latestVersion) || versions.at(-1) || null;
  const files = latest ? (latest.files ?? []).map((file) => publicFile(manifest.id, latest, file)) : [];
  const prompt = latest?.prompt || manifest.name || "";
  const publicVersions = versions.map((version) => ({
    id: version.id,
    number: Number(version.number) || 0,
    operation: version.operation || "",
    operationLabel: operationLabel(version.operation),
    prompt: version.prompt || "",
    createdAt: version.createdAt,
    bbox: version.bbox ?? null,
    files: (version.files ?? []).map((file) => publicFile(manifest.id, version, file)),
  }));
  return {
    id: manifest.id,
    name: manifest.name || titleFromPrompt(prompt),
    prompt,
    actionTitle: titleFromPrompt(prompt),
    operation: latest?.operation || "",
    operationLabel: operationLabel(latest?.operation),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    latestVersion: manifest.latestVersion,
    versionCount: versions.length,
    bbox: latest?.bbox ?? null,
    files,
    versions: publicVersions,
  };
}

function nextVersionNumber(manifest) {
  const versions = Array.isArray(manifest?.versions) ? manifest.versions : [];
  return versions.reduce((max, item) => Math.max(max, Number(item.number) || 0), 0) + 1;
}

async function sha256FileAsync(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileRecordAsync(sourcePath, destinationPath, projectDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  await fs.promises.copyFile(sourcePath, destinationPath);
  const stat = await fs.promises.stat(destinationPath);
  return {
    name: path.basename(destinationPath),
    path: path.relative(projectDir, destinationPath).split(path.sep).join("/"),
    size: stat.size,
    sha256: await sha256FileAsync(destinationPath),
  };
}

/**
 * Copy a successful build into private user/project/version storage. The
 * original output files remain untouched so current previews and downloads keep
 * working. Throws internally, but the fail-open wrapper below protects requests.
 * Runs entirely off the request/job critical path (see archiveProjectBuildFailOpen)
 * — copying and hashing a multi-MB STEP/STL file used to run synchronously right
 * before a job was marked "done", which stalled that job's own response (and, for
 * exclusive FreeCAD jobs, delayed the next queued job too) for as long as the copy
 * + hash took.
 */
async function archiveProjectBuild({
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
  const step = await fileRecordAsync(stepPath, path.join(versionDir, "model.step"), projectDir);
  const stl = await fileRecordAsync(stlPath, path.join(versionDir, "preview.stl"), projectDir);
  if (step) files.push({ ...step, type: "step" });
  if (stl) files.push({ ...stl, type: "stl" });
  if (typeof generatedCode === "string" && generatedCode.trim()) {
    const codePath = path.join(versionDir, "model.py");
    await fs.promises.writeFile(codePath, generatedCode, "utf8");
    const codeStat = await fs.promises.stat(codePath);
    files.push({
      name: "model.py",
      path: path.relative(projectDir, codePath).split(path.sep).join("/"),
      type: "source",
      size: codeStat.size,
      sha256: await sha256FileAsync(codePath),
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

// archiveProjectBuild's own async work (per project) must still happen in
// submission order, or two builds for the same project racing in the
// background could both read the manifest before either has written its
// version, land on the same version number, and clobber each other. This
// chain serializes just the archiving work — never the caller.
let archiveChain = Promise.resolve();

// Archiving is an additive durability feature: nothing in the live preview
// (STL/STEP URLs, bbox, etc.) depends on it, only the private project
// history does. So it must never sit between a successful FreeCAD build and
// the response the browser/poller is waiting on — only projectId is needed
// synchronously (so a follow-up revise/param-edit call can keep versioning
// the same project); the actual file copy + hash + manifest write runs in
// the background afterwards. Disk/index failures there are logged but never
// allowed to break a successful CAD result.
export function archiveProjectBuildFailOpen(options) {
  if (config.projectArchive?.enabled === false) return null;
  if (!options?.userId) return null;

  const projectId = normalizeProjectId(options.projectId);
  archiveChain = archiveChain.then(
    () => archiveProjectBuild({ ...options, projectId }).catch((error) => {
      console.warn("[project-archive] proje kaydedilemedi:", error.message);
    }),
    () => {}, // a previous archive failure must not stall later ones
  );
  return { projectId };
}

export function listUserProjects(userId, limit = 30) {
  if (!userId) throw Object.assign(new Error("Oturum açmanız gerekiyor"), { status: 401 });
  const indexPath = path.join(userDirFor(userId), "projects.json");
  const index = readJson(indexPath, { projects: [] });
  const projects = Array.isArray(index.projects) ? index.projects : [];
  return projects.slice(0, Math.min(100, Math.max(1, Number(limit) || 30))).map((summary) => {
    const manifestPath = path.join(projectDirFor(userId, summary.id), "project.json");
    return publicProject(readJson(manifestPath, summary));
  }).filter(Boolean);
}

export function getUserProject(userId, projectId, proto = "https", host = "", requestedVersionId = "") {
  const projectDir = projectDirFor(userId, projectId);
  const manifest = publicProject(readJson(path.join(projectDir, "project.json"), null));
  if (!manifest?.id) throw Object.assign(new Error("Proje bulunamadı"), { status: 404 });
  const requestedVersion = requestedVersionId
    ? manifest.versions.find((version) => version.id === requestedVersionId)
    : null;
  if (requestedVersionId && !requestedVersion) {
    throw Object.assign(new Error("Proje sürümü bulunamadı"), { status: 404 });
  }
  const selectedVersion = requestedVersion
    || manifest.versions.find((version) => version.id === manifest.latestVersion)
    || manifest.versions.at(-1)
    || null;
  const absolute = (file) => path.join(projectDir, file.path);
  const withFullUrls = {
    ...manifest,
    files: (selectedVersion?.files ?? manifest.files).map((file) => ({
      ...file,
      url: `${proto}://${host}${file.url}`,
    })),
    selectedVersionId: selectedVersion?.id ?? manifest.latestVersion,
    selectedVersionNumber: selectedVersion?.number ?? manifest.versionCount,
    prompt: selectedVersion?.prompt || manifest.prompt,
    operation: selectedVersion?.operation || manifest.operation,
    operationLabel: selectedVersion?.operationLabel || manifest.operationLabel,
    bbox: selectedVersion?.bbox ?? manifest.bbox,
    versions: manifest.versions.map((version) => ({
      ...version,
      files: version.files.map((file) => ({
        ...file,
        url: `${proto}://${host}${file.url}`,
      })),
    })),
  };
  const step = withFullUrls.files.find((file) => file.type === "step");
  const stl = withFullUrls.files.find((file) => file.type === "stl");
  const source = withFullUrls.files.find((file) => file.type === "source");
  return {
    ...withFullUrls,
    stepPath: step ? absolute(step) : null,
    stlPath: stl ? absolute(stl) : null,
    stepUrl: step?.url ?? null,
    stlUrl: stl?.url ?? null,
    generatedCode: source ? fs.readFileSync(absolute(source), "utf8") : "",
  };
}

export function listUserFiles(userId, limit = 60) {
  return listUserProjects(userId, 100).flatMap((project) =>
    project.versions.flatMap((version) => version.files.map((file) => ({
      ...file,
      projectId: project.id,
      projectName: project.name,
      projectPrompt: project.prompt,
      projectUpdatedAt: project.updatedAt,
      versionId: version.id,
      versionNumber: version.number,
      operationLabel: version.operationLabel,
      prompt: version.prompt,
    }))),
  ).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.min(200, Math.max(1, Number(limit) || 60)));
}

export function getUserProjectFilePath(userId, projectId, relativePath) {
  const projectDir = projectDirFor(userId, projectId);
  const decoded = String(relativePath ?? "");
  const absolute = path.resolve(projectDir, decoded);
  if (!absolute.startsWith(`${projectDir}${path.sep}`)) {
    throw Object.assign(new Error("Geçersiz dosya yolu"), { status: 400 });
  }
  if (!fs.existsSync(absolute)) throw Object.assign(new Error("Dosya bulunamadı"), { status: 404 });
  return absolute;
}
