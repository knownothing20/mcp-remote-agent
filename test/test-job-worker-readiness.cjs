#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCommandPolicy } = require("../packages/daemon-core/command-policy.cjs");
const { createJobService } = require("../packages/daemon-core/job-service-resilient.cjs");

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

async function waitFor(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for job completion");
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-worker-ready-"));
  const policy = createCommandPolicy({ allowExec: true });
  try {
    const realJobs = createJobService({
      jobsDir: path.join(root, "jobs-real"),
      workspaceRoot: root,
      policy,
      workerReadyTimeoutMs: 3000,
      defaultTimeoutMs: 5000,
    });
    const script = path.join(root, "ok.cjs");
    await fs.writeFile(script, "console.log('ready-ok')\n", "utf8");
    const started = await realJobs.start({
      command: `${shellArg(process.execPath)} ${shellArg(script)}`,
      cwd: root,
    });
    assert.ok(["running", "completed"].includes(started.job.status));
    const completed = await waitFor(async () => {
      const job = await realJobs.get(started.job.id);
      return job.status === "completed" ? job : null;
    });
    assert.equal(completed.exitCode, 0);
    const workerState = JSON.parse(await fs.readFile(path.join(root, "jobs-real", completed.id, "worker.json"), "utf8"));
    assert.equal(workerState.phase, "finished");
    assert.equal(workerState.resultWritten, true);

    const badWorker = path.join(root, "bad-worker.cjs");
    await fs.writeFile(badWorker, "process.exit(7)\n", "utf8");
    const badJobs = createJobService({
      jobsDir: path.join(root, "jobs-bad"),
      workspaceRoot: root,
      policy,
      workerPath: badWorker,
      workerReadyTimeoutMs: 1500,
    });

    let startupError = null;
    try {
      await badJobs.start({ command: "echo never-runs", cwd: root });
    } catch (error) {
      startupError = error;
    }
    assert.ok(startupError);
    assert.equal(startupError.code, "EJOB_WORKER_START");
    assert.ok(startupError.jobId);
    const failed = await badJobs.get(startupError.jobId);
    assert.equal(failed.status, "error");
    assert.match(failed.orphanReason, /exited before readiness|did not become ready/);
    assert.notEqual(failed.status, "orphaned");
    const result = JSON.parse(await fs.readFile(path.join(root, "jobs-bad", failed.id, "result.json"), "utf8"));
    assert.equal(result.status, "error");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log("PASS worker readiness, durable result, and early-exit diagnostics");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
