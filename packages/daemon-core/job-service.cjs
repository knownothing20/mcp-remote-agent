const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createWorkspacePathGuard } = require("./path-guard.cjs");
const { createJobId, createJobStore, nowIso } = require("./job-store.cjs");
const { createKeyLock } = require("./key-lock.cjs");
const { pidAlive, terminateProcessTree } = require("./process-utils.cjs");

function intValue(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function jobError(message, code, statusCode = 500, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function fingerprint(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function publicJob(job) {
  const { command, env, ...rest } = job;
  return {
    ...rest,
    commandPreview: typeof command === "string" ? command.slice(0, 300) : "",
    processAlive: pidAlive(job.workerPid || job.pid),
  };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return { stdout: 0, stderr: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    return {
      stdout: Math.max(0, Number(parsed.stdout) || 0),
      stderr: Math.max(0, Number(parsed.stderr) || 0),
    };
  } catch {
    throw jobError("Invalid log cursor", "ECURSOR", 400);
  }
}

async function readLogChunk(filePath, offset, maxBytes) {
  let stat;
  try { stat = await fs.stat(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return { content: "", size: 0, offset: 0, nextOffset: 0, truncated: false };
    throw error;
  }
  const start = Math.min(Math.max(0, Number(offset) || 0), stat.size);
  const length = Math.min(maxBytes, Math.max(0, stat.size - start));
  if (length <= 0) return { content: "", size: stat.size, offset: start, nextOffset: start, truncated: false };
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return {
      content: buffer.subarray(0, result.bytesRead).toString("utf8"),
      size: stat.size,
      offset: start,
      nextOffset: start + result.bytesRead,
      truncated: start + result.bytesRead < stat.size,
    };
  } finally {
    await handle.close();
  }
}

async function readTail(filePath, maxBytes) {
  let stat;
  try { stat = await fs.stat(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return { content: "", size: 0, offset: 0, nextOffset: 0, truncated: false };
    throw error;
  }
  const start = Math.max(0, stat.size - maxBytes);
  const result = await readLogChunk(filePath, start, maxBytes);
  return { ...result, truncated: start > 0 || result.truncated };
}

function createJobService({
  jobsDir,
  workspaceRoot,
  workspaceScope,
  policy,
  workerPath = path.join(__dirname, "job-worker.cjs"),
  maxConcurrency = 2,
  queueTimeoutMs = 15_000,
  defaultTimeoutMs = 30 * 60_000,
  maxTimeoutMs = 7 * 24 * 60 * 60_000,
  logChunkBytes = 64 * 1024,
} = {}) {
  if (!jobsDir) throw new TypeError("jobsDir is required");
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");
  if (!policy) throw new TypeError("policy is required");
  const pathGuard = createWorkspacePathGuard(workspaceScope || { workspaceRoot });
  const store = createJobStore({ jobsDir });
  const startLock = createKeyLock();
  const maxJobs = intValue(maxConcurrency, 2, 1, 64);
  const waitTimeout = intValue(queueTimeoutMs, 15_000, 0, 10 * 60_000);
  const defaultJobTimeout = intValue(defaultTimeoutMs, 30 * 60_000, 0, maxTimeoutMs);
  const maxJobTimeout = intValue(maxTimeoutMs, 7 * 24 * 60 * 60_000, 1000, 30 * 24 * 60 * 60_000);
  const defaultChunk = intValue(logChunkBytes, 64 * 1024, 1024, 5 * 1024 * 1024);

  async function resolveCwd(input) {
    return (await pathGuard.resolve(input || ".", { mustExist: true })).realPath;
  }

  function timeoutValue(value) {
    const timeout = intValue(value, defaultJobTimeout, 0, maxJobTimeout);
    if (timeout > 0 && timeout < 1000) throw jobError("timeoutMs must be 0 or at least 1000", "EINVAL", 400);
    return timeout;
  }

  async function reconcile(job) {
    const result = await store.readResult(job.id);
    if (result) {
      const nextStatus = result.status || (result.exitCode === 0 ? "completed" : "error");
      if (job.status !== nextStatus || !job.finishedAt) {
        return store.update(job.id, {
          status: nextStatus,
          exitCode: result.exitCode ?? null,
          signal: result.signal || null,
          timedOut: Boolean(result.timedOut),
          cancelled: Boolean(result.cancelled),
          error: result.error || null,
          finishedAt: result.finishedAt || nowIso(),
        });
      }
      return job;
    }
    if (["running", "starting", "cancelling"].includes(job.status)) {
      if (pidAlive(job.workerPid || job.pid)) return job;
      return store.update(job.id, { status: "orphaned", finishedAt: job.finishedAt || nowIso() });
    }
    return job;
  }

  async function list(options = {}) {
    const jobs = await store.list({ limit: options.limit || 50 });
    const out = [];
    for (const job of jobs) {
      const current = await reconcile(job);
      if (!options.status || current.status === options.status) out.push(publicJob(current));
    }
    return out;
  }

  async function activeCount() {
    const jobs = await store.list({ limit: 500 });
    let active = 0;
    for (const job of jobs) {
      const current = await reconcile(job);
      if (["running", "starting", "cancelling"].includes(current.status)) active += 1;
    }
    return active;
  }

  async function waitForSlot(timeoutMs = waitTimeout) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const active = await activeCount();
      if (active < maxJobs) return { active, max: maxJobs };
      if (timeoutMs <= 0 || Date.now() >= deadline) {
        throw jobError("Too many concurrent jobs", "EJOB_QUEUE", 429, {
          jobQueue: { active, max: maxJobs, queueTimeoutMs: timeoutMs },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function spawnJob(job) {
    const child = spawn(process.execPath, [workerPath, store.paths.jobDir(job.id)], {
      cwd: job.cwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, AGENTPORT_JOB_ID: job.id },
    });
    child.unref();
    if (!child.pid) throw jobError("Failed to start job worker", "EJOB_SPAWN", 500);
    return store.update(job.id, { status: "running", workerPid: child.pid, startedAt: nowIso() });
  }

  async function createAndStart(input) {
    policy.validateCommand(input.command);
    const cwd = input.cwd;
    const timeoutMs = timeoutValue(input.timeoutMs);
    const id = createJobId();
    const job = await store.create({
      id,
      command: input.command.trim(),
      cwd,
      clientId: input.clientId || "unknown",
      connection: input.connection || null,
      idempotencyKeyHash: input.idempotencyKey
        ? crypto.createHash("sha256").update(String(input.idempotencyKey)).digest("hex")
        : null,
      fingerprint: input.fingerprint,
      resourceClass: input.resourceClass || "default",
      timeoutMs,
      status: "starting",
      workerPid: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      finishedAt: null,
    });
    if (input.idempotencyKey) {
      await store.writeIdempotency(input.idempotencyKey, {
        jobId: job.id,
        fingerprint: input.fingerprint,
        createdAt: job.createdAt,
      });
    }
    try {
      return await spawnJob(job);
    } catch (error) {
      await store.update(job.id, { status: "error", error: error.message, finishedAt: nowIso() }).catch(() => {});
      throw error;
    }
  }

  async function start(input = {}) {
    const command = typeof input.command === "string" ? input.command : "";
    policy.validateCommand(command);
    const cwd = await resolveCwd(input.cwd);
    const timeoutMs = timeoutValue(input.timeoutMs);
    const payloadFingerprint = fingerprint({
      command: command.trim(),
      cwd,
      timeoutMs,
      resourceClass: input.resourceClass || "default",
    });
    const idempotencyKey = String(input.idempotencyKey || "").trim();

    const run = async () => startLock.withLock("job-start", async () => {
      await waitForSlot(
        input.queueTimeoutMs === undefined
          ? waitTimeout
          : intValue(input.queueTimeoutMs, waitTimeout, 0, 10 * 60_000),
      );
      return createAndStart({
        ...input,
        command,
        cwd,
        timeoutMs,
        fingerprint: payloadFingerprint,
        idempotencyKey,
      });
    });

    if (!idempotencyKey) return { job: await run(), reused: false };
    return store.withIdempotencyLock(idempotencyKey, async () => {
      const existing = await store.readIdempotency(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== payloadFingerprint) {
          throw jobError(
            "Idempotency key already used with different job parameters",
            "EIDEMPOTENCY_CONFLICT",
            409,
            { jobId: existing.jobId },
          );
        }
        try {
          const job = await reconcile(await store.read(existing.jobId));
          return { job, reused: true };
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await store.removeIdempotency(idempotencyKey);
        }
      }
      return { job: await run(), reused: false };
    });
  }

  async function get(jobId) {
    return publicJob(await reconcile(await store.read(jobId)));
  }

  async function logs(jobId, options = {}) {
    const job = await reconcile(await store.read(jobId));
    const maxBytes = intValue(
      options.maxBytes || options.tailBytes,
      defaultChunk,
      1024,
      5 * 1024 * 1024,
    );
    let stdout;
    let stderr;
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      [stdout, stderr] = await Promise.all([
        readLogChunk(job.stdoutPath || store.paths.stdoutPath(jobId), cursor.stdout, maxBytes),
        readLogChunk(job.stderrPath || store.paths.stderrPath(jobId), cursor.stderr, maxBytes),
      ]);
    } else if (options.tailBytes) {
      [stdout, stderr] = await Promise.all([
        readTail(job.stdoutPath || store.paths.stdoutPath(jobId), maxBytes),
        readTail(job.stderrPath || store.paths.stderrPath(jobId), maxBytes),
      ]);
    } else {
      [stdout, stderr] = await Promise.all([
        readLogChunk(job.stdoutPath || store.paths.stdoutPath(jobId), 0, maxBytes),
        readLogChunk(job.stderrPath || store.paths.stderrPath(jobId), 0, maxBytes),
      ]);
    }
    const nextCursor = encodeCursor({ stdout: stdout.nextOffset, stderr: stderr.nextOffset });
    return {
      job: publicJob(job),
      stdout,
      stderr,
      cursor: nextCursor,
      done:
        !["running", "starting", "cancelling"].includes(job.status)
        && !stdout.truncated
        && !stderr.truncated,
    };
  }

  async function cancel(jobId) {
    let job = await reconcile(await store.read(jobId));
    if (!["running", "starting", "cancelling"].includes(job.status)) {
      return { cancelled: false, alreadyFinished: true, job: publicJob(job) };
    }
    job = await store.update(jobId, { status: "cancelling", cancelRequestedAt: nowIso() });
    const activePid = job.workerPid || job.pid;
    if (pidAlive(activePid)) {
      try { process.kill(activePid, "SIGTERM"); } catch {}
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await store.readResult(jobId);
        if (result || !pidAlive(activePid)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (pidAlive(activePid)) {
        await terminateProcessTree(activePid, { forceAfterMs: 1000 });
      }
    }
    if (!(await store.readResult(jobId))) {
      await store.writeResult(jobId, {
        status: "cancelled",
        exitCode: null,
        signal: "SIGTERM",
        cancelled: true,
        timedOut: false,
      });
    }
    job = await reconcile(await store.read(jobId));
    return { cancelled: true, job: publicJob(job) };
  }

  async function remove(jobId) {
    const job = await reconcile(await store.read(jobId));
    if (
      ["running", "starting", "cancelling"].includes(job.status)
      && pidAlive(job.workerPid || job.pid)
    ) {
      throw jobError("Job is running. Cancel it before delete.", "EJOB_RUNNING", 409);
    }
    await store.remove(jobId);
    return { deleted: true, jobId, previousStatus: job.status };
  }

  function stats() {
    return {
      maxConcurrency: maxJobs,
      queueTimeoutMs: waitTimeout,
      jobsDir: store.root,
      logChunkBytes: defaultChunk,
    };
  }

  return Object.freeze({
    start,
    get,
    list,
    logs,
    cancel,
    remove,
    reconcile,
    stats,
    publicJob,
  });
}

module.exports = {
  createJobService,
  decodeCursor,
  encodeCursor,
  fingerprint,
  jobError,
  publicJob,
  readLogChunk,
};
