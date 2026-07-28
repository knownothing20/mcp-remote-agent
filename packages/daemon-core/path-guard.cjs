const fsNative = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const nativeRealpath = fsNative.realpath?.native
  ? promisify(fsNative.realpath.native)
  : null;
const nativeRealpathSync = fsNative.realpathSync?.native
  ? fsNative.realpathSync.native
  : fsNative.realpathSync;

const WORKSPACE_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
let activeWorkspaceScope = null;

function comparisonPath(value) {
  let normalized = path.resolve(String(value || ""));
  if (process.platform === "win32") {
    normalized = normalized.replace(/^\\\\\?\\/, "").toLowerCase();
  }
  return normalized;
}

function isWithinSingle(candidate, root) {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isWithinAny(candidate, roots) {
  return [...new Set((roots || []).filter(Boolean).map(comparisonPath))]
    .some((root) => isWithinSingle(candidate, root));
}

function canonicalSyncIfExists(value) {
  try {
    return comparisonPath(nativeRealpathSync(value));
  } catch {
    return comparisonPath(value);
  }
}

function workspaceConfigError(message) {
  const error = new Error(message);
  error.code = "EWORKSPACE_CONFIG";
  error.statusCode = 500;
  return error;
}

function workspaceNameError(name) {
  const error = new Error(`Unknown workspace '${name}'`);
  error.code = "EWORKSPACE_NAME";
  error.statusCode = 400;
  return error;
}

function normalizeWorkspaceName(value, label = "workspace name") {
  const name = String(value || "").trim();
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw workspaceConfigError(`${label} must match ${WORKSPACE_NAME_RE}`);
  }
  return name;
}

function normalizeWorkspaceScope({ defaultWorkspace = "default", roots, workspaceRoot } = {}) {
  const fallbackRoot = String(workspaceRoot || "").trim();
  const sourceRoots = roots && typeof roots === "object" && !Array.isArray(roots)
    ? roots
    : (fallbackRoot ? { [defaultWorkspace]: fallbackRoot } : null);
  if (!sourceRoots || Object.keys(sourceRoots).length === 0) {
    throw workspaceConfigError("At least one workspace root is required");
  }
  if (Object.keys(sourceRoots).length > 32) {
    throw workspaceConfigError("At most 32 named workspace roots are supported");
  }

  const normalizedRoots = {};
  const seenPaths = new Map();
  for (const [rawName, rawRoot] of Object.entries(sourceRoots)) {
    const name = normalizeWorkspaceName(rawName);
    if (typeof rawRoot !== "string" || !rawRoot.trim()) {
      throw workspaceConfigError(`Workspace '${name}' must have a non-empty path`);
    }
    const root = path.resolve(rawRoot.trim());
    const key = comparisonPath(root);
    if (seenPaths.has(key)) {
      throw workspaceConfigError(`Workspace '${name}' duplicates workspace '${seenPaths.get(key)}'`);
    }
    seenPaths.set(key, name);
    normalizedRoots[name] = root;
  }

  const normalizedDefault = normalizeWorkspaceName(defaultWorkspace, "default workspace");
  if (!normalizedRoots[normalizedDefault]) {
    throw workspaceConfigError(`Default workspace '${normalizedDefault}' is not defined`);
  }

  return Object.freeze({
    defaultWorkspace: normalizedDefault,
    defaultRoot: normalizedRoots[normalizedDefault],
    roots: Object.freeze({ ...normalizedRoots }),
    names: Object.freeze(Object.keys(normalizedRoots)),
  });
}

function configureWorkspaceRoots(options = {}) {
  const scope = normalizeWorkspaceScope(options);
  const aliases = new Set([
    comparisonPath(scope.defaultRoot),
    canonicalSyncIfExists(scope.defaultRoot),
  ]);
  activeWorkspaceScope = Object.freeze({ ...scope, defaultRootAliases: aliases });
  return activeWorkspaceScope;
}

function clearWorkspaceRoots() {
  activeWorkspaceScope = null;
}

function scopeForRoot(workspaceRoot) {
  const root = comparisonPath(workspaceRoot);
  if (activeWorkspaceScope?.defaultRootAliases?.has(root)) return activeWorkspaceScope;
  return normalizeWorkspaceScope({ workspaceRoot: root, defaultWorkspace: "default" });
}

function isWithin(candidate, root) {
  if (isWithinSingle(candidate, root)) return true;
  if (!activeWorkspaceScope) return false;
  const rootKey = comparisonPath(root);
  if (!activeWorkspaceScope.defaultRootAliases.has(rootKey)) return false;
  return isWithinAny(candidate, Object.values(activeWorkspaceScope.roots));
}

function accessDenied(inputPath, workspaceRoot) {
  const scope = scopeForRoot(workspaceRoot);
  const error = new Error(`Access denied: '${inputPath}' is outside configured workspace roots`);
  error.code = "EWORKSPACE";
  error.statusCode = 403;
  error.workspace = scope.defaultWorkspace;
  return error;
}

