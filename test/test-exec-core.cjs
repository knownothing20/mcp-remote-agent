#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCommandPolicy } = require("../packages/daemon-core/command-policy.cjs");
const { createExecutionQueue } = require("../packages/daemon-core/execution-queue.cjs");
const { createExecService } = require("../packages/daemon-core/exec-service.cjs");

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-exec-core-"));
  try {
    const disabled = createCommandPolicy({ allowExec: false });
    assert.throws(() => disabled.validateCommand("echo no"), (error) => error?.statusCode === 403);

    const allowlist = createCommandPolicy({ allowedCommands: ["git"] });
    assert.throws(
      () => allowlist.validateCommand("git status && echo bypass"),
      (error) => error?.code === "ECOMMAND_POLICY",
    );

    const policy = createCommandPolicy({ allowExec: true });
    const queue = createExecutionQueue({ maxConcurrency: 1, queueTimeoutMs: 100 });
    const exec = createExecService({ workspaceRoot: root, policy, queue, defaultTimeoutMs: 5000 });

    const commandFile = path.join(root, "command.cjs");
    await fs.writeFile(commandFile, "process.stdout.write('exec-ok')\n", "utf8");
    const result = await exec.execute(`${shellArg(process.execPath)} ${shellArg(commandFile)}`, { cwd: root });
    assert.equal(result.stdout, "exec-ok");

    const script = await exec.executeScript("process.stdout.write('script-ok')", {
      interpreter: process.execPath,
      cwd: root,
    });
    assert.equal(script.stdout, "script-ok");

    const queueRelease = await queue.acquire();
    await assert.rejects(
      () => queue.acquire({ timeoutMs: 20 }),
      (error) => error?.statusCode === 429 && error?.code === "EEXEC_QUEUE",
    );
    queueRelease();

    console.log("PASS exec core");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
