import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { promptToFreecadCodeFromImage } from "../services/promptToCodeService.js";
import { runBuildPipeline } from "../services/buildPipeline.js";

function fileUrl(req, filePath) {
  if (!filePath) return null;
  return `${req.protocol}://${req.get("host")}/files/${path.basename(filePath)}`;
}

// Uploaded drawings are written to the OS temp dir with a random name and their
// original extension, then read by the claude CLI (Read tool) and deleted after
// the request finishes.
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

router.post("/", upload.single("image"), async (req, res, next) => {
  const imagePath = req.file?.path;
  try {
    if (!imagePath) {
      return res.status(400).json({ error: "image dosyasi zorunludur" });
    }

    const extraPrompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";

    const result = await runBuildPipeline({
      generate: (correction) =>
        promptToFreecadCodeFromImage(imagePath, extraPrompt, correction),
      // No reliable text dimensions from an image; skip the dimension check.
      verifyPrompt: "",
    });

    if (!result.ok) {
      return res.status(502).json({
        error: result.error,
        lastError: result.lastError,
        generatedCode: result.generatedCode,
      });
    }

    // CAM eligibility and the technical-drawing PDF are both produced on demand
    // (/generate-cam, /generate-pdf), so no extra FreeCAD round-trip here.
    res.json({
      stepPath: result.stepPath,
      stlPath: result.stlPath,
      stepUrl: fileUrl(req, result.stepPath),
      stlUrl: fileUrl(req, result.stlPath),
      bbox: result.bbox,
      warning: result.warning,
      generatedCode: result.generatedCode,
    });
  } catch (err) {
    next(err);
  } finally {
    if (imagePath) {
      fs.promises.unlink(imagePath).catch(() => {});
    }
  }
});

export default router;
