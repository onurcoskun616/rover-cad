import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import {
  normalizeTechnicalPrompt,
  preparePromptCache,
} from "../src/services/promptCacheService.js";

function withTempCache(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rover-prompt-cache-"));
  const systemPromptFile = path.join(tempDir, "system.txt");
  fs.writeFileSync(systemPromptFile, "Return FreeCAD Python", "utf8");
  const original = { ...config.promptCache };
  config.promptCache.dir = tempDir;
  config.promptCache.pipelineVersion = "test-v1";
  config.promptCache.freecadCompatibility = "test-freecad";
  t.after(() => {
    config.promptCache = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { tempDir, systemPromptFile };
}

test("technical prompt normalization preserves geometry-changing punctuation", () => {
  assert.equal(normalizeTechnicalPrompt("  BANA  10.5 mm Mil Çiz  "), "bana 10.5 mm mil çiz");
  assert.notEqual(
    normalizeTechnicalPrompt("10.5 mm mil çiz"),
    normalizeTechnicalPrompt("105 mm mil çiz"),
  );
});

test("observe mode records a validated miss but does not reuse it", (t) => {
  const { systemPromptFile } = withTempCache(t);
  config.promptCache.mode = "observe";

  const first = preparePromptCache({
    prompt: "40 dişli çiz",
    operation: "cad-text",
    userId: "user-a",
    systemPromptFile,
  });
  assert.equal(first.mayReuse, false);
  assert.equal(first.cachedCode, null);
  first.recordValidated({ code: "import FreeCAD\nresult = Part.makeBox(1, 1, 1)" });

  const second = preparePromptCache({
    prompt: "40 DİŞLİ   çiz",
    operation: "cad-text",
    userId: "user-a",
    systemPromptFile,
  });
  assert.equal(second.cachedCode, "import FreeCAD\nresult = Part.makeBox(1, 1, 1)");
  assert.equal(second.mayReuse, false);
});

test("read mode reuses only same-user, same-pipeline validated entries", (t) => {
  const { systemPromptFile } = withTempCache(t);
  config.promptCache.mode = "read";

  const first = preparePromptCache({
    prompt: "flanş çiz",
    operation: "cad-text",
    userId: "user-a",
    systemPromptFile,
  });
  first.recordValidated({ code: "import FreeCAD\nresult = Part.makeCylinder(5, 2)" });

  const sameUser = preparePromptCache({
    prompt: "FLANŞ çiz",
    operation: "cad-text",
    userId: "user-a",
    systemPromptFile,
  });
  assert.equal(sameUser.mayReuse, true);

  const otherUser = preparePromptCache({
    prompt: "flanş çiz",
    operation: "cad-text",
    userId: "user-b",
    systemPromptFile,
  });
  assert.equal(otherUser.mayReuse, false);

  config.promptCache.pipelineVersion = "test-v2";
  const newPipeline = preparePromptCache({
    prompt: "flanş çiz",
    operation: "cad-text",
    userId: "user-a",
    systemPromptFile,
  });
  assert.equal(newPipeline.mayReuse, false);
});
