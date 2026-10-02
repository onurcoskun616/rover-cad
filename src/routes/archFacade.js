import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { apiKeyAuth } from "./apiKeyAuth.js";
import {
  archFacadeFromSheets,
  archFacadeFromText,
  detectAcaProxyObjects,
  ACA_EXPORT_HINT,
} from "../services/archFacadeService.js";
import { runBuildPipeline } from "../services/buildPipeline.js";
import { createJob, runJob } from "../services/jobStore.js";
import { archiveProjectBuildFailOpen } from "../services/projectArchiveService.js";
import { setLlmFeature } from "../services/llmRequestContext.js";

function makeFileUrl(proto, host, filePath) {
  if (!filePath) return null;
  return `${proto}://${host}/files/${path.basename(filePath)}`;
}

// Architectural sheets are bigger than a part drawing: a PDF of a plan plus an
// elevation at 1/50 runs to a few MB, and a render is often 4-8 MB.
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_FILES_PER_FIELD = 3;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".png";
    cb(null, `rover_arch_${randomUUID()}${ext}`);
  },
});

// Images and PDF are modellable (the Read tool opens both). DXF/DWG are accepted
// only so we can answer with a precise explanation instead of a generic
// "unsupported file" — see the CAD-file branch in the job below.
const CAD_EXTENSIONS = new Set([".dxf", ".dwg"]);

function isModellable(file) {
  return /^image\//.test(file.mimetype) || file.mimetype === "application/pdf";
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_FIELD * 3 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (isModellable(file) || CAD_EXTENSIONS.has(ext)) return cb(null, true);
    cb(
      new Error(
        "Sadece gorsel (PNG/JPG), PDF veya CAD (DXF/DWG) dosyalari yuklenebilir",
      ),
    );
  },
});

// Field name doubles as the sheet's role, so the model knows which drawing is
// the plan (depth, wall thickness) and which is the elevation (the window grid).
const FIELDS = [
  { name: "plan", role: "kat plani" },
  { name: "cephe", role: "on cephe gorunusu" },
  { name: "gorsel", role: "referans gorsel / render" },
];

const router = Router();

router.use(apiKeyAuth);

router.post("/", (req, res) => {
  upload.fields(FIELDS.map((f) => ({ name: f.name, maxCount: MAX_FILES_PER_FIELD })))(
    req,
    res,
    (err) => {
      if (err) {
        const msg =
          err.code === "LIMIT_FILE_SIZE"
            ? "Dosya cok buyuk (en fazla 30 MB)."
            : err.message || "Dosya yuklenemedi";
        return res.status(400).json({ error: msg });
      }

      const uploaded = [];
      for (const field of FIELDS) {
        for (const file of req.files?.[field.name] ?? []) {
          uploaded.push({ filePath: file.path, role: field.role, file });
        }
      }

      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      const sheets = uploaded.filter((s) => isModellable(s.file));
      const cadFiles = uploaded.filter((s) => !isModellable(s.file));

      // Nothing to work from at all.
      if (!sheets.length && !cadFiles.length && !prompt.trim()) {
        return res.status(400).json({
          error:
            "En az bir kat plani/cephe dosyasi yukleyin veya binayi yazili olarak tarif edin.",
        });
      }

      setLlmFeature(
        (prompt || "Mimari cepheden parametrik 3D model").replace(/\s+/g, " ").trim(),
      );

      const requestedProjectId = req.body?.projectId;
      const projectName = req.body?.projectName;
      const proto = req.protocol;
      const host = req.get("host");
      const userId = req.user?.id ?? null;
      const jobId = createJob();

      const cleanup = () =>
        Promise.all(
          uploaded.map((s) => fs.promises.unlink(s.filePath).catch(() => {})),
        );

      runJob(
        jobId,
        async () => {
          try {
            // A DXF/DWG on its own cannot be modelled here. Say exactly why and
            // what to do, and name the AEC objects when we can see them —
            // an AutoCAD Architecture project needs EXPORTTOAUTOCAD first or it
            // reaches any non-ACA reader empty.
            if (!sheets.length && cadFiles.length) {
              const detections = await Promise.all(
                cadFiles.map((c) => detectAcaProxyObjects(c.filePath)),
              );
              const aca = detections.find((d) => d.isAca);
              return {
                ok: false,
                body: {
                  error: aca
                    ? `${ACA_EXPORT_HINT} (Bulunan AEC nesneleri: ${aca.markers.join(", ")})`
                    : "CAD dosyasi bu sayfada dogrudan modellenemiyor. Kat planini ve on " +
                      "cepheyi PDF veya PNG olarak verin; bu sayfa gorsellerden model uretir.",
                  needsExport: true,
                  isAca: Boolean(aca),
                  acaMarkers: aca?.markers ?? [],
                },
              };
            }

            const result = await runBuildPipeline({
              generate: (correction) =>
                sheets.length
                  ? archFacadeFromSheets(sheets, prompt, correction)
                  : archFacadeFromText(prompt, correction),
              // Dimensions come from the drawings, not from the prompt text, so
              // there is nothing reliable to check the bounding box against.
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

            const archived = archiveProjectBuildFailOpen({
              userId,
              projectId: requestedProjectId,
              projectName,
              operation: "arch-facade",
              prompt: prompt || "Mimari cizimden olusturulan cephe projesi",
              generatedCode: result.generatedCode,
              stepPath: result.stepPath,
              stlPath: result.stlPath,
              bbox: result.bbox,
            });

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
                ...(archived ?? {}),
              },
            };
          } finally {
            await cleanup();
          }
        },
        { exclusive: true },
      );

      res.status(202).json({ jobId });
    },
  );
});

export default router;
