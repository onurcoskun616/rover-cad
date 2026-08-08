import { Router } from "express";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { getJob } from "../services/jobStore.js";

const router = Router();

router.use(apiKeyAuth);

// Poll a job started by one of the async POST routes. Responses:
//   { status: "pending" }                         -> keep polling
//   { status: "done", ok, ...body }               -> finished; body is the same
//                                                    payload the sync route used
//                                                    to return
//   { status: "error", error }                    -> the job threw
//   404 { status: "not_found" }                   -> unknown/expired job id
router.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ status: "not_found", error: "job not found" });
  }
  if (job.status === "pending") {
    const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
    return res.json({ status: "pending", elapsed });
  }
  if (job.status === "error") {
    return res.json({ status: "error", error: job.error });
  }
  const { ok, body } = job.result ?? { ok: false, body: {} };
  return res.json({ status: "done", ok, ...body });
});

export default router;