async function canonicalRealpath(existingPath) {
  const lexical = path.resolve(existingPath);
  const resolved = process.platform === "win32" && nativeRealpath
    ? await nativeRealpath(lexical)
    : await fs.realpath(lexical);
  return path.resolve(String(resolved).replace(/^\\\\\?\\/, ""));
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (typeof left.ino === "bigint" || typeof right.ino === "bigint") {
    return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
  }
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

async function isWithinByIdentity(candidateExisting, rootExisting, rootAliases = []) {
  const [candidateCanonical, rootCanonical] = await Promise.all([
    canonicalRealpath(candidateExisting),
    canonicalRealpath(rootExisting),
  ]);
  if (isWithinAny(candidateCanonical, [rootCanonical, rootExisting, ...rootAliases])) return true;
  if (process.platform !== "win32") return false;

  const identityRoots = [...new Set([rootCanonical, rootExisting, ...rootAliases].filter(Boolean))];
  const rootStats = [];
  for (const root of identityRoots) {
    try { rootStats.push(await fs.stat(root, { bigint: true })); }
    catch {}
  }
  if (!rootStats.length) return false;

  let current = candidateCanonical;
  while (true) {
    try {
      const currentStat = await fs.stat(current, { bigint: true });
      if (rootStats.some((rootStat) => sameFileIdentity(currentStat, rootStat))) return true;
    } catch {
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function parseNamedInput(inputPath) {
  const raw = String(inputPath || "").trim();
  const uri = raw.match(/^workspace:\/\/([A-Za-z][A-Za-z0-9._-]{0,63})(?:\/(.*))?$/);
  if (uri) return { workspace: uri[1], relativePath: uri[2] || "." };
  const shorthand = raw.match(/^([A-Za-z][A-Za-z0-9._-]{0,63}):(?:\/(.*))?$/);
  if (shorthand) return { workspace: shorthand[1], relativePath: shorthand[2] || "." };
  return null;
}

function selectWorkspace(scope, inputPath) {
  const named = parseNamedInput(inputPath);
  if (named) {
    const root = scope.roots[named.workspace];
    if (!root) throw workspaceNameError(named.workspace);
    return { workspace: named.workspace, root, relativePath: named.relativePath };
  }

  const raw = String(inputPath || "").trim();
  if (path.isAbsolute(raw)) {
    const absolute = path.resolve(raw);
    const matches = Object.entries(scope.roots)
      .filter(([, root]) => isWithinSingle(absolute, root))
      .sort((left, right) => comparisonPath(right[1]).length - comparisonPath(left[1]).length);
    if (!matches.length) throw accessDenied(inputPath, scope.defaultRoot);
    const [workspace, root] = matches[0];
    return { workspace, root, absolutePath: absolute };
  }

  return {
    workspace: scope.defaultWorkspace,
    root: scope.defaultRoot,
    relativePath: raw,
  };
}

function workspacePath(workspace, root, fullPath) {
  const relative = path.relative(root, fullPath).replace(/\\/g, "/");
  return relative && relative !== "." ? `${workspace}:/${relative}` : `${workspace}:/`;
}

async function resolveWorkspacePath(workspaceRoot, inputPath, { mustExist = false } = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new TypeError("workspaceRoot is required");
  }
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    const error = new Error("path is required");
    error.code = "EINVAL";
    error.statusCode = 400;
    throw error;
  }

  const scope = scopeForRoot(workspaceRoot);
  const selected = selectWorkspace(scope, inputPath);
  const rootLexical = path.resolve(selected.root);
  const rootReal = await canonicalRealpath(rootLexical);
  const candidateLexical = selected.absolutePath
    ? selected.absolutePath
    : path.resolve(rootLexical, String(selected.relativePath || ".").replace(/^[/\\]+/, ""));

  if (!isWithinSingle(candidateLexical, rootLexical)) {
    throw accessDenied(inputPath, workspaceRoot);
  }

  if (mustExist) {
    const candidateReal = await canonicalRealpath(candidateLexical);
    if (!(await isWithinByIdentity(candidateReal, rootReal, [rootLexical]))) {
      throw accessDenied(inputPath, workspaceRoot);
    }
    return {
      workspace: selected.workspace,
      workspaceName: selected.workspace,
      namedPath: workspacePath(selected.workspace, rootLexical, candidateLexical),
      root: rootReal,
      path: candidateLexical,
      realPath: candidateReal,
    };
  }

  const ancestorLexical = await nearestExistingAncestor(candidateLexical);
  const ancestorReal = await canonicalRealpath(ancestorLexical);
  if (!(await isWithinByIdentity(ancestorReal, rootReal, [rootLexical]))) {
    throw accessDenied(inputPath, workspaceRoot);
  }

  const remainder = path.relative(ancestorLexical, candidateLexical);
  const projectedReal = path.resolve(ancestorReal, remainder);
  if (!isWithinSingle(projectedReal, rootReal)) throw accessDenied(inputPath, workspaceRoot);

  return {
    workspace: selected.workspace,
    workspaceName: selected.workspace,
    namedPath: workspacePath(selected.workspace, rootLexical, candidateLexical),
    root: rootReal,
    path: candidateLexical,
    realPath: projectedReal,
  };
}

module.exports = {
  canonicalRealpath,
  clearWorkspaceRoots,
  configureWorkspaceRoots,
  isWithin,
  isWithinAny,
  isWithinByIdentity,
  normalizeWorkspaceName,
  normalizeWorkspaceScope,
  parseNamedInput,
  resolveWorkspacePath,
  sameFileIdentity,
  workspacePath,
};
