const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createWorkspacePathGuard } = require("./path-guard.cjs");
const { terminateProcessTree } = require("./process-utils.cjs");

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function executionError(message, code, statusCode = 500, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function createExecService({
  workspaceRoot,
  workspaceScope,
  policy,
  queue,
  defaultTimeoutMs = 120_000,
  maxTimeoutMs = 24 * 60 * 60 * 1000,
  maxBufferBytes = 10 * 1024 * 1024,
  tempDir = os.tmpdir(),
} = {}) {
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");
  if (!policy) throw new TypeError("policy is required");
  if (!queue) throw new TypeError("queue is required");
  const pathGuard = createWorkspacePathGuard(workspaceScope || { workspaceRoot });

  async function resolveCwd(input) {
    return (await pathGuard.resolve(input || ".", { mustExist: true })).realPath;
  }

  function timeoutValue(value) {
    const parsed = integer(value, defaultTimeoutMs, 0, maxTimeoutMs);
    if (parsed > 0 && parsed < 1000) throw executionError("timeoutMs must be 0 or at least 1000", "EINVAL", 400);
    return parsed;
  }

  async function runProcess(command, args, options = {}) {
    const timeoutMs = timeoutValue(options.timeoutMs);
    const maxBytes = integer(options.maxBufferBytes, maxBufferBytes, 1024, 100 * 1024 * 1024);
    const cwd = await resolveCwd(options.cwd);

    return queue.run(() => new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: Boolean(options.shell),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(options.env || {}) },
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let timer = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };

      const append = (current, chunk, streamName) => {
        const next = Buffer.concat([current, Buffer.from(chunk)]);
        if (next.length > maxBytes) {
          const error = executionError(
            `${streamName} exceeded maxBufferBytes ${maxBytes}`,
            "EOUTPUT_LIMIT",
            413,
            { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") },
          );
          finish(reject, error);
          terminateProcessTree(child.pid, { forceAfterMs: 500 }).catch(() => {});
          return current;
        }
        return next;
      };

      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
      child.once("error", (error) => finish(reject, executionError(error.message, error.code || "ESPAWN", 500, { cause: error })));
      child.once("close", (code, signal) => {
        const payload = {
          success: code === 0,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          code: typeof code === "number" ? code : null,
          signal: signal || null,
          cwd,
        };
        if (code === 0) finish(resolve, payload);
        else finish(reject, executionError(`Command exited with code ${code}`, "EEXEC", 200, payload));
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = executionError(`Command timed out after ${timeoutMs}ms`, "ETIMEDOUT", 200, {
            timeoutMs,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            code: null,
          });
          finish(reject, error);
          terminateProcessTree(child.pid, { forceAfterMs: 1000 }).catch(() => {});
        }, timeoutMs);
        timer.unref?.();
      }
    }), { timeoutMs: options.queueTimeoutMs });
  }

  async function execute(command, options = {}) {
    policy.validateCommand(command);
    return runProcess(command, [], { ...options, shell: true });
  }

  async function executeScript(content, options = {}) {
    if (typeof content !== "string" || !content.trim()) {
      throw executionError("content is required", "EINVAL", 400);
    }
    const validated = policy.validateInterpreter(options.interpreter || "bash");
    await fs.mkdir(tempDir, { recursive: true });
    const extension = validated.base.startsWith("python") ? "py" : validated.base.startsWith("node") ? "js" : "script";
    const filePath = path.join(tempDir, `agentport-script-${process.pid}-${crypto.randomBytes(8).toString("hex")}.${extension}`);
    try {
      await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o700, flag: "wx" });
      return await runProcess(validated.interpreter, [filePath], { ...options, shell: false });
    } finally {
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
  }

  return Object.freeze({ execute, executeScript, queueStats: queue.stats, resolveCwd });
}

module.exports = { createExecService, executionError };
