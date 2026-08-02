#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

async function importModule(relativePath) {
  return import(new URL(relativePath, `file://${ROOT.replace(/\\/g, "/")}/`).href);
}

async function testOperationPolicy() {
  const { getOperationPolicy, canRetryOperation, canFallbackOperation } = await importModule("./packages/shared/operation-policy.js");
  assert.equal(getOperationPolicy("remote_read").class, "read");
  assert.equal(getOperationPolicy("remote_write").class, "write");
  assert.equal(canRetryOperation({ operation: "remote_read", requestAccepted: true }), true);
  assert.equal(canRetryOperation({ operation: "remote_exec_async", requestAccepted: true }), false);
  assert.equal(canRetryOperation({ operation: "remote_exec_async", requestAccepted: true, idempotencyKey: "build:abc" }), true);
  assert.equal(canFallbackOperation({ operation: "remote_write", identityMatch: false }), false);
  assert.equal(canFallbackOperation({ operation: "remote_write", identityMatch: true }), true);
}

async function testRequestContext() {
  const { createRequestContext, bindRequestEndpoint } = await importModule("./packages/shared/request-context.js");
  const context = createRequestContext({ operation: "remote_write", serverId: "debian-main", workspaceId: "projects" });
  assert.equal(context.policy.class, "write");
  assert.ok(context.requestId);
  context.serverId = "other";
  assert.equal(context.serverId, "debian-main");
  const bound = bindRequestEndpoint(context, { id: "lan", type: "daemon", name: "daemon-lan" });
  assert.equal(bound.endpointId, "lan");
  assert.equal(bound.route, "daemon");
}

async function testEndpointSelection() {
  const { selectEndpoint } = await importModule("./packages/client-core/endpoint-selector.js");
  const server = {
    id: "debian-main",
    workspaceId: "projects",
    endpoints: [
      { id: "lan", type: "daemon", scope: "lan", priority: 10 },
      { id: "vpn", type: "daemon", scope: "virtual-lan", priority: 20 },
      { id: "ssh", type: "ssh", scope: "recovery", priority: 30 },
    ],
  };
  const identity = { ok: true, serverId: "debian-main", workspaceId: "projects" };
  const selected = selectEndpoint({
    server,
    operation: "remote_write",
    healthByEndpoint: {
      lan: { ...identity, latencyMs: 5 },
      vpn: { ...identity, latencyMs: 30 },
      ssh: { ...identity, latencyMs: 50 },
    },
  });
  assert.equal(selected.endpoint.id, "lan");

  const failover = selectEndpoint({
    server,
    operation: "remote_read",
    healthByEndpoint: {
      lan: { ...identity, ok: false },
      vpn: { ...identity, latencyMs: 30 },
      ssh: { ...identity, latencyMs: 50 },
    },
  });
  assert.equal(failover.endpoint.id, "vpn");

  assert.throws(() => selectEndpoint({
    server,
    operation: "remote_write",
    healthByEndpoint: {
      lan: { ok: true, serverId: "wrong", workspaceId: "projects", latencyMs: 5 },
    },
  }), (error) => error?.code === "ENOENDPOINT");
}

async function testProjectProfile() {
  const { validateProjectProfile, resolveProjectPath } = await importModule("./packages/client-core/project-profile.js");
  const profile = validateProjectProfile("demo", {
    server: "debian-main",
    root: "/home/YOUR_USER/projects/demo",
  });
  assert.equal(resolveProjectPath(profile, "src/index.js"), "/home/YOUR_USER/projects/demo/src/index.js");
  assert.throws(() => resolveProjectPath(profile, "../../.ssh"), (error) => error?.code === "EPROJECTPATH");
}

async function testServerDependencyLock() {
  const serverRoot = path.join(ROOT, "server");
  const packageInfo = JSON.parse(await fs.readFile(path.join(serverRoot, "package.json"), "utf8"));
  const lockInfo = JSON.parse(await fs.readFile(path.join(serverRoot, "package-lock.json"), "utf8"));

  assert.equal(packageInfo.dependencies.qs, "6.15.3");
  assert.equal(packageInfo.overrides.qs, "6.15.3");
  assert.equal(lockInfo.packages[""].dependencies.qs, "6.15.3");
  assert.equal(lockInfo.packages["node_modules/qs"].version, "6.15.3");

  if (process.env.CI) {
    const command = `npm --prefix ${shellArg(serverRoot)} ci --ignore-scripts --no-audit --no-fund`;
    const install = spawnSync(command, {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      shell: true,
    });
    assert.equal(install.status, 0, install.error?.stack || install.stderr || install.stdout);
    const installed = JSON.parse(await fs.readFile(path.join(serverRoot, "node_modules", "qs", "package.json"), "utf8"));
    assert.equal(installed.version, "6.15.3");
  }
}

