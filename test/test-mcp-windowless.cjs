#!/usr/bin/env node

const assert = require("assert");
const { execFileSync, spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const REMOTE = process.argv.includes("--remote");
const CONNECTION_ARG = process.argv.find((arg) => arg.startsWith("--connection="));
const CONNECTION = CONNECTION_ARG ? CONNECTION_ARG.slice("--connection=".length) : "183-agentport-daemon";
const LAUNCHER = path.join(process.env.USERPROFILE || "", ".codex", "bin", "hidden-stdio-launcher-v3.exe");
const ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(ROOT, "index.js");

function terminalCount() {
  if (process.platform !== "win32") return 0;
  const output = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq WindowsTerminal.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return output.split(/\r?\n/).filter((line) => /^"WindowsTerminal\.exe"/i.test(line.trim())).length;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const before = terminalCount();
  const child = spawn(LAUNCHER, [process.execPath, INDEX], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 1;
  const stderr = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      item.resolve(message);
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));

  function send(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
    });
  }

  const initialized = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agentport-windowless-test", version: "1.0" },
  });
  assert.strictEqual(initialized.result.serverInfo.name, "agentport");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = await send("tools/list", {});
  const names = tools.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("remote_script_async"));
  assert.ok(names.includes("remote_exec_async"));

  let taskResult = null;
  if (REMOTE) {
    const started = await send("tools/call", {
      name: "remote_script_async",
      arguments: {
        connection: CONNECTION,
        content: "printf 'mcp-windowless-start\\n'\nsleep 1\nprintf 'mcp-windowless-complete\\n'\n",
        interpreter: "bash",
        cwd: "/home/YOUR_USER/.openclaw",
        timeoutMs: 60000,
      },
    });
    const startText = started.result.content[0].text;
    let startData;
    try { startData = JSON.parse(startText); } catch { throw new Error(startText); }
    assert.ok(startData.taskId, started.result.content[0].text);
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(250);
      const status = await send("tools/call", {
        name: "remote_task",
        arguments: { connection: CONNECTION, taskId: startData.taskId },
      });
      taskResult = JSON.parse(status.result.content[0].text);
      if (["completed", "failed", "canceled"].includes(taskResult.status)) break;
    }
    assert.strictEqual(taskResult.status, "completed", JSON.stringify(taskResult));
    assert.match(taskResult.stdout, /mcp-windowless-complete/);
  }

  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  const after = terminalCount();
  assert.strictEqual(after, before, `WindowsTerminal count changed: ${before} -> ${after}`);
  const transportRetries = stderr.filter((line) => /ECONNRESET|Retrying/.test(line));
  assert.strictEqual(transportRetries.length, 0, transportRetries.join("\n"));
  console.log(JSON.stringify({
    ok: true,
    tools: names.length,
    remoteScriptAsync: names.includes("remote_script_async"),
    remoteStatus: taskResult?.status || "not-run",
    terminalCountBefore: before,
    terminalCountAfter: after,
    stderrLines: stderr.length,
    transportRetries: transportRetries.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
