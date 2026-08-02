import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { runImportAndExport } from "../services/exportService.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_EXT = new Set([".step", ".stp", ".iges", ".igs"]);

// Uploaded CAD files are written to the OS temp dir with a random name and their
// original extension, then imported by FreeCAD and deleted when the job finishes.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".step";
    cb(null, `rover_step_${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error("Sadece STEP/IGES dosyalari yuklenebilir (.step, .stp, .iges, .igs)"));
  },
});

// Content sniff: don't trust the extension alone. STEP files begin with the
// ISO-10303-21 header; IGES files are 80-column records whose section letter
// (S/G/D/P/T) sits in column 73. This blocks a renamed/fake file from reaching
// FreeCAD (which then also rejects anything that slips through).
function looksLikeCad(headText, ext) {
  if (ext === ".step" || ext === ".stp") {
    return headText.includes("ISO-10303-21");
  }
  if (ext === ".iges" || ext === ".igs") {
    return headText
      .split(/\r?\n/)
      .some((line) => line.length >= 73 && "SGDPT".includes(line[72]));
  }
  return false;
}

const router = Router();

// Wrap multer so its errors (size limit, wrong extension) become clean JSON
// instead of a 500. Auth runs first so unauthorized requests never hit multer.
router.post("/", apiKeyAuth, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "Dosya cok buyuk (en fazla 50 MB)."
          : err.message || "Dosya yuklenemedi";
      return res.status(400).json({ error: msg });
    }

    const uploadedPath = req.file?.path;
    if (!uploadedPath) {
      return res.status(400).json({ error: "file dosyasi zorunludur" });
    }

    const ext = path.extname(uploadedPath).toLowerCase();
    const proto = req.protocol;
    const host = req.get("host");
    const jobId = createJob();

    runJob(
      jobId,
      async () => {
        try {
          let head = "";
          try {
            const fd = await fs.promises.open(uploadedPath, "r");
            const buf = Buffer.alloc(8192);
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            await fd.close();
            head = buf.slice(0, bytesRead).toString("latin1");
          } catch {
            head = "";
          }
          if (!looksLikeCad(head, ext)) {
            return {
              ok: false,
              body: { error: "Dosya icerigi gecerli bir STEP/IGES dosyasina benzemiyor." },
            };
          }

          const result = await runImportAndExport(uploadedPath);
          if (!result.ok) {
            return { ok: false, body: { error: result.error } };
          }
          return {
            ok: true,
            body: {
              stepPath: result.stepPath,
              stlPath: result.stlPath,
              stepUrl: makeFileUrl(proto, host, result.stepPath),
              stlUrl: makeFileUrl(proto, host, result.stlPath),
              bbox: result.bbox,
            },
          };
        } finally {
          fs.promises.unlink(uploadedPath).catch(() => {});
        }
      },
      { exclusive: true },
    );

    res.status(202).json({ jobId });
  });
});

export default router;
