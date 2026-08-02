#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCommandPolicy } = require("../packages/daemon-core/command-policy.cjs");
const { createJobService } = require("../packages/daemon-core/job-service-resilient.cjs");
const { pidAlive, terminateProcessTree } = require("../packages/daemon-core/process-utils.cjs");

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

async function waitFor(fn, timeoutMs = 10_000, message = "Timed out waiting for condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function readWorkerState(root, jobId) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, ".jobs", jobId, "worker.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function processState(jobs, root, jobId) {
  const [job, workerState] = await Promise.all([
    jobs.get(jobId),
    readWorkerState(root, jobId),
  ]);
  const workerPid = Number(job.workerPid || job.pid || 0);
  const commandPid = Number(workerState?.commandPid || 0);
  return {
    job,
    workerPid,
    commandPid,
    workerAlive: pidAlive(workerPid),
    commandAlive: pidAlive(commandPid),
  };
}

async function waitForProcessesExit(jobs, root, jobId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await processState(jobs, root, jobId);
    if (!state.workerAlive && !state.commandAlive) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for Job processes to exit: job=${jobId} `
    + `workerPid=${state?.workerPid || "none"} workerAlive=${Boolean(state?.workerAlive)} `
    + `commandPid=${state?.commandPid || "none"} commandAlive=${Boolean(state?.commandAlive)}`,
  );
}

async function forceStopJobProcesses(jobs, root, jobId) {
  let state;
  try { state = await processState(jobs, root, jobId); }
  catch { return; }
  if (state.commandAlive) {
    await terminateProcessTree(state.commandPid, { forceAfterMs: 1000 }).catch(() => {});
  }
  if (state.workerAlive) {
    await terminateProcessTree(state.workerPid, { forceAfterMs: 1000 }).catch(() => {});
  }
  await waitForProcessesExit(jobs, root, jobId, 5000).catch(() => {});
}

async function removeTempTree(root) {
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 30 : 5,
    retryDelay: 100,
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-job-service-"));
  let jobs = null;
  const startedJobIds = [];
  try {
    const policy = createCommandPolicy({ allowExec: true });
    jobs = createJobService({
      jobsDir: path.join(root, ".jobs"),
      workspaceRoot: root,
      policy,
      maxConcurrency: 1,
      queueTimeoutMs: 500,
      defaultTimeoutMs: 5000,
    });

    if (process.platform !== "win32") {
      const instant = await jobs.start({ command: "printf instant-job-ok", cwd: root, clientId: "instant-test" });
      startedJobIds.push(instant.job.id);
      const instantCompleted = await waitFor(async () => {
        const job = await jobs.get(instant.job.id);
        return job.status === "completed" ? job : null;
      }, 10_000, "Timed out waiting for instant Job completion");
      assert.equal(instantCompleted.exitCode, 0);
      const instantLogs = await jobs.logs(instantCompleted.id, { maxBytes: 4096 });
      assert.equal(instantLogs.stdout.content, "instant-job-ok");
      assert.equal(instantLogs.stderr.content, "");
      await waitForProcessesExit(jobs, root, instantCompleted.id);
    }

    const script = path.join(root, "job.cjs");
    await fs.writeFile(script, "console.log('job-out'); console.error('job-err')\n", "utf8");
    const secret = "job-token-must-never-leak";
    const command = `${shellArg(process.execPath)} ${shellArg(script)} --api-key ${shellArg(secret)}`;

    const started = await jobs.start({ command, cwd: root, clientId: "test", idempotencyKey: "same-job" });
    startedJobIds.push(started.job.id);
    assert.equal(started.reused, false);
    assert.equal(started.job.commandPreview, "[REDACTED]");
    assert.equal(started.job.commandRedacted, true);
    assert.doesNotMatch(JSON.stringify(started), new RegExp(secret));

    const reused = await jobs.start({ command, cwd: root, clientId: "test", idempotencyKey: "same-job" });
    assert.equal(reused.reused, true);
    assert.equal(reused.job.id, started.job.id);
    assert.doesNotMatch(JSON.stringify(reused), new RegExp(secret));

    await assert.rejects(
      () => jobs.start({ command: `${command} different`, cwd: root, idempotencyKey: "same-job" }),
      (error) => error?.statusCode === 409 && error?.code === "EIDEMPOTENCY_CONFLICT",
    );

    const completed = await waitFor(async () => {
      const job = await jobs.get(started.job.id);
      return job.status === "completed" ? job : null;
    }, 10_000, "Timed out waiting for Job completion");
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.commandPreview, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(secret));

    const listed = await jobs.list({ limit: 10 });
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(secret));

    const logs = await jobs.logs(completed.id, { maxBytes: 4096 });
    assert.match(logs.stdout.content, /job-out/);
    assert.match(logs.stderr.content, /job-err/);
    assert.ok(logs.cursor);
    assert.doesNotMatch(JSON.stringify(logs.job), new RegExp(secret));

    const next = await jobs.logs(completed.id, { cursor: logs.cursor, maxBytes: 4096 });
    assert.equal(next.stdout.content, "");
    assert.equal(next.stderr.content, "");
    await waitForProcessesExit(jobs, root, completed.id);

    const longScript = path.join(root, "long.cjs");
    await fs.writeFile(longScript, "setInterval(() => {}, 1000)\n", "utf8");
    const running = await jobs.start({ command: `${shellArg(process.execPath)} ${shellArg(longScript)}`, cwd: root });
    startedJobIds.push(running.job.id);
    const cancelled = await jobs.cancel(running.job.id);
    assert.equal(cancelled.cancelled, true);
    assert.equal((await jobs.get(running.job.id)).status, "cancelled");
    await waitForProcessesExit(jobs, root, running.job.id);

    console.log("PASS job service including zero-delay completion, command redaction, and process-tree shutdown");
  } finally {
    if (jobs) {
      for (const jobId of [...new Set(startedJobIds)]) {
        await forceStopJobProcesses(jobs, root, jobId);
      }
    }
    await removeTempTree(root);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
