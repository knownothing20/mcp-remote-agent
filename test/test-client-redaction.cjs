#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function main() {
  const secret = "agentport-test-secret-do-not-print";
  const { redactSensitive } = await import("../packages/client-core/redaction.js");
  const unit = redactSensitive({
    endpoint: { authToken: secret, password: "password-value", url: `http://localhost/?token=${secret}` },
    nested: [{ privateKey: "PRIVATE-KEY-DATA" }],
  });
  const unitText = JSON.stringify(unit);
  assert.doesNotMatch(unitText, new RegExp(secret));
  assert.doesNotMatch(unitText, /password-value|PRIVATE-KEY-DATA/);
  assert.match(unitText, /REDACTED/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-redaction-"));
  const connectionsPath = path.join(root, "connections.v3.json");
  const projectsPath = path.join(root, "projects.json");
  const statePath = path.join(root, "state.json");
  const daemon = http.createServer((_req, res) => {
    const body = Buffer.from(JSON.stringify({
      ok: true,
      serverId: "redaction-server",
      workspaceId: "redaction-workspace",
      workspaceRoot: root,
    }));
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  const port = await listen(daemon);

  try {
    await fs.writeFile(connectionsPath, JSON.stringify({
      defaultServer: "redaction-server",
      servers: [{
        id: "redaction-server",
        workspaceId: "redaction-workspace",
        endpoints: [{
          id: "redaction-lan",
          type: "daemon",
          url: `http://127.0.0.1:${port}`,
          clientId: "redaction-client",
          authToken: secret,
        }],
      }],
    }, null, 2));
    await fs.writeFile(projectsPath, JSON.stringify({ projects: {} }));

    const { loadConnectionRegistry } = await import("../packages/client-core/connection-registry.js");
    const registry = await loadConnectionRegistry({ filePath: connectionsPath, baseDir: root });
    const internalEndpoint = registry.getEndpoint("redaction-lan").endpoint;
    assert.equal(internalEndpoint.authToken, secret);
    const serializedRegistry = JSON.stringify(registry.getServer("redaction-server"));
    assert.doesNotMatch(serializedRegistry, new RegExp(secret));
    assert.match(serializedRegistry, /REDACTED/);

    process.env.AGENTPORT_CLIENT_STATE_PATH = statePath;
    const { createClientRuntime } = await import("../packages/client-core/client-runtime.js");
    const runtime = await createClientRuntime({
      baseDir: root,
      connectionsPath,
      projectsPath,
      healthTtlMs: 1,
    });
    try {
      const probed = await runtime.probeServer("redaction-server", { force: true });
      const serializedRuntime = JSON.stringify(probed);
      assert.doesNotMatch(serializedRuntime, new RegExp(secret));
      assert.match(serializedRuntime, /REDACTED/);
    } finally {
      runtime.close();
    }

    const cli = await run(process.execPath, [
      path.join(ROOT, "client", "cli-entry.js"),
      "server", "health", "redaction-server", "--force", "--json",
      "--connections", connectionsPath,
      "--projects", projectsPath,
    ], {
      cwd: ROOT,
      env: { ...process.env, AGENTPORT_CLIENT_STATE_PATH: statePath },
    });
    assert.equal(cli.code, 0, cli.stderr || cli.stdout);
    assert.doesNotMatch(cli.stdout, new RegExp(secret));
    assert.match(cli.stdout, /REDACTED/);

    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.server, "redaction-server");
    assert.equal(parsed.endpoints[0].endpoint.authToken, "[REDACTED]");
  } finally {
    await close(daemon);
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("PASS centralized client and runtime credential redaction");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
