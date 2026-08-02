const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-client-v3-"));
  const statePath = path.join(root, "state.json");
  const connectionsPath = path.join(root, "connections.v3.json");
  const projectsPath = path.join(root, "projects.json");
  let asyncAttempts = 0;
  let idempotencyKey = null;

  const daemon = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      if (req.url === "/healthz") return json(res, 200, {
        ok: true,
        serverId: "srv-main",
        workspaceId: "workspace-main",
        workspaceRoot: "/srv/projects",
        capabilities: { persistentJobs: true },
      });
      if (req.url === "/api/fs/read") return json(res, 200, { success: true, content: `read:${body.path}`, etag: "etag-1" });
      if (req.url === "/api/exec/script") return json(res, 200, { success: true, stdout: `cwd=${body.cwd}`, stderr: "", code: 0 });
      if (req.url === "/api/exec/async") {
        asyncAttempts += 1;
        idempotencyKey = req.headers["idempotency-key"];
        if (asyncAttempts === 1) {
          req.socket.destroy();
          return;
        }
        return json(res, 200, { success: true, jobId: "job-1", taskId: "job-1", status: "running", reused: true });
      }
      if (req.url.startsWith("/api/jobs/job-1/logs")) return json(res, 200, {
        success: true,
        stdout: { content: "new-log\n", nextOffset: 8 },
        stderr: { content: "", nextOffset: 0 },
        cursor: "cursor-2",
      });
      if (req.url === "/api/jobs/job-1") return json(res, 200, { success: true, status: "completed", job: { id: "job-1", status: "completed" } });
      return json(res, 404, { error: `not found: ${req.url}` });
    });
  });

  const port = await listen(daemon);
  try {
    await fs.writeFile(connectionsPath, JSON.stringify({
      defaultServer: "srv-main",
      servers: [{
        id: "srv-main",
        workspaceId: "workspace-main",
        endpoints: [
          { id: "unreachable-lan", type: "daemon", scope: "lan", url: "http://127.0.0.1:1", priority: 1, clientId: "client-a", authToken: "secret" },
          { id: "working-vpn", type: "daemon", scope: "virtual-lan", url: `http://127.0.0.1:${port}`, priority: 2, clientId: "client-a", authToken: "secret" },
        ],
      }],
    }, null, 2));
    await fs.writeFile(projectsPath, JSON.stringify({
      projects: {
        demo: {
          server: "srv-main",
          root: "/srv/projects/demo",
          commands: { build: "npm run build" },
          agentRules: ["AGENTS.md"],
        },
      },
    }, null, 2));

    process.env.AGENTPORT_CLIENT_STATE_PATH = statePath;
    const { loadConnectionRegistry } = await import("../packages/client-core/connection-registry.js");
    const { createClientRuntime, clientRuntimeInternals } = await import("../packages/client-core/client-runtime.js");

    const tokenA = clientRuntimeInternals.stableScriptToken({ idempotencyKey: "key-1", content: "echo one", interpreter: "bash", cwd: "/srv/projects/demo" });
    const tokenA2 = clientRuntimeInternals.stableScriptToken({ idempotencyKey: "key-1", content: "echo one", interpreter: "bash", cwd: "/srv/projects/demo" });
    const tokenB = clientRuntimeInternals.stableScriptToken({ idempotencyKey: "key-1", content: "echo two", interpreter: "bash", cwd: "/srv/projects/demo" });
    assert.equal(tokenA, tokenA2);
    assert.notEqual(tokenA, tokenB);

    const registry = await loadConnectionRegistry({ filePath: connectionsPath, baseDir: root });
    assert.equal(registry.defaultServerId, "srv-main");
    assert.equal(registry.getEndpoint("working-vpn").server.id, "srv-main");

    const runtime = await createClientRuntime({
      baseDir: root,
      connectionsPath,
      projectsPath,
      healthTtlMs: 50,
      sessionId: "test-session",
    });
    try {
      const health = await runtime.probeServer("srv-main", { force: true });
      assert.equal(health.healthByEndpoint["unreachable-lan"].ok, false);
      assert.equal(health.healthByEndpoint["working-vpn"].serverId, "srv-main");

      const read = await runtime.invoke("remote_read", { project: "demo", path: "src/a.js" });
      assert.equal(read.data.content, "read:/srv/projects/demo/src/a.js");
      assert.equal(read.meta.endpointId, "working-vpn");
      assert.equal(read.meta.project, "demo");

      const status = await runtime.projectStatus("demo");
      assert.match(status.data.stdout, /cwd=\/srv\/projects\/demo/);

      const run = await runtime.projectRun("demo", "build", { idempotencyKey: "demo:build:abc" });
      assert.equal(run.data.jobId, "job-1");
      assert.equal(run.meta.attempts, 2);
      assert.equal(run.meta.idempotencyKey, "demo:build:abc");
      assert.equal(idempotencyKey, "demo:build:abc");
      assert.equal(asyncAttempts, 2);

      const logs = await runtime.invoke("job_logs", { jobId: "job-1", cursor: "cursor-1", server: "srv-main" });
      assert.equal(logs.data.cursor, "cursor-2");
      assert.equal(logs.data.stdout.content, "new-log\n");
    } finally {
      runtime.close();
    }

    const cli = spawnSync(process.execPath, [
      path.join(ROOT, "client", "cli-entry.js"),
      "server", "list", "--json",
      "--connections", connectionsPath,
      "--projects", projectsPath,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, AGENTPORT_CLIENT_STATE_PATH: statePath },
      timeout: 15_000,
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const cliData = JSON.parse(cli.stdout);
    assert.equal(cliData.selectedServerId, "srv-main");
    assert.equal(cliData.projects[0].name, "demo");
  } finally {
    await close(daemon);
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("PASS modular client registry, runtime, stable script identity, project actions, idempotency, cursor logs, and CLI");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