async function testReleaseMetadataAndSync() {
  const packageInfo = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const skill = await fs.readFile(path.join(ROOT, "SKILL.md"), "utf8");
  const escapedVersion = packageInfo.version.replace(/\./g, "\\.");
  assert.match(skill, new RegExp(`Current version:\\s+\\*\\*v${escapedVersion}\\*\\*`));

  const check = spawnSync(process.execPath, [path.join(ROOT, "sync.cjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(check.status, 0, check.error?.stack || check.stderr || check.stdout);

  const target = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-skill-sync-"));
  const privateConnections = JSON.stringify({ connections: [{ name: "private", authToken: "do-not-overwrite" }] });
  try {
    await fs.mkdir(path.join(target, "local"), { recursive: true });
    await fs.writeFile(path.join(target, "local", "connections.json"), privateConnections, "utf8");
    const sync = spawnSync(process.execPath, [
      path.join(ROOT, "sync.cjs"),
      "--skills",
      "--target",
      target,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(sync.status, 0, sync.error?.stack || sync.stderr || sync.stdout);
    assert.equal(await fs.readFile(path.join(target, "local", "connections.json"), "utf8"), privateConnections);
    await fs.access(path.join(target, "local", "connections.v3.json.example"));
    await fs.access(path.join(target, "local", "projects.json.example"));
    await assert.rejects(() => fs.access(path.join(target, "local", "agentport.json")), (error) => error?.code === "ENOENT");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
}

async function testOperationalHardening() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-hardening-"));
  try {
    const { createAuditLogWriter } = require("../server/audit-log.cjs");
    const auditPath = path.join(tempRoot, "audit.log");
    const writer = createAuditLogWriter({ filePath: auditPath, maxBytes: 1024, maxFiles: 2 });
    await writer.append({ seq: 1, payload: "a".repeat(700) });
    await writer.append({ seq: 2, payload: "b".repeat(700) });
    assert.match(await fs.readFile(auditPath + ".1", "utf8"), /"seq":1/);
    assert.match(await fs.readFile(auditPath, "utf8"), /"seq":2/);
    await assert.rejects(() => fs.stat(auditPath + ".rotate.lock"), (error) => error?.code === "ENOENT");

    const dashboard = await fs.readFile(path.join(ROOT, "server", "dashboard.html"), "utf8");
    assert.match(dashboard, /history\.replaceState/);
    assert.match(dashboard, /Authorization['"]?:['"]Bearer /);
    assert.doesNotMatch(dashboard, /encodeURIComponent\(TOKEN\)/);

    const serverSource = await fs.readFile(path.join(ROOT, "server", "server.js"), "utf8");
    assert.match(serverSource, /if \(!authenticated\)/);

    const { createJobStore } = require("../packages/daemon-core/job-store.cjs");
    const jobsDir = path.join(tempRoot, "jobs");
    const store = createJobStore({ jobsDir });
    const job = await store.create({ command: "echo ok" });
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(jobsDir)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(jobsDir, "_keys"))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(store.paths.jobDir(job.id))).mode & 0o777, 0o700);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function testDaemonFileServices() {
  const { createFileReadService, createFileWriteService } = require("../packages/daemon-core/index.cjs");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-core-"));
  try {
    const reader = createFileReadService({ workspaceRoot: tempRoot });
    const writer = createFileWriteService({ workspaceRoot: tempRoot });

    const first = await writer.writeText("src/demo.txt", "line-1\nline-2\nline-3\n");
    assert.equal(first.atomic, true);
    assert.equal(first.verified, true);

    const range = await reader.readText("src/demo.txt", { startLine: 2, endLine: 3 });
    assert.equal(range.content, "line-2\nline-3");
    assert.equal(range.ranged, true);

    await assert.rejects(
      () => writer.writeText("src/demo.txt", "changed", { expectedEtag: "wrong" }),
      (error) => error?.code === "EWRITE_CONFLICT" && error?.statusCode === 409,
    );

    if (process.platform !== "win32") await fs.chmod(path.join(tempRoot, "src", "demo.txt"), 0o755);
    const previousUmask = process.platform === "win32" ? null : process.umask(0o077);
    let second;
    try {
      second = await writer.writeText("src/demo.txt", "changed", { expectedEtag: first.etag });
    } finally {
      if (previousUmask !== null) process.umask(previousUmask);
    }
    assert.notEqual(second.etag, first.etag);
    if (process.platform !== "win32") {
      const mode = (await fs.stat(path.join(tempRoot, "src", "demo.txt"))).mode & 0o777;
      assert.equal(mode, 0o755);
    }

    const manifest = await reader.manifest(".");
    assert.ok(manifest.entries.some((entry) => entry.path.replace(/\\/g, "/") === "src/demo.txt"));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function testSymlinkEscapeGuard() {
  const { createFileReadService } = require("../packages/daemon-core/index.cjs");
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-symlink-"));
  const workspace = path.join(tempBase, "workspace");
  const outside = path.join(tempBase, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

  try {
    await fs.symlink(outside, path.join(workspace, "escape"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      await fs.rm(tempBase, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  try {
    const reader = createFileReadService({ workspaceRoot: workspace });
    await assert.rejects(
      () => reader.readText("escape/secret.txt"),
      (error) => error?.code === "EWORKSPACE" && error?.statusCode === 403,
    );
  } finally {
    await fs.rm(tempBase, { recursive: true, force: true });
  }
}

async function main() {
  const tests = [
    ["operation policy", testOperationPolicy],
    ["request context", testRequestContext],
    ["endpoint selection", testEndpointSelection],
    ["project profile", testProjectProfile],
    ["server dependency lock", testServerDependencyLock],
    ["release metadata and sync", testReleaseMetadataAndSync],
    ["operational hardening", testOperationalHardening],
    ["daemon file services", testDaemonFileServices],
    ["symlink escape guard", testSymlinkEscapeGuard],
  ];

  for (const [name, test] of tests) {
    await test();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS ${tests.length}/${tests.length}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
