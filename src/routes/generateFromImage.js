import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { promptToFreecadCodeFromImage } from "../services/promptToCodeService.js";
import { runBuildPipeline } from "../services/buildPipeline.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

// Uploaded drawings are written to the OS temp dir with a random name and their
// original extension, then read by the claude CLI (Read tool) and deleted when
// the job finishes (not when the HTTP request returns, since that happens first).
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `rover_upload_${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error("Sadece gorsel dosyalar yuklenebilir"));
  },
});

const router = Router();

router.use(apiKeyAuth);

// Async: the upload finishes fast, then the (slow) build runs as a job the
// frontend polls via GET /jobs/:id.
router.post("/", upload.single("image"), (req, res) => {
  const imagePath = req.file?.path;
  if (!imagePath) {
    return res.status(400).json({ error: "image dosyasi zorunludur" });
  }

  const extraPrompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  const proto = req.protocol;
  const host = req.get("host");
  const jobId = createJob();

  runJob(
    jobId,
    async () => {
      try {
        const result = await runBuildPipeline({
          generate: (correction) =>
            promptToFreecadCodeFromImage(imagePath, extraPrompt, correction),
          // No reliable text dimensions from an image; skip the dimension check.
          verifyPrompt: "",
        });

        if (!result.ok) {
          return {
            ok: false,
            body: {
              error: result.error,
              lastError: result.lastError,
              generatedCode: result.generatedCode,
            },
          };
        }

        return {
          ok: true,
          body: {
            stepPath: result.stepPath,
            stlPath: result.stlPath,
            stepUrl: makeFileUrl(proto, host, result.stepPath),
            stlUrl: makeFileUrl(proto, host, result.stlPath),
            bbox: result.bbox,
            warning: result.warning,
            generatedCode: result.generatedCode,
          },
        };
      } finally {
        fs.promises.unlink(imagePath).catch(() => {});
      }
    },
    { exclusive: true },
  );

  res.status(202).json({ jobId });
});

export default router;
