import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import { archiveProjectBuild } from "../src/services/projectArchiveService.js";

function setup(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rover-project-archive-"));
  const sourceDir = path.join(tempDir, "output");
  const archiveDir = path.join(tempDir, "storage");
  fs.mkdirSync(sourceDir, { recursive: true });
  const stepPath = path.join(sourceDir, "part.step");
  const stlPath = path.join(sourceDir, "part.stl");
  fs.writeFileSync(stepPath, "STEP-CONTENT", "utf8");
  fs.writeFileSync(stlPath, "STL-CONTENT", "utf8");
  const original = { ...config.projectArchive };
  config.projectArchive.enabled = true;
  config.projectArchive.dir = archiveDir;
  t.after(() => {
    config.projectArchive = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { archiveDir, stepPath, stlPath };
}

test("successful builds are copied as immutable project versions", (t) => {
  const { stepPath, stlPath } = setup(t);
  const first = archiveProjectBuild({
    userId: "user-a",
    projectId: "project-1234",
    operation: "cad-generate",
    prompt: "40 dişli çiz",
    generatedCode: "import FreeCAD",
    stepPath,
    stlPath,
    bbox: { x: 10, y: 20, z: 5 },
  });
  assert.equal(first.versionId, "v001");
  assert.equal(first.files.length, 3);

  fs.writeFileSync(stepPath, "STEP-CONTENT-V2", "utf8");
  const second = archiveProjectBuild({
    userId: "user-a",
    projectId: first.projectId,
    operation: "cad-revise",
    prompt: "çapı büyüt",
    generatedCode: "import FreeCAD\n# v2",
    stepPath,
    stlPath,
  });
  assert.equal(second.versionId, "v002");
  assert.notEqual(first.files[0].sha256, second.files[0].sha256);
});

test("the same project id is isolated between users", (t) => {
  const { archiveDir, stepPath, stlPath } = setup(t);
  const options = {
    projectId: "shared-looking-id",
    operation: "cad-generate",
    prompt: "mil çiz",
    generatedCode: "import FreeCAD",
    stepPath,
    stlPath,
  };
  archiveProjectBuild({ ...options, userId: "user-a" });
  archiveProjectBuild({ ...options, userId: "user-b" });

  const manifests = [];
  for (const userDir of fs.readdirSync(path.join(archiveDir, "users"))) {
    manifests.push(path.join(archiveDir, "users", userDir, "projects", "shared-looking-id", "project.json"));
  }
  assert.equal(manifests.length, 2);
  assert.ok(manifests.every((filePath) => fs.existsSync(filePath)));
});
