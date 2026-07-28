#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  clearWorkspaceRoots,
  configureWorkspaceRoots,
  isWithin,
  parseNamedInput,
  resolveWorkspacePath,
} = require("./packages/daemon-core/path-guard.cjs");
const {
  createDaemonConfigLoader,
  loadWorkspaceScope,
  parseWorkspaceRootsJson,
} = require("./daemon/config-loader.cjs");
const { createFileReadService } = require("./packages/daemon-core/file-read-service.cjs");
const { createFileSearchService } = require("./packages/daemon-core/file-search-service.cjs");
const { createFileWriteService } = require("./packages/daemon-core/file-write-service.cjs");

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error?.code === code);
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
    const scope = configureWorkspaceRoots({
      defaultWorkspace: "projects",
      roots: { projects, openclaw },
    });
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

    const relative = await resolveWorkspacePath(projects, "content-analyzer/README.md", { mustExist: true });
    assert.equal(relative.workspace, "projects");
    assert.equal(relative.isDefaultWorkspace, true);
    assert.equal(relative.namedPath, "projects:/content-analyzer/README.md");

    const named = await resolveWorkspacePath(projects, "openclaw:/config.json", { mustExist: true });
    assert.equal(named.workspace, "openclaw");
    assert.equal(named.isDefaultWorkspace, false);
    assert.equal(named.realPath, await fs.realpath(path.join(openclaw, "config.json")));

    const uri = await resolveWorkspacePath(projects, "workspace://openclaw/workspace", { mustExist: true });
    assert.equal(uri.workspace, "openclaw");
    assert.equal(uri.namedPath, "openclaw:/workspace");

    const absolute = await resolveWorkspacePath(projects, path.join(openclaw, "config.json"), { mustExist: true });
    assert.equal(absolute.workspace, "openclaw");

    const reader = createFileReadService({ workspaceRoot: projects });
    const writer = createFileWriteService({ workspaceRoot: projects });
    const search = createFileSearchService({ workspaceRoot: projects });

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

    await rejectsCode(
      () => resolveWorkspacePath(projects, "missing:/file.txt", { mustExist: false }),
      "EWORKSPACE_NAME",
    );
    await rejectsCode(
      () => resolveWorkspacePath(projects, "openclaw:/../outside/secret.txt", { mustExist: true }),
      "EWORKSPACE",
    );
    await rejectsCode(
      () => resolveWorkspacePath(projects, path.join(outside, "secret.txt"), { mustExist: true }),
      "EWORKSPACE",
    );

    if (process.platform !== "win32") {
      await fs.symlink(outside, path.join(projects, "escape"), "dir");
      await rejectsCode(
        () => resolveWorkspacePath(projects, "projects:/escape/secret.txt", { mustExist: true }),
        "EWORKSPACE",
      );

      await fs.symlink(openclaw, path.join(projects, "other-workspace"), "dir");
      await rejectsCode(
        () => resolveWorkspacePath(projects, "projects:/other-workspace/config.json", { mustExist: true }),
        "EWORKSPACE",
      );
    }

    // Development-session compatibility: the exported boundary check treats
    // the configured default root as the complete named-workspace scope.
    assert.equal(isWithin(path.join(openclaw, "workspace"), projects), true);
    assert.equal(isWithin(path.join(outside, "secret.txt"), projects), false);

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
    clearWorkspaceRoots();
    await fs.rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
