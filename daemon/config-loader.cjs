const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  configureWorkspaceRoots,
  normalizeWorkspaceName,
  normalizeWorkspaceScope,
} = require("../packages/daemon-core/path-guard.cjs");

function decodeEnvValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    if (value.startsWith('"')) {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return inner;
  }
  const commentIndex = value.search(/\s+#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value;
}

function parseEnvText(raw) {
  const values = {};
  for (const sourceLine of String(raw || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = decodeEnvValue(normalized.slice(separator + 1));
  }
  return values;
}

function parseTokenMap(values) {
  const rawJson = values.AUTH_TOKENS_JSON;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  const out = {};
  for (const entry of String(values.AUTH_TOKENS || "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const clientId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (clientId && token) out[clientId] = token;
  }
  return out;
}

function parseAdminTokens(values) {
  return new Set(String(values.ADMIN_TOKENS || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function intValue(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return path.resolve(candidate);
    } catch {}
  }
  return null;
}

function workspaceConfigError(message, cause) {
  const error = new Error(message);
  error.code = "EWORKSPACE_CONFIG";
  error.statusCode = 500;
  if (cause) error.cause = cause;
  return error;
}

function parseWorkspaceRootsJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw workspaceConfigError("WORKSPACE_ROOTS_JSON must be valid JSON", cause);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw workspaceConfigError("WORKSPACE_ROOTS_JSON must be a JSON object");
  }
  if (parsed.roots !== undefined) {
    if (!parsed.roots || typeof parsed.roots !== "object" || Array.isArray(parsed.roots)) {
      throw workspaceConfigError("WORKSPACE_ROOTS_JSON.roots must be an object");
    }
    return { roots: parsed.roots, defaultWorkspace: parsed.default || parsed.defaultWorkspace || "" };
  }
  return { roots: parsed, defaultWorkspace: "" };
}

function loadWorkspaceScope(values, runtimeWorkspaceRoot = "") {
  const fallbackRoot = path.resolve(runtimeWorkspaceRoot || values.WORKSPACE_ROOT || "/home/user/workspace");
  if (runtimeWorkspaceRoot) {
    const defaultWorkspace = normalizeWorkspaceName(values.DEFAULT_WORKSPACE || "default", "default workspace");
    return normalizeWorkspaceScope({
      defaultWorkspace,
      roots: { [defaultWorkspace]: fallbackRoot },
    });
  }

  const parsed = parseWorkspaceRootsJson(values.WORKSPACE_ROOTS_JSON);
  if (!parsed) {
    const defaultWorkspace = normalizeWorkspaceName(values.DEFAULT_WORKSPACE || "default", "default workspace");
    return normalizeWorkspaceScope({
      defaultWorkspace,
      roots: { [defaultWorkspace]: fallbackRoot },
    });
  }

  const rootNames = Object.keys(parsed.roots);
  const defaultWorkspace = normalizeWorkspaceName(
    values.DEFAULT_WORKSPACE || parsed.defaultWorkspace || rootNames[0] || "default",
    "default workspace",
  );
  const roots = { ...parsed.roots };
  if (!roots[defaultWorkspace] && values.WORKSPACE_ROOT) roots[defaultWorkspace] = fallbackRoot;
  return normalizeWorkspaceScope({ defaultWorkspace, roots });
}

async function loadWorkspaceScopeFromSources(values, runtimeWorkspaceRoot = "", envFilePath = null, baseDir = __dirname) {
  if (runtimeWorkspaceRoot || String(values.WORKSPACE_ROOTS_JSON || "").trim()) {
    return { scope: loadWorkspaceScope(values, runtimeWorkspaceRoot), workspaceConfigPath: null };
  }

  const explicitPath = String(values.WORKSPACE_ROOTS_FILE || "").trim();
  const configBaseDir = envFilePath ? path.dirname(envFilePath) : baseDir;
  const workspaceConfigPath = explicitPath
    ? path.resolve(configBaseDir, explicitPath)
    : path.resolve(configBaseDir, "workspaces.json");
  try {
    const raw = await fs.readFile(workspaceConfigPath, "utf8");
    return {
      scope: loadWorkspaceScope({ ...values, WORKSPACE_ROOTS_JSON: raw }, runtimeWorkspaceRoot),
      workspaceConfigPath,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { scope: loadWorkspaceScope(values, runtimeWorkspaceRoot), workspaceConfigPath: null };
  }
}

function createDaemonConfigLoader({ baseDir = __dirname, envPath } = {}) {
  let selectedEnvPath = envPath ? path.resolve(envPath) : null;
  let cache = null;
  let runtimeWorkspaceRoot = "";

  async function resolveEnvPath() {
    if (selectedEnvPath) return selectedEnvPath;
    selectedEnvPath = await firstExisting([
      process.env.AGENTPORT_ENV_PATH,
      path.join(baseDir, ".env"),
      path.join(baseDir, "..", "server", ".env"),
      path.join(process.cwd(), ".env"),
    ]);
    return selectedEnvPath;
  }

  async function readFileValues() {
    const filePath = await resolveEnvPath();
    if (!filePath) return { filePath: null, values: {} };
    try {
      const stat = await fs.stat(filePath);
      if (cache && cache.filePath === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
        return { filePath, values: cache.values };
      }
      const raw = await fs.readFile(filePath, "utf8");
      const values = parseEnvText(raw);
      cache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, values };
      return { filePath, values };
    } catch (error) {
      if (error?.code === "ENOENT") return { filePath, values: {} };
      throw error;
    }
  }

  async function load() {
    const file = await readFileValues();
    const values = { ...file.values, ...process.env };
    const tokenMap = parseTokenMap(values);
    const tokenClientMap = new Map();
    for (const [clientId, token] of Object.entries(tokenMap)) {
      if (token) tokenClientMap.set(token, clientId);
    }
    const legacyToken = String(values.AUTH_TOKEN || values.MCP_REMOTE_AUTH_TOKEN || values.NIUMA_SSH_AUTH_TOKEN || "").trim();
    if (legacyToken && tokenClientMap.size === 0) tokenClientMap.set(legacyToken, "legacy-client");

    const { scope: workspaceScope, workspaceConfigPath } = await loadWorkspaceScopeFromSources(
      values,
      runtimeWorkspaceRoot,
      file.filePath,
      baseDir,
    );
    configureWorkspaceRoots(workspaceScope);
    const workspaceRoot = workspaceScope.defaultRoot;
    const jobsDir = path.resolve(values.AGENTPORT_JOBS_DIR || values.JOBS_DIR || path.join(baseDir, "..", "server", "jobs"));
    const execTimeoutMs = intValue(values.EXEC_TIMEOUT_MS, 120_000, 1000, 24 * 60 * 60_000);
    const jobMaxTimeoutMs = intValue(values.MAX_JOB_TIMEOUT_MS, 7 * 24 * 60 * 60_000, 1000, 30 * 24 * 60 * 60_000);

    return {
      envPath: file.filePath,
      values,
      workspaceRoot,
      workspaceConfigPath,
      workspaceRoots: workspaceScope.roots,
      workspaceNames: workspaceScope.names,
      defaultWorkspace: workspaceScope.defaultWorkspace,
      jobsDir,
      serverId: String(values.AGENTPORT_SERVER_ID || values.SERVER_ID || os.hostname()).trim(),
      workspaceId: String(values.AGENTPORT_WORKSPACE_ID || values.WORKSPACE_ID || workspaceRoot).trim(),
      auditLogPath: path.resolve(values.AUDIT_LOG_PATH || path.join(baseDir, "..", "server", "audit.log")),
      audit: Object.freeze({
        maxBytes: intValue(values.AUDIT_MAX_BYTES, 10 * 1024 * 1024, 1024),
        maxFiles: intValue(values.AUDIT_MAX_FILES, 5, 1, 100),
      }),
      tokenClientMap,
      adminTokens: parseAdminTokens(values),
      dashboardEnabled: /^true$/i.test(String(values.ENABLE_DASHBOARD || "false")),
      command: Object.freeze({
        allowExec: boolValue(values.ALLOW_BASH_EXEC, true),
        allowedCommands: String(values.ALLOWED_COMMANDS || ""),
        allowedInterpreters: String(values.ALLOWED_INTERPRETERS || ""),
      }),
      exec: Object.freeze({
        timeoutMs: execTimeoutMs,
        maxTimeoutMs: intValue(values.MAX_EXEC_TIMEOUT_MS, 24 * 60 * 60_000, execTimeoutMs, 7 * 24 * 60 * 60_000),
        maxConcurrency: intValue(values.EXEC_MAX_CONCURRENCY, 2, 1, 128),
        queueTimeoutMs: intValue(values.EXEC_QUEUE_TIMEOUT_MS, 15_000, 0, 10 * 60_000),
        maxBufferBytes: intValue(values.EXEC_MAX_BUFFER_BYTES, 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      }),
      jobs: Object.freeze({
        maxConcurrency: intValue(values.JOB_MAX_CONCURRENCY || values.AGENTPORT_JOB_MAX_CONCURRENCY, 2, 1, 64),
        queueTimeoutMs: intValue(values.JOB_QUEUE_TIMEOUT_MS || values.AGENTPORT_JOB_QUEUE_TIMEOUT_MS, 15_000, 0, 10 * 60_000),
        defaultTimeoutMs: intValue(values.JOB_DEFAULT_TIMEOUT_MS || values.AGENTPORT_JOB_DEFAULT_TIMEOUT_MS, 30 * 60_000, 0, jobMaxTimeoutMs),
        maxTimeoutMs: jobMaxTimeoutMs,
        logChunkBytes: intValue(values.JOB_LOG_CHUNK_BYTES || values.JOB_LOG_TAIL_BYTES, 64 * 1024, 1024, 5 * 1024 * 1024),
      }),
    };
  }

  function setWorkspaceRoot(value) {
    runtimeWorkspaceRoot = path.resolve(String(value || ""));
  }

  function clearWorkspaceRootOverride() {
    runtimeWorkspaceRoot = "";
  }

  return Object.freeze({ load, resolveEnvPath, setWorkspaceRoot, clearWorkspaceRootOverride });
}

module.exports = {
  boolValue,
  createDaemonConfigLoader,
  decodeEnvValue,
  intValue,
  loadWorkspaceScope,
  loadWorkspaceScopeFromSources,
  parseAdminTokens,
  parseEnvText,
  parseTokenMap,
  parseWorkspaceRootsJson,
};
