import { Router } from "express";
import { ensureProfile, listUsage } from "../services/accountStore.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { googleOAuthUrl, loginWithSupabase, registerWithSupabase, requestPasswordReset } from "../services/supabaseAuth.js";
import { getUserProject, getUserProjectFilePath, listUserFiles, listUserProjects } from "../services/projectArchiveService.js";
const router = Router();

function validateCredentials(body, requiresName = false) {
  if (requiresName && !String(body.name ?? "").trim()) throw Object.assign(new Error("Ad soyad gereklidir"), { status: 400 });
  if (!/^\S+@\S+\.\S+$/.test(String(body.email ?? "").trim())) throw Object.assign(new Error("Geçerli bir e-posta gereklidir"), { status: 400 });
  if (String(body.password ?? "").length < 8) throw Object.assign(new Error("Parola en az 8 karakter olmalıdır"), { status: 400 });
}

router.post("/register", async (req, res, next) => {
  try {
    validateCredentials(req.body ?? {}, true);
    const payload = await registerWithSupabase(req.body ?? {});
    const authUser = payload.user;
    const user = authUser ? await ensureProfile(authUser) : null;
    res.status(201).json({
      token: payload.access_token ?? null,
      refreshToken: payload.refresh_token ?? null,
      user,
      emailVerificationRequired: !payload.access_token,
    });
  } catch (error) { next(error); }
});

router.post("/login", async (req, res, next) => {
  try {
    validateCredentials(req.body ?? {});
    const payload = await loginWithSupabase(req.body ?? {});
    const user = await ensureProfile(payload.user);
    res.json({ token: payload.access_token, refreshToken: payload.refresh_token, user });
  } catch (error) { next(error); }
});

router.post("/recover", async (req, res, next) => {
  try {
    if (!/^\S+@\S+\.\S+$/.test(String(req.body?.email ?? "").trim())) throw Object.assign(new Error("Şifre sıfırlama için geçerli bir e-posta yazın"), { status: 400 });
    await requestPasswordReset(req.body ?? {});
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get("/oauth/google", (req, res, next) => {
  try { res.json({ url: googleOAuthUrl(req.query.redirectTo) }); } catch (error) { next(error); }
});
router.get("/me", apiKeyAuth, (req, res) => res.json({ user: req.user }));
router.get("/usage", apiKeyAuth, async (req, res, next) => {
  try { res.json({ usage: await listUsage(req.user.id) }); } catch (error) { next(error); }
});
router.get("/projects", apiKeyAuth, (req, res, next) => {
  try { res.json({ projects: listUserProjects(req.user.id, req.query.limit) }); } catch (error) { next(error); }
});
router.get("/projects/:projectId", apiKeyAuth, (req, res, next) => {
  try { res.json({ project: getUserProject(req.user.id, req.params.projectId, req.protocol, req.get("host"), req.query.versionId) }); } catch (error) { next(error); }
});
router.get("/projects/:projectId/files/*", apiKeyAuth, (req, res, next) => {
  try { res.download(getUserProjectFilePath(req.user.id, req.params.projectId, req.params[0])); } catch (error) { next(error); }
});
router.get("/files", apiKeyAuth, (req, res, next) => {
  try { res.json({ files: listUserFiles(req.user.id, req.query.limit) }); } catch (error) { next(error); }
});
export default router;
