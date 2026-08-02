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
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-mcp-v3-"));
  const connections = path.join(temp, "connections.v3.json");
  const projects = path.join(temp, "projects.json");
  const state = path.join(temp, "state.json");
  let receivedKey = null;
  let sessionCreateBody = null;

  const daemon = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      if (req.url === "/healthz") return sendJson(res, 200, {
        ok: true,
        serverId: "mcp-server",
        workspaceId: "mcp-workspace",
        workspaceRoot: "/srv/projects",
        capabilities: { persistentJobs: true, developmentSessions: true },
      });
      if (req.url === "/api/exec/async") {
        receivedKey = req.headers["idempotency-key"];
        return sendJson(res, 200, { success: true, jobId: "mcp-job", taskId: "mcp-job", status: "running" });
      }
      if (req.url === "/api/dev/sessions" && req.method === "POST") {
        sessionCreateBody = body;
        return sendJson(res, 200, { success: true, session: { id: "session-1", projectName: body.projectName, worktreePath: "/srv/worktrees/session-1", status: "active" } });
      }
      if (req.url === "/api/dev/sessions/session-1") {
        return sendJson(res, 200, { success: true, session: { id: "session-1", status: "active", git: { branch: "agentport/demo/codex" } } });
      }
      if (req.url === "/api/dev/sessions/session-1/diff") {
        return sendJson(res, 200, { success: true, diff: "demo patch" });
      }
      return sendJson(res, 404, { error: `not found ${req.url}`, body });
    });
  });
  const port = await listen(daemon);

  await fs.writeFile(connections, JSON.stringify({
    defaultServer: "mcp-server",
    servers: [{
      id: "mcp-server",
      workspaceId: "mcp-workspace",
      endpoints: [{
        id: "mcp-daemon",
        type: "daemon",
        url: `http://127.0.0.1:${port}`,
        clientId: "mcp-client",
        authToken: "secret",
        priority: 1,
      }],
    }],
  }, null, 2));
  await fs.writeFile(projects, JSON.stringify({
    projects: {
      demo: {
        server: "mcp-server",
        root: "/srv/projects/demo",
        defaultBranch: "main",
        commands: { build: "npm run build" },
        agentRules: ["AGENTS.md"],
      },
    },
  }, null, 2));

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
      item.resolve(message);
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
      clientInfo: { name: "agentport-v3-test", version: "1.0" },
    });
    assert.equal(initialized.result.serverInfo.name, "agentport");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await request("tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("remote_project_run"));
    assert.ok(names.includes("remote_job_logs"));
    assert.ok(names.includes("remote_session_create"));
    assert.ok(names.includes("remote_session_merge"));
    const asyncTool = listed.result.tools.find((tool) => tool.name === "remote_exec_async");
    assert.ok(asyncTool.inputSchema.properties.idempotencyKey);

    const health = await request("tools/call", { name: "remote_health", arguments: { server: "mcp-server", force: true } });
    const healthData = JSON.parse(health.result.content[0].text);
    assert.equal(healthData.server, "mcp-server");
    assert.equal(healthData.endpoints[0].health.serverId, "mcp-server");

    const started = await request("tools/call", {
      name: "remote_exec_async",
      arguments: { server: "mcp-server", command: "echo test", idempotencyKey: "mcp:key:1" },
    });
    const startedData = JSON.parse(started.result.content[0].text);
    assert.equal(startedData.data.jobId, "mcp-job");
    assert.equal(startedData.meta.idempotencyKey, "mcp:key:1");
    assert.equal(receivedKey, "mcp:key:1");

    const created = await request("tools/call", {
      name: "remote_session_create",
      arguments: { project: "demo", agentId: "codex", task: "implement feature" },
    });
    const createdData = JSON.parse(created.result.content[0].text);
    assert.equal(createdData.data.session.id, "session-1");
    assert.equal(sessionCreateBody.projectRoot, "/srv/projects/demo");
    assert.equal(sessionCreateBody.commands.build, "npm run build");

    const status = await request("tools/call", {
      name: "remote_session_status",
      arguments: { sessionId: "session-1", server: "mcp-server" },
    });
    const statusData = JSON.parse(status.result.content[0].text);
    assert.equal(statusData.data.session.status, "active");

    const diff = await request("tools/call", {
      name: "remote_session_diff",
      arguments: { sessionId: "session-1", server: "mcp-server" },
    });
    const diffData = JSON.parse(diff.result.content[0].text);
    assert.equal(diffData.data.diff, "demo patch");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await close(daemon);
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log("PASS modular MCP tools, idempotent Jobs, and Worktree session calls");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
