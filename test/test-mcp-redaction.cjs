#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.resolve(__dirname, "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

async function main() {
  const secret = "mcp-secret-must-never-appear";
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-mcp-redaction-"));
  const connections = path.join(temp, "connections.v3.json");
  const projects = path.join(temp, "projects.json");
  const state = path.join(temp, "state.json");

  const daemon = http.createServer((_req, res) => {
    const payload = Buffer.from(JSON.stringify({
      ok: true,
      serverId: "secure-server",
      workspaceId: "secure-workspace",
      workspaceRoot: temp,
    }));
    res.writeHead(200, { "content-type": "application/json", "content-length": payload.length });
    res.end(payload);
  });
  const port = await listen(daemon);

  await fs.writeFile(connections, JSON.stringify({
    defaultServer: "secure-server",
    servers: [{
      id: "secure-server",
      workspaceId: "secure-workspace",
      endpoints: [{
        id: "secure-lan",
        type: "daemon",
        url: `http://127.0.0.1:${port}`,
        clientId: "secure-client",
        authToken: secret,
      }],
    }],
  }, null, 2));
  await fs.writeFile(projects, JSON.stringify({ projects: {} }));

  const child = spawn(process.execPath, [path.join(ROOT, "client", "mcp-entry.js")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPORT_CLIENT_MODE: "v3",
      MCP_REMOTE_V3_CONNECTIONS_PATH: connections,
      AGENTPORT_PROJECTS_PATH: projects,
      AGENTPORT_CLIENT_STATE_PATH: state,
    },
  });
  const pending = new Map();
  const stderr = [];
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      item.resolve({ message, raw: line });
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));

  function request(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}\n${stderr.join("\n")}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
    });
  }

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "redaction-test", version: "1.0" },
    });
    assert.equal(initialized.message.result.serverInfo.name, "agentport");
    assert.equal(initialized.message.result.serverInfo.version, "3.1.0");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const health = await request("tools/call", {
      name: "remote_health",
      arguments: { server: "secure-server", force: true },
    });
    assert.doesNotMatch(health.raw, new RegExp(secret));
    assert.match(health.raw, /REDACTED/);
    const data = JSON.parse(health.message.result.content[0].text);
    assert.equal(data.endpoints[0].endpoint.authToken, "[REDACTED]");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await close(daemon);
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log("PASS MCP credential redaction and version alignment");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
