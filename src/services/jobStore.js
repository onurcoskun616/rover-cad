import { randomUUID } from "node:crypto";

// In-memory async job store. Long operations (model build, CAM, PDF) can take
// well over Cloudflare's 100s edge timeout, which drops the connection (524) and
// surfaces as "Failed to fetch" in the browser. Instead of holding one long HTTP
// request open, the POST routes start a job and return a jobId immediately; the
// frontend then polls GET /jobs/:id with short requests until it finishes.
const jobs = new Map();

// How long a finished job's result stays retrievable before cleanup.
const RESULT_TTL_MS = 30 * 60 * 1000;

// FreeCAD's MCP server is a single connection with one shared document, so two
// overlapping FreeCAD jobs would corrupt each other. Exclusive jobs are chained
// through this promise so only one runs at a time.
let lockChain = Promise.resolve();

export function createJob() {
  const id = randomUUID();
  jobs.set(id, {
    status: "pending",
    createdAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  });
  return id;
}

/**
 * Run `fn` asynchronously and record its outcome on the job. `fn` should resolve
 * to the value stored as the job result. Errors are captured on the job, never
 * thrown to the caller (this is fire-and-forget).
 * @param {string} id job id from createJob()
 * @param {() => Promise<any>} fn
 * @param {{exclusive?: boolean}} [opts] exclusive jobs are serialized globally
 */
export function runJob(id, fn, { exclusive = false } = {}) {
  const execute = async () => {
    try {
      const result = await fn();
      const job = jobs.get(id);
      if (job) {
        job.status = "done";
        job.result = result;
        job.finishedAt = Date.now();
      }
    } catch (err) {
      const job = jobs.get(id);
      if (job) {
        job.status = "error";
        job.error = err?.message ?? String(err);
        job.finishedAt = Date.now();
      }
    }
  };

  if (exclusive) {
    // Chain onto the lock regardless of whether the previous job resolved or
    // rejected, so one failure doesn't stall the queue.
    lockChain = lockChain.then(execute, execute);
  } else {
    execute();
  }
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

// Periodically drop old finished jobs so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > RESULT_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();
