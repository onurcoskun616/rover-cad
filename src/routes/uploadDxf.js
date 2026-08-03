import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { runImportDxfAndExport } from "../services/exportService.js";
import { createJob, runJob } from "../services/jobStore.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".dxf";
    cb(null, `rover_dxf_${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === ".dxf") return cb(null, true);
    cb(new Error("Sadece DXF dosyalari yuklenebilir (.dxf)"));
  },
});

// Content sniff: ASCII DXF is made of group-code sections (SECTION + a known
// section name); binary DXF starts with a fixed sentinel. This blocks a
// renamed/fake file before FreeCAD sees it (FreeCAD then rejects the rest).
function looksLikeDxf(headText) {
  if (headText.startsWith("AutoCAD Binary DXF")) return true;
  return (
    headText.includes("SECTION") &&
    /\b(HEADER|TABLES|ENTITIES|BLOCKS)\b/.test(headText)
  );
}

const router = Router();

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

    // Sheet thickness (mm). Blank/0 => 2D contours only (laser/plasma cut).
    const thickness = Number(req.body?.thickness) > 0 ? Number(req.body.thickness) : 0;
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
          if (!looksLikeDxf(head)) {
            return {
              ok: false,
              body: { error: "Dosya icerigi gecerli bir DXF dosyasina benzemiyor." },
            };
          }

          const result = await runImportDxfAndExport(uploadedPath, thickness);
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
              contourUrl: makeFileUrl(proto, host, result.contourPath),
              twoD: result.twoD,
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
