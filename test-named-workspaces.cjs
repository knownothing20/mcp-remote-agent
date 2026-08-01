#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  createWorkspacePathGuard,
  isWithin,
  parseNamedInput,
} = require("./packages/daemon-core/path-guard.cjs");
const {
  createDaemonConfigLoader,
  loadWorkspaceScope,
  parseWorkspaceRootsJson,
} = require("./daemon/config-loader.cjs");
const { createFileReadService } = require("./packages/daemon-core/file-read-service.cjs");
const { createFileSearchService } = require("./packages/daemon-core/file-search-service.cjs");
const { createFileWriteService } = require("./packages/daemon-core/file-write-service.cjs");
const { createCommandPolicy } = require("./packages/daemon-core/command-policy.cjs");
const { createExecutionQueue } = require("./packages/daemon-core/execution-queue.cjs");
const { createExecService } = require("./packages/daemon-core/exec-service.cjs");
const { createJobService } = require("./packages/daemon-core/job-service.cjs");
const { createDevelopmentSessionService } = require("./packages/daemon-core/development-session-service.cjs");

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error?.code === code);
}

function shellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for named-workspace operation");
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agentport-workspaces-"));
  const projects = path.join(base, "projects");
  const openclaw = path.join(base, ".openclaw");
  const outside = path.join(base, "outside");
  await Promise.all([
    fs.mkdir(path.join(projects, "content-analyzer"), { recursive: true }),
    fs.mkdir(path.join(openclaw, "workspace"), { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ]);
  await fs.writeFile(path.join(projects, "content-analyzer", "README.md"), "project\n");
  await fs.writeFile(path.join(openclaw, "config.json"), "{}\n");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");

  try {
    const pathGuard = createWorkspacePathGuard({
      defaultWorkspace: "projects",
      roots: { projects, openclaw },
    });
    const { scope } = pathGuard;
    assert.equal(scope.defaultRoot, path.resolve(projects));
    assert.deepEqual(scope.names, ["projects", "openclaw"]);

    assert.deepEqual(parseNamedInput("workspace://openclaw/workspace"), {
      workspace: "openclaw",
      relativePath: "workspace",
    });
    assert.deepEqual(parseNamedInput("projects:/content-analyzer"), {
      workspace: "projects",
      relativePath: "content-analyzer",
    });

    const relative = await pathGuard.resolve("content-analyzer/README.md", { mustExist: true });
    assert.equal(relative.workspace, "projects");
    assert.equal(relative.isDefaultWorkspace, true);
    assert.equal(relative.namedPath, "projects:/content-analyzer/README.md");

    const named = await pathGuard.resolve("openclaw:/config.json", { mustExist: true });
    assert.equal(named.workspace, "openclaw");
    assert.equal(named.isDefaultWorkspace, false);
    assert.equal(named.realPath, await fs.realpath(path.join(openclaw, "config.json")));

    const uri = await pathGuard.resolve("workspace://openclaw/workspace", { mustExist: true });
    assert.equal(uri.workspace, "openclaw");
    assert.equal(uri.namedPath, "openclaw:/workspace");

    const absolute = await pathGuard.resolve(path.join(openclaw, "config.json"), { mustExist: true });
    assert.equal(absolute.workspace, "openclaw");

    const reader = createFileReadService({ workspaceRoot: projects, workspaceScope: scope });
    const writer = createFileWriteService({ workspaceRoot: projects, workspaceScope: scope });
    const search = createFileSearchService({ workspaceRoot: projects, workspaceScope: scope });

    const defaultRead = await reader.readText("content-analyzer/README.md");
    assert.equal(defaultRead.workspace, "projects");
    assert.equal(defaultRead.path, "content-analyzer/README.md");
    assert.equal(defaultRead.namedPath, "projects:/content-analyzer/README.md");

    const namedRead = await reader.readText("openclaw:/config.json");
    assert.equal(namedRead.workspace, "openclaw");
    assert.equal(namedRead.path, "openclaw:/config.json");
    assert.equal(namedRead.relativePath, "config.json");

    const written = await writer.writeText("openclaw:/workspace/generated.txt", "generated workspace output\n");
    assert.equal(written.workspace, "openclaw");
    assert.equal(written.path, "openclaw:/workspace/generated.txt");
    assert.equal(written.relativePath, "workspace/generated.txt");

    const globbed = await search.glob("**/*.txt", { cwd: "openclaw:/workspace" });
    assert.equal(globbed.workspace, "openclaw");
    assert.equal(globbed.cwd, "openclaw:/workspace");
    assert.deepEqual(globbed.files, ["openclaw:/workspace/generated.txt"]);
    assert.equal(globbed.entries[0].namedPath, "openclaw:/workspace/generated.txt");

    const grepped = await search.grep({ pattern: "generated workspace", cwd: "openclaw:/workspace" });
    assert.equal(grepped.matches[0].path, "openclaw:/workspace/generated.txt");
    assert.equal(grepped.matches[0].workspace, "openclaw");

    const manifest = await reader.manifest("openclaw:/workspace");
    assert.equal(manifest.root, "openclaw:/workspace");
    assert.equal(manifest.entries[0].path, "openclaw:/workspace/generated.txt");

    const removed = await writer.removeFile("openclaw:/workspace/generated.txt", { expectedEtag: written.etag });
    assert.equal(removed.path, "openclaw:/workspace/generated.txt");

    const alternateOpenclaw = path.join(base, ".openclaw-alternate");
    await fs.mkdir(alternateOpenclaw, { recursive: true });
    await fs.writeFile(path.join(alternateOpenclaw, "config.json"), "alternate\n");
    const alternateGuard = createWorkspacePathGuard({
      defaultWorkspace: "projects",
      roots: { projects, openclaw: alternateOpenclaw },
    });
    const alternateReader = createFileReadService({ workspaceRoot: projects, workspaceScope: alternateGuard.scope });
    assert.equal((await reader.readText("openclaw:/config.json")).content, "{}\n");
    assert.equal((await alternateReader.readText("openclaw:/config.json")).content, "alternate\n");
    assert.equal((await reader.readText("openclaw:/config.json")).content, "{}\n");

    const policy = createCommandPolicy({ allowExec: true });
    const queue = createExecutionQueue({ maxConcurrency: 1, queueTimeoutMs: 1_000 });
    const exec = createExecService({
      workspaceRoot: projects,
      workspaceScope: scope,
      policy,
      queue,
    });
    const expectedNamedCwd = await fs.realpath(path.join(openclaw, "workspace"));
    const execResult = await exec.executeScript("process.stdout.write(process.cwd())", {
      interpreter: "node",
      cwd: "openclaw:/workspace",
    });
    assert.equal(await fs.realpath(execResult.stdout), expectedNamedCwd);

    const jobScript = path.join(openclaw, "workspace", "named-job.cjs");
    await fs.writeFile(jobScript, "process.stdout.write(process.cwd())\n");
    const jobs = createJobService({
      jobsDir: path.join(base, ".jobs"),
      workspaceRoot: projects,
      workspaceScope: scope,
      policy,
      maxConcurrency: 1,
      queueTimeoutMs: 1_000,
      defaultTimeoutMs: 10_000,
    });
    const started = await jobs.start({
      command: `${shellArg(process.execPath)} ${shellArg(jobScript)}`,
      cwd: "openclaw:/workspace",
      clientId: "named-workspace-test",
    });
    const completed = await waitFor(async () => {
      const job = await jobs.get(started.job.id);
      return job.status === "completed" && job.processAlive === false ? job : null;
    });
    assert.equal(completed.cwd, expectedNamedCwd);
    const jobLogs = await jobs.logs(completed.id, { tailBytes: 4096 });
    assert.equal(await fs.realpath(jobLogs.stdout.content), expectedNamedCwd);
    await jobs.remove(completed.id);

    const repo = path.join(openclaw, "workspace", "session-repo");
    await fs.mkdir(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "AgentPort Test"]);
    git(repo, ["config", "user.email", "agentport@example.com"]);
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    const sessions = createDevelopmentSessionService({
      workspaceRoot: projects,
      workspaceScope: scope,
      sessionsDir: path.join(base, ".sessions"),
      worktreesDir: path.join(base, ".worktrees"),
      defaultLeaseMs: 60_000,
    });
    const session = await sessions.create({
      projectRoot: "openclaw:/workspace/session-repo",
      projectName: "named-workspace-repo",
      agentId: "test-agent",
      baseRef: "main",
      targetBranch: "main",
    });
    assert.equal(session.repoRoot, await fs.realpath(repo));
    assert.equal(session.status, "active");
    const cleaned = await sessions.cleanup(session.id, {
      force: true,
      deleteBranch: true,
      confirm: session.id,
    });
    assert.equal(cleaned.cleaned, true);
    assert.equal(cleaned.branchDeleted, true);

    await rejectsCode(
      () => pathGuard.resolve("missing:/file.txt", { mustExist: false }),
      "EWORKSPACE_NAME",
    );
    await rejectsCode(
      () => pathGuard.resolve("openclaw:/../outside/secret.txt", { mustExist: true }),
      "EWORKSPACE",
    );
    await rejectsCode(
      () => pathGuard.resolve(path.join(outside, "secret.txt"), { mustExist: true }),
      "EWORKSPACE",
    );

    if (process.platform !== "win32") {
      await fs.symlink(outside, path.join(projects, "escape"), "dir");
      await rejectsCode(
        () => pathGuard.resolve("projects:/escape/secret.txt", { mustExist: true }),
        "EWORKSPACE",
      );

      await fs.symlink(openclaw, path.join(projects, "other-workspace"), "dir");
      await rejectsCode(
        () => pathGuard.resolve("projects:/other-workspace/config.json", { mustExist: true }),
        "EWORKSPACE",
      );
    }

    // Development-session compatibility: the exported boundary check treats
    // the configured default root as the complete named-workspace scope.
    assert.equal(isWithin(path.join(openclaw, "workspace"), projects, scope), true);
    assert.equal(isWithin(path.join(outside, "secret.txt"), projects, scope), false);

    const parsedMap = parseWorkspaceRootsJson(JSON.stringify({ projects, openclaw }));
    assert.deepEqual(parsedMap, { roots: { projects, openclaw }, defaultWorkspace: "" });
    const parsedEnvelope = parseWorkspaceRootsJson(JSON.stringify({
      default: "openclaw",
      roots: { projects, openclaw },
    }));
    assert.equal(parsedEnvelope.defaultWorkspace, "openclaw");

    const configScope = loadWorkspaceScope({
      WORKSPACE_ROOT: projects,
      WORKSPACE_ROOTS_JSON: JSON.stringify({ projects, openclaw }),
      DEFAULT_WORKSPACE: "projects",
    });
    assert.equal(configScope.defaultWorkspace, "projects");
    assert.equal(configScope.roots.openclaw, path.resolve(openclaw));

    const envPath = path.join(base, "agentport.env");
    await fs.writeFile(envPath, [
      `WORKSPACE_ROOT=${projects}`,
      `WORKSPACE_ROOTS_JSON=${JSON.stringify({ projects, openclaw })}`,
      "DEFAULT_WORKSPACE=projects",
      "AGENTPORT_SERVER_ID=test-server",
      "AGENTPORT_WORKSPACE_ID=test-workspaces",
      "",
    ].join("\n"));
    const loaded = await createDaemonConfigLoader({ baseDir: path.join(base, "daemon"), envPath }).load();
    assert.equal(loaded.workspaceRoot, path.resolve(projects));
    assert.equal(loaded.defaultWorkspace, "projects");
    assert.deepEqual(loaded.workspaceNames, ["projects", "openclaw"]);
    assert.equal(loaded.workspaceRoots.openclaw, path.resolve(openclaw));

    const fileEnvPath = path.join(base, "file-agentport.env");
    const workspaceFilePath = path.join(base, "workspaces.json");
    await fs.writeFile(fileEnvPath, `WORKSPACE_ROOT=${projects}\n`);
    await fs.writeFile(workspaceFilePath, JSON.stringify({
      default: "projects",
      roots: { projects, openclaw },
    }));
    const fileLoaded = await createDaemonConfigLoader({
      baseDir: path.join(base, "daemon"),
      envPath: fileEnvPath,
    }).load();
    assert.equal(fileLoaded.workspaceConfigPath, workspaceFilePath);
    assert.equal(fileLoaded.workspaceRoots.openclaw, path.resolve(openclaw));

    const legacyScope = loadWorkspaceScope({ WORKSPACE_ROOT: projects });
    assert.deepEqual(legacyScope.names, ["default"]);
    assert.equal(legacyScope.defaultRoot, path.resolve(projects));

    const overrideScope = loadWorkspaceScope({
      WORKSPACE_ROOTS_JSON: JSON.stringify({ projects, openclaw }),
      DEFAULT_WORKSPACE: "projects",
    }, outside);
    assert.deepEqual(overrideScope.names, ["projects"]);
    assert.equal(overrideScope.defaultRoot, path.resolve(outside));

    assert.throws(
      () => loadWorkspaceScope({
        WORKSPACE_ROOTS_JSON: JSON.stringify({ projects, duplicate: projects }),
        DEFAULT_WORKSPACE: "projects",
      }),
      (error) => error?.code === "EWORKSPACE_CONFIG",
    );
    assert.throws(
      () => loadWorkspaceScope({
        WORKSPACE_ROOTS_JSON: JSON.stringify({ projects, nested: path.join(projects, "content-analyzer") }),
        DEFAULT_WORKSPACE: "projects",
      }),
      (error) => error?.code === "EWORKSPACE_CONFIG" && /overlaps/.test(error.message),
    );

    const { validateProjectProfile, resolveProjectPath } = await import("./packages/client-core/project-profile.js");
    const namedProfile = validateProjectProfile("content-analyzer", {
      server: "debian-main",
      root: "workspace://projects/content-analyzer",
    });
    assert.equal(namedProfile.root, "projects:/content-analyzer");
    assert.equal(
      resolveProjectPath(namedProfile, "src/index.js"),
      "projects:/content-analyzer/src/index.js",
    );
    assert.throws(
      () => resolveProjectPath(namedProfile, "../../.ssh"),
      (error) => error?.code === "EPROJECTPATH",
    );

    console.log("named workspace tests passed");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
