import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { randomBytes } from "crypto";
import { SSHClient, SSHConnectionManager } from "./ssh-client.js";
import { scanLocalSSH, formatSSHScanSummary } from "./ssh-scanner.js";
import logger from "./logger.js";

// Node 19+ enables keep-alive on the global HTTP agents. Some lightweight
// daemon/proxy combinations close those sockets without a reusable FIN, so a
// subsequent POST can fail with ECONNRESET after the server already handled it.
// Explicit non-keepalive agents avoid stale-socket reuse and, importantly,
// avoid retrying non-idempotent job-start requests.
const HTTP_AGENT = new http.Agent({ keepAlive: false });
const HTTPS_AGENT = new https.Agent({ keepAlive: false });

let _fatalHandlerActive = false;
let _stdioExitScheduled = false;

function localErrorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function isBrokenPipeError(error) {
  const code = String(error?.code || "");
  const message = localErrorMessage(error);
  return code === "EPIPE" || /EPIPE|broken pipe/i.test(message);
}

function scheduleStdioExit(reason, error = null) {
  if (_stdioExitScheduled) return;
  _stdioExitScheduled = true;
  try {
    logger.warn("process", "Scheduling exit after stdio transport failure", {
      reason,
      error: error ? localErrorMessage(error) : undefined,
    });
  } catch {}
  setTimeout(() => process.exit(1), 20);
}

function writeStderrLine(...parts) {
  try {
    if (!process.stderr?.writable || process.stderr.destroyed || process.stderr.writableEnded) return false;
    process.stderr.write(`${parts.map((part) => String(part)).join(" ")}\n`);
    return true;
  } catch (error) {
    if (isBrokenPipeError(error)) {
      scheduleStdioExit("stderr write failed", error);
    } else {
      try {
        logger.warn("process", "Failed to write stderr", { error: localErrorMessage(error) });
      } catch {}
    }
    return false;
  }
}

function handleProcessError(kind, error) {
  const message = localErrorMessage(error);
  if (_fatalHandlerActive) {
    if (isBrokenPipeError(error)) scheduleStdioExit(`${kind} recursion hit broken pipe`, error);
    return;
  }
  _fatalHandlerActive = true;
  try {
    logger.error("process", kind, message);
    if (isBrokenPipeError(error)) {
      scheduleStdioExit(kind, error);
      return;
    }
    writeStderrLine(`[agentport] ${kind}:`, message);
  } finally {
    _fatalHandlerActive = false;
  }
}

process.on("unhandledRejection", (reason) => {
  handleProcessError("Unhandled rejection", reason);
});

process.on("uncaughtException", (error) => {
  handleProcessError("Uncaught exception", error);
});

// Read release metadata from package.json. Private local config is only a
// compatibility fallback for older copied skills that do not include it.
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_SLUG = "agentport";
const CONFIG_CANDIDATES = [join(__dirname, "local", `${APP_SLUG}.json`)];
let PKG_VERSION = "0.0.0";
let PKG_NAME = APP_SLUG;
try {
  const packageJson = JSON.parse(fs.readFileSync(join(__dirname, "package.json"), "utf-8").replace(/^\uFEFF/, ""));
  PKG_VERSION = packageJson.version || PKG_VERSION;
  PKG_NAME = packageJson.name || PKG_NAME;
} catch (_) {}
for (const configPath of CONFIG_CANDIDATES) {
  try {
    if (!fs.existsSync(configPath)) continue;
    const configJson = JSON.parse(fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/, ""));
    PKG_NAME = configJson.name || PKG_NAME;
    break;
  } catch (_) {}
}

// Support both new (MCP_REMOTE_*) and legacy (NIUMA_SSH_*) env var names
const REMOTE_URL = (process.env.MCP_REMOTE_URL || process.env.NIUMA_SSH_REMOTE_URL || "http://127.0.0.1:3183").replace(/\/+$/, "");
const AUTH_TOKEN = (process.env.MCP_REMOTE_AUTH_TOKEN || process.env.NIUMA_SSH_AUTH_TOKEN || "").trim();
const CLIENT_ID = (process.env.MCP_REMOTE_CLIENT_ID || process.env.NIUMA_SSH_CLIENT_ID || "").trim();
const rawTimeout = Number(process.env.MCP_REMOTE_TIMEOUT_MS || process.env.NIUMA_SSH_TIMEOUT_MS || 120000);
const REQUEST_TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 120000;
const rawSlowCallMs = Number(process.env.MCP_REMOTE_SLOW_CALL_MS || 30000);
const SLOW_CALL_MS = Number.isFinite(rawSlowCallMs) && rawSlowCallMs > 0 ? rawSlowCallMs : 30000;
const LOG_TOOL_START = !/^(0|false|no)$/i.test(String(process.env.MCP_REMOTE_LOG_TOOL_START || "1"));
const LOG_TOOL_SUCCESS = /^(1|true|yes)$/i.test(String(process.env.MCP_REMOTE_LOG_TOOL_SUCCESS || ""));

// --- Runtime mode (for compatibility signaling) ---
const RUNTIME_MODE_PATH = path.join(__dirname, "local", "runtime-mode.json");
const ALLOWED_RUNTIME_MODES = new Set(["auto", "native-mcp", "executable-skill"]);

function loadRuntimeMode() {
  try {
    if (!fs.existsSync(RUNTIME_MODE_PATH)) return { mode: "auto", source: "default" };
    const raw = fs.readFileSync(RUNTIME_MODE_PATH, "utf-8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    const mode = ALLOWED_RUNTIME_MODES.has(data?.mode) ? data.mode : "auto";
    return {
      mode,
      requestedMode: data?.requestedMode || mode,
      detectedMode: data?.detectedMode || "unknown",
      lastProbeAt: data?.lastProbeAt || null,
      source: "runtime-mode.json",
    };
  } catch {
    return { mode: "auto", source: "default" };
  }
}

function resolveRuntimeMode() {
  const fromFile = loadRuntimeMode();
  const envMode = String(process.env.MCP_REMOTE_RUNTIME_MODE || process.env.NIUMA_SSH_RUNTIME_MODE || "").trim();
  if (envMode && ALLOWED_RUNTIME_MODES.has(envMode)) {
    return {
      ...fromFile,
      mode: envMode,
      source: "env",
    };
  }
  return fromFile;
}

function withRuntimeMeta(obj = {}) {
  return {
    ...obj,
    runtimeMode: _runtimeMode.mode,
    modeSource: _runtimeMode.source,
  };
}

function runtimeModeHint() {
  if (_runtimeMode.mode === "native-mcp") {
    return "建议先运行 node test/test.cjs --probe --mode=native-mcp 检查注入链路。";
  }
  if (_runtimeMode.mode === "executable-skill") {
    return "建议先运行 node test/test.cjs --probe --mode=executable-skill 检查技能直连链路。";
  }
  return "建议先运行 node test/test.cjs --probe --mode=auto 检查自动模式探测结果。";
}

const _runtimeMode = resolveRuntimeMode();

let _toolCallSeq = 0;
let _loggedBeforeExit = false;
const PROCESS_STARTED_AT = Date.now();
const PROCESS_SESSION_ID = `${new Date(PROCESS_STARTED_AT).toISOString()}#${process.pid}`;
let _traceRequestSeq = 0;
let _currentTraceContext = null;
let _singletonLockPath = null;
let _singletonBroker = null;
let _proxyBroker = null;
const SINGLETON_RUNTIME_DIR = path.join(__dirname, "local", "runtime");
const SINGLETON_LOCK_PREFIX = "instance";
const RECENT_EVENTS_LIMIT = 60;
const ACTIVE_CALL_LIMIT = 20;
const _activeToolCalls = new Map();
const _recentEvents = [];
let _lastToolCall = null;
let _lastTransportEvent = null;
const _stdioState = {
  stdinEnded: false,
  stdinClosed: false,
  stdinErrored: false,
  stdoutErrored: false,
  stderrErrored: false,
};
const _transportState = {
  connected: false,
  closed: false,
  errored: false,
  connectedAt: null,
  closedAt: null,
  errorAt: null,
};

function uptimeMs() {
  return Date.now() - PROCESS_STARTED_AT;
}

function pushDiagnosticEvent(type, data = {}) {
  _recentEvents.push({
    ts: new Date().toISOString(),
    uptimeMs: uptimeMs(),
    type,
    ...data,
  });
  while (_recentEvents.length > RECENT_EVENTS_LIMIT) _recentEvents.shift();
}

function buildTraceHeaders() {
  const ctx = _currentTraceContext || {};
  const base = ctx.traceBase || `${PROCESS_SESSION_ID}`;
  const traceId = `${base}/${++_traceRequestSeq}`;
  return {
    "x-agentport-trace-id": traceId,
    "x-agentport-session-id": PROCESS_SESSION_ID,
    ...(ctx.callId ? { "x-agentport-call-id": String(ctx.callId) } : {}),
    ...(ctx.toolName ? { "x-agentport-tool": String(ctx.toolName) } : {}),
  };
}

function attachTraceInterceptors(client) {
  if (!client || client.__agentportTraceAttached) return client;
  client.__agentportTraceAttached = true;

  client.interceptors.request.use((config) => {
    const headers = buildTraceHeaders();
    config.headers = {
      ...(config.headers || {}),
      ...headers,
    };
    config.metadata = {
      startedAt: Date.now(),
      traceId: headers["x-agentport-trace-id"],
      toolName: _currentTraceContext?.toolName || null,
      callId: _currentTraceContext?.callId || null,
    };
    pushDiagnosticEvent("http.request", {
      traceId: headers["x-agentport-trace-id"],
      method: String(config.method || "get").toUpperCase(),
      url: config.url || "",
      toolName: config.metadata.toolName,
      callId: config.metadata.callId,
    });
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      const metadata = response?.config?.metadata || {};
      pushDiagnosticEvent("http.response", {
        traceId: metadata.traceId || null,
        status: response?.status,
        durationMs: Number.isFinite(metadata.startedAt) ? (Date.now() - metadata.startedAt) : null,
        url: response?.config?.url || "",
      });
      return response;
    },
    (error) => {
      const metadata = error?.config?.metadata || {};
      const status = error?.response?.status;
      const code = error?.code || error?.cause?.code || null;
      const message = error?.message || "request failed";
      pushDiagnosticEvent("http.error", {
        traceId: metadata.traceId || null,
        status: Number.isFinite(status) ? status : null,
        code,
        durationMs: Number.isFinite(metadata.startedAt) ? (Date.now() - metadata.startedAt) : null,
        url: error?.config?.url || "",
        message,
      });
      if (isNetworkError(error)) {
        logProcessEvent("warn", "HTTP transport error", {
          traceId: metadata.traceId || null,
          status: Number.isFinite(status) ? status : null,
          code,
          message,
          connection: currentConnectionSummary(),
        });
      }
      return Promise.reject(error);
    }
  );

  return client;
}

function currentConnectionSummary() {
  const conn = _currentConnection ? _connections[_currentConnection] : null;
  if (!conn) {
    return {
      name: _currentConnection || null,
      type: "daemon",
      target: REMOTE_URL,
    };
  }
  if (conn.type === "ssh") {
    return {
      name: _currentConnection,
      type: "ssh",
      target: `${conn.username || "unknown"}@${conn.host}:${conn.port || 22}`,
    };
  }
  return {
    name: _currentConnection,
    type: conn.type || "daemon",
    target: conn.url,
  };
}

function logProcessEvent(level, message, data = {}) {
  const payload = {
    sessionId: PROCESS_SESSION_ID,
    pid: process.pid,
    ppid: process.ppid,
    uptimeMs: uptimeMs(),
    ...data,
  };
  logger[level]("process", message, payload);
}

function activeCallSnapshot() {
  return [..._activeToolCalls.values()]
    .slice(-ACTIVE_CALL_LIMIT)
    .map((call) => ({
      callId: call.callId,
      toolName: call.toolName,
      ageMs: Date.now() - call.startTime,
      startedAt: call.startedAt,
      connection: call.connection,
      args: call.args,
    }));
}

function resourceUsageSnapshot() {
  try {
    return typeof process.resourceUsage === "function" ? process.resourceUsage() : null;
  } catch {
    return null;
  }
}

function diagnosticSnapshot(reason, extra = {}) {
  let connection = null;
  try {
    connection = currentConnectionSummary();
  } catch (error) {
    connection = { error: errorMessage(error) };
  }
  return {
    sessionId: PROCESS_SESSION_ID,
    reason,
    ts: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    uptimeMs: uptimeMs(),
    node: process.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    argv: process.argv,
    clientId: CLIENT_ID || null,
    runtimeMode: _runtimeMode.mode,
    modeSource: _runtimeMode.source,
    connection,
    stdio: {
      ..._stdioState,
      stdinReadableEnded: process.stdin.readableEnded,
      stdinReadableDestroyed: process.stdin.destroyed,
      stdoutWritableEnded: process.stdout.writableEnded,
      stdoutWritableDestroyed: process.stdout.destroyed,
      stderrWritableEnded: process.stderr.writableEnded,
      stderrWritableDestroyed: process.stderr.destroyed,
    },
    transport: _transportState,
    memory: process.memoryUsage(),
    resourceUsage: resourceUsageSnapshot(),
    activeCalls: activeCallSnapshot(),
    lastToolCall: _lastToolCall,
    lastTransportEvent: _lastTransportEvent,
    recentEvents: _recentEvents.slice(-20),
    ...extra,
  };
}

function markToolCallStarted(call) {
  _activeToolCalls.set(call.callId, call);
  _lastToolCall = {
    callId: call.callId,
    toolName: call.toolName,
    status: "running",
    startedAt: call.startedAt,
    args: call.args,
  };
  pushDiagnosticEvent("tool.start", {
    callId: call.callId,
    toolName: call.toolName,
    args: call.args,
  });
}

function markToolCallFinished(callId, status, durationMs, error = null) {
  const call = _activeToolCalls.get(callId);
  if (call) _activeToolCalls.delete(callId);
  _lastToolCall = {
    callId,
    toolName: call?.toolName || _lastToolCall?.toolName || "unknown",
    status,
    durationMs,
    finishedAt: new Date().toISOString(),
    error: error ? errorMessage(error) : undefined,
    errorCode: error?.code,
  };
  pushDiagnosticEvent(`tool.${status}`, _lastToolCall);
}

function sanitizeInstanceKey(value) {
  return String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80) || "default";
}

function isPidAlive(pid) {
  const parsed = Number.parseInt(String(pid), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed === process.pid) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function getSingletonLockPath() {
  const explicit = process.env.MCP_REMOTE_INSTANCE_KEY || process.env.NIUMA_SSH_INSTANCE_KEY || "";
  const instanceKey = sanitizeInstanceKey(explicit || CLIENT_ID || "default");
  return path.join(SINGLETON_RUNTIME_DIR, `${SINGLETON_LOCK_PREFIX}-${instanceKey}.lock.json`);
}

function releaseSingletonLock() {
  stopSingletonBroker();
  if (!_singletonLockPath) return;
  try {
    if (!fs.existsSync(_singletonLockPath)) {
      _singletonLockPath = null;
      return;
    }
    const content = fs.readFileSync(_singletonLockPath, "utf-8").replace(/^\uFEFF/, "");
    const data = JSON.parse(content);
    if (Number(data?.pid) === process.pid) {
      fs.unlinkSync(_singletonLockPath);
    }
  } catch {}
  _singletonLockPath = null;
}

function acquireSingletonLock() {
  fs.mkdirSync(SINGLETON_RUNTIME_DIR, { recursive: true });
  const lockPath = getSingletonLockPath();
  const payload = {
    pid: process.pid,
    ppid: process.ppid,
    startedAt: new Date(PROCESS_STARTED_AT).toISOString(),
    startedAtMs: PROCESS_STARTED_AT,
    sessionId: PROCESS_SESSION_ID,
    clientId: CLIENT_ID || null,
    argv: process.argv,
    cwd: process.cwd(),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf-8");
      fs.closeSync(fd);
      _singletonLockPath = lockPath;
      return { ok: true, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return { ok: false, reason: `lock-write-failed: ${errorMessage(error)}`, lockPath };
      }
      let existing = null;
      try {
        const content = fs.readFileSync(lockPath, "utf-8").replace(/^\uFEFF/, "");
        existing = JSON.parse(content);
      } catch {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      const existingPid = Number(existing?.pid || 0);
      if (!isPidAlive(existingPid)) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      return {
        ok: false,
        duplicate: true,
        reason: "existing-instance-alive",
        lockPath,
        existing: {
          pid: existingPid,
          sessionId: existing?.sessionId || null,
          startedAt: existing?.startedAt || null,
          clientId: existing?.clientId || null,
          broker: existing?.broker || null,
        },
      };
    }
  }
  return { ok: false, reason: "lock-acquire-retry-exhausted", lockPath };
}

function writeProcessRegistry() {
  try {
    const logDir = path.join(__dirname, "local", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const registryPath = path.join(logDir, "agentport-processes.json");
    const now = Date.now();
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(registryPath, "utf-8").replace(/^\uFEFF/, ""));
      if (!Array.isArray(entries)) entries = [];
    } catch {
      entries = [];
    }
    const recent = entries.filter((entry) => {
      const ageMs = now - Number(entry.startedAtMs || 0);
      return entry.pid !== process.pid && ageMs >= 0 && ageMs < 30 * 60 * 1000;
    });
    if (recent.length) {
      logProcessEvent("warn", "Recent MCP client processes found", {
        registryPath,
        recent,
        hint: "If Transport closed is frequent, check whether the desktop host is spawning multiple MCP stdio clients for the same skill.",
      });
    }
    entries = [
      ...recent.slice(-20),
      {
        sessionId: PROCESS_SESSION_ID,
        pid: process.pid,
        ppid: process.ppid,
        startedAt: new Date(PROCESS_STARTED_AT).toISOString(),
        startedAtMs: PROCESS_STARTED_AT,
        execPath: process.execPath,
        argv: process.argv,
        cwd: process.cwd(),
        clientId: CLIENT_ID || null,
        runtimeMode: _runtimeMode.mode,
      },
    ];
    fs.writeFileSync(registryPath, JSON.stringify(entries, null, 2), "utf-8");
  } catch (error) {
    logProcessEvent("warn", "Failed to write process registry", {
      error: errorMessage(error),
    });
  }
}

function boolFlag(value) {
  return value ? true : undefined;
}

function summarizeArgs(toolName, args = {}) {
  const summary = {};
  const safeKeys = [
    "path",
    "cwd",
    "pattern",
    "connection",
    "action",
    "taskId",
    "host",
    "port",
    "username",
    "interpreter",
    "caseSensitive",
    "regex",
    "maxResults",
  ];
  for (const key of safeKeys) {
    if (args[key] !== undefined) summary[key] = args[key];
  }
  if (typeof args.command === "string") summary.commandBytes = Buffer.byteLength(args.command);
  if (typeof args.content === "string") summary.contentBytes = Buffer.byteLength(args.content);
  if (typeof args.config === "string") summary.configBytes = Buffer.byteLength(args.config);
  if (typeof args.password === "string") summary.hasPassword = boolFlag(args.password);
  if (typeof args.privateKey === "string") summary.hasPrivateKey = boolFlag(args.privateKey);
  if (typeof args.passphrase === "string") summary.hasPassphrase = boolFlag(args.passphrase);
  if (Array.isArray(args.operations)) summary.operations = args.operations.map((op) => op?.type || "unknown");
  if (Array.isArray(args.include)) summary.includeCount = args.include.length;
  if (Array.isArray(args.excludeDirs)) summary.excludeDirsCount = args.excludeDirs.length;
  if (!Object.keys(summary).length) summary.argKeys = Object.keys(args);
  summary.tool = toolName;
  return summary;
}

function isLikelyTimeoutError(error) {
  const message = errorMessage(error).toLowerCase();
  return error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || message.includes("timeout");
}

function timeoutHint(durationMs, error) {
  if (durationMs >= REQUEST_TIMEOUT_MS - 1000 || isLikelyTimeoutError(error)) {
    return "Request reached the local MCP timeout. For long commands, use remote_exec_async and poll remote_task; if stdio closes, restart stale Codex MCP child sessions.";
  }
  if (durationMs >= SLOW_CALL_MS) {
    return "Slow remote call. Check remote daemon load, network latency, and queued exec count with remote_status.";
  }
  return undefined;
}

process.on("warning", (warning) => {
  logProcessEvent("warn", "Process warning", {
    name: warning.name,
    message: warning.message,
    stack: warning.stack,
  });
});

process.on("beforeExit", (code) => {
  if (_loggedBeforeExit) return;
  _loggedBeforeExit = true;
  releaseSingletonLock();
  pushDiagnosticEvent("process.beforeExit", { code, activeCallCount: _activeToolCalls.size });
  logProcessEvent("warn", "Process beforeExit", {
    code,
    diagnostic: diagnosticSnapshot("process.beforeExit"),
  });
});

process.on("exit", (code) => {
  releaseSingletonLock();
  pushDiagnosticEvent("process.exit", { code, activeCallCount: _activeToolCalls.size });
  logProcessEvent(code === 0 ? "info" : "error", "Process exit", {
    code,
    diagnostic: diagnosticSnapshot("process.exit"),
  });
});

process.on("disconnect", () => {
  releaseSingletonLock();
  pushDiagnosticEvent("process.disconnect", { activeCallCount: _activeToolCalls.size });
  logProcessEvent("warn", "Process disconnect", {
    diagnostic: diagnosticSnapshot("process.disconnect"),
  });
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  try {
    process.on(signal, () => {
      releaseSingletonLock();
      pushDiagnosticEvent("process.signal", { signal, activeCallCount: _activeToolCalls.size });
      logProcessEvent("warn", `Received ${signal}`, {
        signal,
        diagnostic: diagnosticSnapshot(`signal.${signal}`),
      });
      process.exit(0);
    });
  } catch {}
}

// --- Dynamic connection management ---
let _connections = {};
let _currentConnection = null;
let _connectionAxios = null;
let _sshManager = new SSHConnectionManager();

function loadConnections() {
  try {
    const configPath = path.join(__dirname, 'local', 'connections.json');
    if (fs.existsSync(configPath)) {
      const configText = fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
      const config = JSON.parse(configText);
      _connections = {};
      for (const conn of config.connections || []) {
        _connections[conn.name] = conn;
        // Register SSH connections
        if (conn.type === 'ssh') {
          _sshManager.addConnection(conn.name, conn);
        }
      }
      return config.default || Object.keys(_connections)[0];
    }
  } catch (e) {
    writeStderrLine("Failed to load connections.json:", e.message);
  }
  return null;
}

function getAxiosInstance(connectionName) {
  if (connectionName && _connections[connectionName]) {
    const conn = _connections[connectionName];
    if (conn.type === 'ssh') {
      throw new Error('Cannot use axios for SSH connection. Use SSH client instead.');
    }
    return attachTraceInterceptors(axios.create({
      baseURL: conn.url.replace(/\/+$/, ''),
      timeout: REQUEST_TIMEOUT_MS,
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      headers: {
        ...(conn.authToken ? { authorization: `Bearer ${conn.authToken}` } : {}),
        ...(conn.clientId ? { "x-mcp-client-id": conn.clientId } : {}),
        "Content-Type": "application/json",
      },
    }));
  }
  return axiosInstance;
}

function getCurrentAxios() {
  return _connectionAxios || axiosInstance;
}

function isSSHConnection(connectionName) {
  const name = connectionName || _currentConnection;
  return name && _connections[name]?.type === 'ssh';
}

function getSSHClient(connectionName) {
  const name = connectionName || _currentConnection;
  if (!name || !_connections[name] || _connections[name].type !== 'ssh') {
    throw new Error('Not an SSH connection');
  }
  return _sshManager.switchConnection(name);
}

function explicitToolConnection(args = {}) {
  return typeof args.connection === "string" && args.connection.trim() ? args.connection.trim() : "";
}

function failClosedToolConnectionError() {
  const names = Object.keys(_connections).join(", ");
  return [
    "Multiple connections are configured; this tool call requires an explicit connection.",
    `Available connections: ${names || "(none)"}.`,
    "Do not rely on current connection for write, exec, script, batch, async task, or config operations.",
  ].join(" ");
}

function batchHasRiskyOperations(operations) {
  return Array.isArray(operations) && operations.some((op) => {
    const type = String(op?.type || "").toLowerCase();
    return type === "write" || type === "bash" || type === "script" || type === "exec";
  });
}

function toolRequiresExplicitConnection(toolName, args = {}) {
  if (Object.keys(_connections).length <= 1) return false;
  if (explicitToolConnection(args)) return false;
  if (toolName === "remote_write" || toolName === "remote_bash" || toolName === "remote_script" || toolName === "remote_script_async") return true;
  if (toolName === "remote_exec_async" || toolName === "remote_task") return true;
  if (toolName === "remote_config" && String(args.action || "").toLowerCase() === "write") return true;
  if (toolName === "remote_batch" && batchHasRiskyOperations(args.operations)) return true;
  return false;
}

function setActiveConnection(connectionName) {
  if (!_connections[connectionName]) {
    throw new Error(`Connection '${connectionName}' not found. Available: ${Object.keys(_connections).join(", ")}`);
  }
  _currentConnection = connectionName;
  const conn = _connections[connectionName];
  _connectionAxios = conn.type === "ssh" ? null : getAxiosInstance(connectionName);
  return conn;
}

function applyPerCallConnection(toolName, args = {}) {
  if (toolName === "remote_connect" || toolName === "remote_setup" || toolName === "remote_ssh_info") {
    return null;
  }
  loadConnections();
  const previous = {
    connection: _currentConnection,
    axios: _connectionAxios,
  };
  const explicit = explicitToolConnection(args);
  if (explicit) {
    setActiveConnection(explicit);
    return () => {
      _currentConnection = previous.connection;
      _connectionAxios = previous.axios;
    };
  }
  if (toolRequiresExplicitConnection(toolName, args)) {
    throw new Error(failClosedToolConnectionError());
  }
  return null;
}

// --- Connection health cache ---
const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _lastHealthTime = 0;
let _isHealthy = false;
let _workspaceRoot = ""; // Cached from healthz response

// --- Read content ETag cache (for 304 Not Modified support) ---
const _etagCache = new Map(); // path -> { etag, content, timestamp }
const ETAG_CACHE_MAX = 200;   // max cached files
const ETAG_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// --- Operation statistics ---
let _stats = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  retries: 0,
  errors: 0,
  startTime: Date.now(),
  lastOperation: null,
  lastOperationTime: null,
};

function isHealthCacheValid() {
  return _isHealthy && (Date.now() - _lastHealthTime) < HEALTH_CACHE_TTL_MS;
}

function markHealthy(workspaceRoot) {
  _isHealthy = true;
  _lastHealthTime = Date.now();
  if (typeof workspaceRoot === "string" && workspaceRoot) _workspaceRoot = workspaceRoot;
}

function markUnhealthy() {
  _isHealthy = false;
  _lastHealthTime = 0;
}

function recordOp(opName) {
  _stats.totalRequests++;
  _stats.lastOperation = opName;
  _stats.lastOperationTime = new Date().toISOString();
}

function getEtagCache(filePath) {
  const entry = _etagCache.get(filePath);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ETAG_CACHE_TTL_MS) {
    _etagCache.delete(filePath);
    return null;
  }
  return entry;
}

function setEtagCache(filePath, etag, content) {
  // Evict oldest entries if cache is full
  if (_etagCache.size >= ETAG_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _etagCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) _etagCache.delete(oldestKey);
  }
  _etagCache.set(filePath, { etag, content, timestamp: Date.now() });
}

// --- Network error detection ---
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN",
]);

// --- Interpreter whitelist (for remote_script) ---
const ALLOWED_INTERPRETERS = new Set(["bash", "sh", "python3", "python", "node", "ruby", "perl", "dash", "zsh"]);

// --- Bash special character detection & base64 escape ---
const BASH_SPECIAL_CHARS = /[$`\\!"#;&|<>(){}~\r\n]/;

function needsBase64Escape(str) {
  return BASH_SPECIAL_CHARS.test(str) || str.includes("'");
}

function wrapBase64Command(command) {
  const b64 = Buffer.from(command, "utf-8").toString("base64");
  return `printf '%s' '${b64}' | base64 -d | bash`;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function asyncTimeoutMs(value, fallback = 1800000) {
  const resolved = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 0 || (resolved > 0 && resolved < 1000)) {
    throw new Error("timeoutMs must be 0 or an integer >= 1000");
  }
  return resolved;
}

function buildAsyncScriptWrapper(content, interpreter) {
  let marker;
  do {
    marker = `AGENTPORT_ASYNC_${randomBytes(12).toString("hex").toUpperCase()}`;
  } while (String(content).split(/\r?\n/).includes(marker));
  return [
    "#!/usr/bin/env bash",
    "set +e",
    'cleanup() { rm -f -- "$0"; }',
    "trap 'code=$?; cleanup; exit \"$code\"' EXIT",
    "trap 'exit 143' HUP INT TERM",
    `${shellSingleQuote(interpreter)} - <<'${marker}'`,
    String(content).replace(/\n$/, ""),
    marker,
    "",
  ].join("\n");
}

// --- Content sanitization for remote_write ---
const PRESERVE_CRLF = (process.env.MCP_REMOTE_PRESERVE_CRLF || process.env.NIUMA_SSH_PRESERVE_CRLF || "").trim() === "true";

function sanitizeContent(content) {
  if (!PRESERVE_CRLF) {
    content = content.replace(/\r\n/g, "\n");
  }
  if (content.startsWith("\uFEFF")) {
    content = content.slice(1);
  }
  return content;
}

// --- Health check error result ---
function healthCheckError(message) {
  const text = `${message}\n\n[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}. ${runtimeModeHint()}`;
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

async function ensureHealthy(hint) {
  if (isHealthCacheValid()) return;
  try {
    const probe = await getCurrentAxios().get("/healthz", { validateStatus: () => true, timeout: 5000 });
    if (probe.status === 200) markHealthy(probe.data?.workspaceRoot);
  } catch (_) {}
  if (!isHealthCacheValid()) {
    const msg = hint || "Consider calling remote_health first to check if the remote service is reachable.";
    throw Object.assign(new Error(`⚠️ Remote connection status unknown. ${msg}`), { _isHealthError: true });
  }
}

function isHealthError(error) {
  return error?._isHealthError === true;
}

function isNetworkError(error) {
  const code = error?.code || error?.cause?.code;
  if (NETWORK_ERROR_CODES.has(code)) return true;
  // Axios wraps network errors with no response
  if (!error?.response && NETWORK_ERROR_CODES.has(error?.errno)) return true;
  return false;
}

// --- Retry with delay ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 1;

const server = new Server(
  {
    name: PKG_NAME,
    version: PKG_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const axiosInstance = attachTraceInterceptors(axios.create({
  baseURL: REMOTE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  httpAgent: HTTP_AGENT,
  httpsAgent: HTTPS_AGENT,
  headers: {
    ...(AUTH_TOKEN ? { authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    ...(CLIENT_ID ? { "x-mcp-client-id": CLIENT_ID } : {}),
    "Content-Type": "application/json",
  },
}));

function getArguments(request) {
  const args = request?.params?.arguments;
  return args && typeof args === "object" ? args : {};
}

function requireNonEmptyString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid '${key}': expected a non-empty string.`);
  }
  return value;
}

async function postWithFallback(paths, payload, retryCount = 0) {
  let lastError;
  for (const path of paths) {
    try {
      const response = await getCurrentAxios().post(path, payload);
      return response.data ?? {};
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404 || status === 405) {
        lastError = error;
        continue;
      }
      // Network error: retry once with delay
      if (isNetworkError(error) && retryCount < MAX_RETRIES) {
        _stats.retries++;
        writeStderrLine(`Network error on ${path}: ${error.code || error.message}. Retrying in ${RETRY_DELAY_MS}ms... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await sleep(RETRY_DELAY_MS);
        return postWithFallback(paths, payload, retryCount + 1);
      }
      throw error;
    }
  }
  // Fallback paths all returned 404/405, retry once on network level
  if (isNetworkError(lastError) && retryCount < MAX_RETRIES) {
    _stats.retries++;
    writeStderrLine(`Network error on fallback. Retrying in ${RETRY_DELAY_MS}ms... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
    await sleep(RETRY_DELAY_MS);
    return postWithFallback(paths, payload, retryCount + 1);
  }
  throw lastError || new Error("Remote request failed.");
}

function errorMessage(error) {
  const status = error?.response?.status;
  const remoteMessage = error?.response?.data?.error || error?.response?.data?.message;
  const base = remoteMessage || error?.message || "Unknown error";
  const exec = error?.response?.data?.exec;
  const execHint = exec ? ` exec=${JSON.stringify(exec)}` : "";
  return status ? `${base} (HTTP ${status})${execHint}` : base;
}

function toTextResult(text) {
  return {
    content: [
      {
        type: "text",
        text: String(text),
      },
    ],
  };
}

function writeJsonResponse(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function randomToken() {
  return randomBytes(20).toString("hex");
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Body too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${errorMessage(error)}`));
      }
    });
    req.on("error", reject);
  });
}

function updateSingletonLockFile(update = {}) {
  if (!_singletonLockPath) return false;
  try {
    const currentText = fs.readFileSync(_singletonLockPath, "utf-8").replace(/^\uFEFF/, "");
    const current = JSON.parse(currentText);
    if (Number(current?.pid) !== process.pid) return false;
    const next = {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(_singletonLockPath, JSON.stringify(next, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

function getProxyBrokerHeaders() {
  if (!_proxyBroker?.token) return {};
  return { "x-agentport-broker-token": _proxyBroker.token };
}

async function proxyListToolsRequest() {
  if (!_proxyBroker?.url) throw new Error("Proxy broker is not configured.");
  const response = await axios.get(`${_proxyBroker.url}/mcp-tools`, {
    timeout: Math.min(REQUEST_TIMEOUT_MS, 30000),
    headers: getProxyBrokerHeaders(),
  });
  return response.data;
}

async function proxyCallToolRequest(name, args) {
  if (!_proxyBroker?.url) throw new Error("Proxy broker is not configured.");
  const response = await axios.post(
    `${_proxyBroker.url}/mcp-call`,
    { name, arguments: args || {} },
    {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "content-type": "application/json",
        ...getProxyBrokerHeaders(),
      },
    }
  );
  return response.data;
}

async function startSingletonBroker() {
  if (_singletonBroker?.server) return _singletonBroker;

  const authToken = randomToken();
  const localServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const token = req.headers["x-agentport-broker-token"] || url.searchParams.get("token");
      if (token !== authToken) {
        writeJsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        writeJsonResponse(res, 200, { ok: true, pid: process.pid, sessionId: PROCESS_SESSION_ID });
        return;
      }

      if (req.method === "GET" && url.pathname === "/mcp-tools") {
        const handler = server?._requestHandlers?.get("tools/list");
        if (typeof handler !== "function") {
          writeJsonResponse(res, 500, { ok: false, error: "tools/list handler unavailable" });
          return;
        }
        const result = await handler({ method: "tools/list", params: {} }, { sessionId: `broker:${PROCESS_SESSION_ID}` });
        writeJsonResponse(res, 200, result || { tools: [] });
        return;
      }

      if (req.method === "POST" && url.pathname === "/mcp-call") {
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        const toolName = typeof body?.name === "string" ? body.name : "";
        const toolArgs = body?.arguments && typeof body.arguments === "object" ? body.arguments : {};
        if (!toolName) {
          writeJsonResponse(res, 400, { ok: false, error: "name is required" });
          return;
        }
        const handler = server?._requestHandlers?.get("tools/call");
        if (typeof handler !== "function") {
          writeJsonResponse(res, 500, { ok: false, error: "tools/call handler unavailable" });
          return;
        }
        const result = await handler(
          {
            method: "tools/call",
            params: {
              name: toolName,
              arguments: toolArgs,
            },
          },
          { sessionId: `broker:${PROCESS_SESSION_ID}` }
        );
        writeJsonResponse(res, 200, result || toTextResult(""));
        return;
      }

      writeJsonResponse(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      writeJsonResponse(res, 500, { ok: false, error: errorMessage(error) });
    }
  });

  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = localServer.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) throw new Error("Failed to allocate local broker port.");

  _singletonBroker = {
    token: authToken,
    port,
    url: `http://127.0.0.1:${port}`,
    server: localServer,
    startedAt: new Date().toISOString(),
  };
  return _singletonBroker;
}

function stopSingletonBroker() {
  const broker = _singletonBroker;
  _singletonBroker = null;
  if (!broker?.server) return;
  try {
    broker.server.close();
  } catch {}
}

function normalizeGlobEntries(data) {
  if (Array.isArray(data?.entries)) return data.entries;
  if (Array.isArray(data?.files)) return data.files;
  if (Array.isArray(data)) return data;
  return [];
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return undefined;
}

function clampPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function buildSshGrepCommand(args) {
  const pattern = requireNonEmptyString(args, "pattern");
  const include = normalizeStringArray(args.include) || ["*"];
  const excludeDirs = normalizeStringArray(args.excludeDirs) || [
    "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__",
  ];
  const maxResults = clampPositiveInt(args.maxResults, 200, 1, 5000);
  const flags = ["-RIn", "--binary-files=without-match"];
  if (!args.caseSensitive) flags.push("-i");
  if (!args.regex) flags.push("-F");
  for (const item of include) flags.push(`--include=${JSON.stringify(item)}`);
  for (const dir of excludeDirs) flags.push(`--exclude-dir=${JSON.stringify(dir)}`);
  const command = `grep ${flags.join(" ")} -- ${JSON.stringify(pattern)} . 2>/dev/null | head -n ${maxResults} || true`;
  return args.cwd ? `cd ${JSON.stringify(args.cwd)} && ${command}` : command;
}

function parseSshGrepOutput(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const first = line.indexOf(":");
      const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
      if (first < 0 || second < 0) return { path: line, line: null, text: "" };
      return {
        path: line.slice(0, first).replace(/^\.\//, ""),
        line: Number.parseInt(line.slice(first + 1, second), 10) || null,
        text: line.slice(second + 1),
      };
    });
}

function formatExecOutput(data) {
  const chunks = [];
  if (data?.stdout) chunks.push(`STDOUT:\n${data.stdout}`);
  if (data?.stderr) chunks.push(`STDERR:\n${data.stderr}`);
  if (data?.error) chunks.push(`ERROR:\n${data.error}`);
  // Normalize: server returns `code` for sync exec, `exitCode` for async task
  const exitCode = data?.code ?? data?.exitCode;
  if (typeof exitCode === "number") chunks.push(`EXIT_CODE: ${exitCode}`);
  return chunks.join("\n\n").trim() || "Command executed successfully with no output.";
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (_proxyBroker) {
    try {
      return await proxyListToolsRequest();
    } catch (error) {
      logProcessEvent("warn", "Proxy tools/list failed, fallback to local handlers", {
        error: errorMessage(error),
        broker: _proxyBroker,
      });
    }
  }

  return {
    tools: [
    {
      name: "remote_connect",
      description: "Switch remote connection target. View available connections or switch to a specific one.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Connection name to switch to. Leave empty to return available connections list.",
          },
        },
      },
    },
    {
      name: "remote_health",
      description: "Check if remote daemon is reachable. Must be called before first operation.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Optional connection name for this call only.",
          },
        },
      },
    },
    {
      name: "remote_read",
      description: "Read remote workspace file content. Supports ETag cache and conditional read.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Optional connection name for this call only.",
          },
          path: {
            type: "string",
            description: "Remote file path. Supports absolute or workspace-relative path.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "remote_write",
      description: "Write file to remote workspace. Auto CRLF→LF and BOM cleanup. Supports optimistic concurrency lock (expectedEtag).",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required when multiple connections are configured. Applies to this write call only.",
          },
          path: {
            type: "string",
            description: "Remote file path. Supports absolute or workspace-relative path.",
          },
          content: {
            type: "string",
            description: "UTF-8 text content to write. Auto cleans Windows line endings and BOM.",
          },
          expectedEtag: {
            type: "string",
            description: "Optional. Optimistic concurrency lock token to prevent overwriting others' changes.",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "remote_stat",
      description: "Get remote file metadata (size, modified time, is file/directory). Does not read file content.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Optional connection name for this call only.",
          },
          path: {
            type: "string",
            description: "Remote file path. Supports absolute or workspace-relative path.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "remote_glob",
      description: "Search remote workspace files by glob pattern, e.g. **/*.ts, src/**/*.py.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Optional connection name for this call only.",
          },
          pattern: {
            type: "string",
            description: "Glob pattern, e.g. **/*.ts, src/**/*.py.",
          },
          cwd: {
            type: "string",
            description: "Optional. Search start directory.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "remote_grep",
      description: "Search remote workspace file contents. Daemon mode uses built-in Node search; SSH fallback uses grep/find-compatible shell search.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Optional connection name for this call only.",
          },
          pattern: {
            type: "string",
            description: "Text or regex pattern to search for.",
          },
          cwd: {
            type: "string",
            description: "Optional. Search start directory.",
          },
          include: {
            type: "array",
            items: { type: "string" },
            description: "Optional glob include patterns, e.g. ['**/*.ts', '**/*.py']. Default: ['**/*'].",
          },
          excludeDirs: {
            type: "array",
            items: { type: "string" },
            description: "Optional directory names to exclude. Defaults include node_modules, .git, dist, build, .next, .cache.",
          },
          maxResults: {
            type: "integer",
            description: "Optional maximum matches to return. Default 200, max 5000.",
          },
          maxFileBytes: {
            type: "integer",
            description: "Optional daemon-mode per-file size limit. Default 1048576.",
          },
          caseSensitive: {
            type: "boolean",
            description: "Optional. Default false.",
          },
          regex: {
            type: "boolean",
            description: "Optional. Treat pattern as regex. Default false for literal search.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "remote_status",
      description: "Get comprehensive connection diagnostics: status, latency, cache hit rate, operation stats.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Optional connection name for this call only.",
          },
        },
      },
    },
    {
      name: "remote_bash",
      description: "Execute bash command on remote Linux host. Commands with special chars ($ ` \\ etc.) are auto base64 encoded to avoid escaping issues.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required when multiple connections are configured. Applies to this bash call only.",
          },
          command: {
            type: "string",
            description: "Bash command to execute. Commands with special chars ($ ` \\ ! \" # ; & |) are auto base64 encoded.",
          },
          cwd: {
            type: "string",
            description: "Optional. Working directory.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "remote_script",
      description: "Execute multi-line script on remote host. Script is written to temp file then executed, completely avoiding bash escaping and encoding issues. Ideal for complex scripts with variables/template strings/unicode.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required when multiple connections are configured. Applies to this script call only.",
          },
          content: {
            type: "string",
            description: "Script content. Written to remote temp file as-is, not parsed by bash -c.",
          },
          interpreter: {
            type: "string",
            description: "Script interpreter, default bash. Supports bash, sh, python3, node, etc.",
          },
          cwd: {
            type: "string",
            description: "Optional. Working directory.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "remote_script_async",
      description: "Submit a multi-line script as a persistent daemon job. Returns taskId immediately; use remote_task to query status and logs. Preferred for builds, tests, installs, and scripts longer than 10 seconds.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required when multiple connections are configured. Must select a daemon connection.",
          },
          content: {
            type: "string",
            description: "Script content. Uploaded through the MCP channel without PowerShell or shell escaping.",
          },
          interpreter: {
            type: "string",
            description: "Script interpreter, default bash. Uses the same whitelist as remote_script.",
          },
          cwd: {
            type: "string",
            description: "Working directory. Defaults to the daemon workspace root.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            description: "Remote job timeout in milliseconds. Defaults to 1800000 (30 minutes); 0 disables the timeout.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "remote_batch",
      description: "Batch execute multiple operations (read/stat/glob/bash). Max 20 per request, more efficient than multiple individual calls.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required when operations include write/bash. Applies to this batch call only.",
          },
          operations: {
            type: "array",
            description: "Operations array. Each item contains type (read|stat|glob|grep|bash) and corresponding parameters.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["read", "stat", "glob", "grep", "bash"] },
                path: { type: "string" },
                pattern: { type: "string" },
                cwd: { type: "string" },
                command: { type: "string" },
              },
              required: ["type"],
            },
          },
        },
        required: ["operations"],
      },
    },
    {
      name: "remote_exec_async",
      description: "Async execute long-running bash command. Returns taskId immediately, use remote_task to query results.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required when multiple connections are configured. Applies to this async exec call only.",
          },
          command: {
            type: "string",
            description: "Bash command to execute asynchronously.",
          },
          cwd: {
            type: "string",
            description: "Optional. Working directory.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            description: "Remote job timeout in milliseconds. Defaults to the daemon setting; 0 disables the timeout.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "remote_task",
      description: "Query async command status and output. taskId is returned by remote_exec_async.",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required when multiple connections are configured. Applies to this task query only.",
          },
          taskId: {
            type: "string",
            description: "Task ID returned by remote_exec_async.",
          },
        },
        required: ["taskId"],
      },
    },
    {
      name: "remote_config",
      description: "Read or modify remote daemon config (.env). Auto hot reload after modify, no restart needed. Supports GET (read) and PUT (write+reload).",
      inputSchema: {
        type: "object",
        properties: {
          connection: {
            type: "string",
            description: "Required for write when multiple connections are configured. Applies to this config call only.",
          },
          action: {
            type: "string",
            enum: ["read", "write"],
            description: "read=read current config, write=write new config and hot reload.",
          },
          config: {
            type: "string",
            description: "New .env content for write operation (full replacement).",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "remote_setup",
      description: "Guided server connection setup. Collect server info, test connection, save config. Supports password and key authentication.",
      inputSchema: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "Server address (IP or domain).",
          },
          port: {
            type: "number",
            description: "SSH port, default 22.",
          },
          username: {
            type: "string",
            description: "Login username.",
          },
          password: {
            type: "string",
            description: "Login password (either password or privateKey required).",
          },
          privateKey: {
            type: "string",
            description: "Private key file path (either password or privateKey required).",
          },
          passphrase: {
            type: "string",
            description: "Private key passphrase (if key is password-protected).",
          },
          name: {
            type: "string",
            description: "Connection name for future reference. Auto-generated if not provided.",
          },
          description: {
            type: "string",
            description: "Connection description.",
          },
          testOnly: {
            type: "boolean",
            description: "Test connection only, don't save config. Default false.",
          },
          deploy: {
            type: "boolean",
            description: "Whether to deploy/update remote daemon files. Default false (safe client-only mode).",
          },
          forceDeploy: {
            type: "boolean",
            description: "When deploy=true and daemon exists, force overwrite server files and .env. Default false.",
          },
          daemonPort: {
            type: "number",
            description: "Remote daemon port, default 3183.",
          },
        },
        required: ["host", "username"],
      },
    },
    {
      name: "remote_ssh_info",
      description: "Scan local SSH environment: available private keys, SSH config hosts, known_hosts entries, and saved connections. Use this BEFORE remote_setup to discover what SSH resources are available on this machine.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const startTime = Date.now();
  const callId = ++_toolCallSeq;
  const previousTraceContext = _currentTraceContext;
  let args = {};
  let caughtError = null;
  let callInfo = null;
  let restoreCallConnection = null;
  
  try {
    args = getArguments(request);
    restoreCallConnection = applyPerCallConnection(toolName, args);
    const argSummary = summarizeArgs(toolName, args);
    callInfo = {
      callId,
      toolName,
      startTime,
      startedAt: new Date(startTime).toISOString(),
      connection: currentConnectionSummary(),
      args: argSummary,
    };
    _currentTraceContext = {
      callId,
      toolName,
      traceBase: `${PROCESS_SESSION_ID}:${callId}`,
    };
    markToolCallStarted(callInfo);
    
    if (LOG_TOOL_START) {
      logger.info(toolName, `Start call #${callId}`, {
        callId,
        sessionId: PROCESS_SESSION_ID,
        connection: callInfo.connection,
        args: argSummary,
      });
    }

    if (_proxyBroker) {
      try {
        return await proxyCallToolRequest(toolName, args);
      } catch (error) {
        logProcessEvent("warn", "Proxy tools/call failed, fallback to local handlers", {
          toolName,
          error: errorMessage(error),
          broker: _proxyBroker,
        });
      }
    }

    switch (toolName) {
      case "remote_connect": {
        recordOp("remote_connect");
        const connectionName = args.connection;
        
        // Refresh connection metadata so newly added local/connections.json entries
        // are available without waiting for a new desktop session.
        loadConnections();
        
        // If no connection specified, return available connections
        if (!connectionName) {
          const connList = Object.entries(_connections).map(([name, conn]) => ({
            name,
            type: conn.type || 'daemon',
            description: conn.description,
            url: conn.type === 'ssh' ? `ssh://${conn.host}:${conn.port || 22}` : conn.url,
            current: name === _currentConnection
          }));
          return toTextResult(JSON.stringify({
            current: _currentConnection,
            connections: connList
          }, null, 2));
        }
        
        // Switch to specified connection
        if (!_connections[connectionName]) {
          return toTextResult(JSON.stringify({
            error: `Connection '${connectionName}' not found`,
            available: Object.keys(_connections)
          }));
        }
        
        _currentConnection = connectionName;
        const conn = _connections[connectionName];
        
        if (conn.type === 'ssh') {
          // SSH connection
          _connectionAxios = null;
          try {
            const sshClient = getSSHClient(connectionName);
            await sshClient.connect();
            return toTextResult(JSON.stringify({
              success: true,
              current: connectionName,
              type: 'ssh',
              host: conn.host,
              port: conn.port || 22,
              username: conn.username,
              runtimeMode: _runtimeMode.mode,
              modeSource: _runtimeMode.source,
            }));
          } catch (error) {
            return toTextResult(JSON.stringify({
              error: `SSH connection failed: ${error.message}`,
              current: connectionName
            }));
          }
        } else {
          // Daemon connection
          _connectionAxios = getAxiosInstance(connectionName);
          return toTextResult(JSON.stringify({
            success: true,
            current: connectionName,
            type: 'daemon',
            url: conn.url,
            runtimeMode: _runtimeMode.mode,
            modeSource: _runtimeMode.source,
          }));
        }
      }
      
      case "remote_health": {
        recordOp("remote_health");
        
        // Check if current connection is SSH
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            // Best-effort workspace root detection so the SSH channel can
            // enforce the same boundary as the daemon channel. Never throws;
            // absence leaves the client unconstrained (legacy behavior).
            try { await sshClient.detectWorkspaceRoot(); } catch {}
            const wsRoot = sshClient.workspaceRoot || null;
            if (wsRoot) markHealthy(wsRoot); else markHealthy();
            if (sshClient.isConnected()) {
              return toTextResult(
                JSON.stringify({
                  ok: true,
                  type: 'ssh',
                  connection: _currentConnection || 'default',
                  host: _connections[_currentConnection]?.host,
                  port: _connections[_currentConnection]?.port || 22,
                  username: _connections[_currentConnection]?.username,
                  workspaceRoot: wsRoot,
                  workspaceRootEnforced: Boolean(wsRoot),
                  runtimeMode: _runtimeMode.mode,
                  modeSource: _runtimeMode.source,
                }, null, 2)
              );
            } else {
              // Try to connect
              await sshClient.connect();
              return toTextResult(
                JSON.stringify({
                  ok: true,
                  type: 'ssh',
                  connection: _currentConnection || 'default',
                  host: _connections[_currentConnection]?.host,
                  port: _connections[_currentConnection]?.port || 22,
                  username: _connections[_currentConnection]?.username,
                  workspaceRoot: wsRoot,
                  workspaceRootEnforced: Boolean(wsRoot),
                  message: 'Connected successfully',
                  runtimeMode: _runtimeMode.mode,
                  modeSource: _runtimeMode.source,
                }, null, 2)
              );
            }
          } catch (error) {
            return toTextResult(
              JSON.stringify({
                ok: false,
                type: 'ssh',
                connection: _currentConnection || 'default',
                error: error.message,
              }, null, 2)
            );
          }
        }
        
        // Daemon mode
        const healthAxios = getCurrentAxios();
        const currentUrl = _currentConnection ? _connections[_currentConnection]?.url : REMOTE_URL;
        // Try lightweight GET /healthz first, fallback to POST echo
        try {
          const healthResp = await healthAxios.get("/healthz", { validateStatus: () => true, timeout: 5000 });
          if (healthResp.status === 200) {
            markHealthy(healthResp.data?.workspaceRoot);
            return toTextResult(
              JSON.stringify(
                {
                  ok: true,
                  type: 'daemon',
                  remoteUrl: currentUrl,
                  connection: _currentConnection || 'default',
                  authEnabled: Boolean(AUTH_TOKEN),
                  clientId: CLIENT_ID || null,
                  timeoutMs: REQUEST_TIMEOUT_MS,
                  healthCacheTTL: HEALTH_CACHE_TTL_MS,
                  cacheValidUntil: new Date(_lastHealthTime + HEALTH_CACHE_TTL_MS).toISOString(),
                  runtimeMode: _runtimeMode.mode,
                  modeSource: _runtimeMode.source,
                  remoteInfo: healthResp.data || null,
                },
                null,
                2
              )
            );
          }
        } catch (_) {
          // /healthz failed, fall through to POST echo probe
        }
        // Fallback: execute echo command to verify daemon is reachable
        await postWithFallback(["/api/exec", "/api/cmd/execute", "/bash"], { command: "echo agentport-ok" });
        markHealthy(); // No workspaceRoot from echo fallback
        return toTextResult(
          JSON.stringify(
            {
              ok: true,
              type: 'daemon',
              remoteUrl: currentUrl,
              connection: _currentConnection || 'default',
              authEnabled: Boolean(AUTH_TOKEN),
              clientId: CLIENT_ID || null,
              timeoutMs: REQUEST_TIMEOUT_MS,
              healthCacheTTL: HEALTH_CACHE_TTL_MS,
              cacheValidUntil: new Date(_lastHealthTime + HEALTH_CACHE_TTL_MS).toISOString(),
              runtimeMode: _runtimeMode.mode,
              modeSource: _runtimeMode.source,
              remoteInfo: null,
            },
            null,
            2
          )
        );
      }

      case "remote_status": {
        recordOp("remote_status");
        
        // SSH mode
        if (isSSHConnection()) {
          const sshClient = getSSHClient();
          const conn = _connections[_currentConnection];
          const uptimeSec = Math.floor((Date.now() - _stats.startTime) / 1000);
          const cacheHitRate = _stats.cacheHits + _stats.cacheMisses > 0
            ? `${Math.round((_stats.cacheHits / (_stats.cacheHits + _stats.cacheMisses)) * 100)}%`
            : "N/A";

          return toTextResult(
            JSON.stringify({
              connection: {
                type: 'ssh',
                host: conn.host,
                port: conn.port || 22,
                username: conn.username,
                connected: sshClient.isConnected(),
                connectionName: _currentConnection || 'default',
              },
              runtime: {
                mode: _runtimeMode.mode,
                source: _runtimeMode.source,
                requestedMode: _runtimeMode.requestedMode || _runtimeMode.mode,
                detectedMode: _runtimeMode.detectedMode || 'unknown',
              },
              localCache: {
                healthCacheValid: isHealthCacheValid(),
                healthCacheTTL: `${HEALTH_CACHE_TTL_MS / 1000}s`,
                etagCacheSize: _etagCache.size,
                etagCacheMax: ETAG_CACHE_MAX,
                etagCacheTTL: `${ETAG_CACHE_TTL_MS / 1000}s`,
              },
              stats: {
                uptimeSeconds: uptimeSec,
                totalRequests: _stats.totalRequests,
                etagCacheHitRate: cacheHitRate,
                etagCacheHits: _stats.cacheHits,
                etagCacheMisses: _stats.cacheMisses,
                retries: _stats.retries,
                errors: _stats.errors,
                lastOperation: _stats.lastOperation,
                lastOperationTime: _stats.lastOperationTime,
              },
            }, null, 2)
          );
        }

        // Daemon mode
        const healthOk = isHealthCacheValid();
        let remoteInfo = null;
        let latencyMs = null;
        const currentUrl = _currentConnection ? _connections[_currentConnection]?.url : REMOTE_URL;

        // Always try to fetch remote status
        const startMs = Date.now();
        try {
          const data = await getCurrentAxios().get("/healthz", { validateStatus: () => true, timeout: 5000 });
          latencyMs = Date.now() - startMs;
          if (data.status === 200) {
            remoteInfo = data.data;
            markHealthy(data.data?.workspaceRoot);
          }
        } catch (error) {
          latencyMs = Date.now() - startMs;
          if (isNetworkError(error)) markUnhealthy();
        }

        const uptimeSec = Math.floor((Date.now() - _stats.startTime) / 1000);
        const cacheHitRate = _stats.cacheHits + _stats.cacheMisses > 0
          ? `${Math.round((_stats.cacheHits / (_stats.cacheHits + _stats.cacheMisses)) * 100)}%`
          : "N/A";

        return toTextResult(
          JSON.stringify({
            connection: {
              type: 'daemon',
              remoteUrl: currentUrl,
              connected: healthOk || remoteInfo !== null,
              latencyMs,
              authEnabled: Boolean(AUTH_TOKEN),
              clientId: CLIENT_ID || null,
            },
            runtime: {
              mode: _runtimeMode.mode,
              source: _runtimeMode.source,
              requestedMode: _runtimeMode.requestedMode || _runtimeMode.mode,
              detectedMode: _runtimeMode.detectedMode || 'unknown',
            },
            remote: remoteInfo || "unreachable",
            localCache: {
              healthCacheValid: healthOk,
              healthCacheTTL: `${HEALTH_CACHE_TTL_MS / 1000}s`,
              etagCacheSize: _etagCache.size,
              etagCacheMax: ETAG_CACHE_MAX,
              etagCacheTTL: `${ETAG_CACHE_TTL_MS / 1000}s`,
            },
            stats: {
              uptimeSeconds: uptimeSec,
              totalRequests: _stats.totalRequests,
              etagCacheHitRate: cacheHitRate,
              etagCacheHits: _stats.cacheHits,
              etagCacheMisses: _stats.cacheMisses,
              retries: _stats.retries,
              errors: _stats.errors,
              lastOperation: _stats.lastOperation,
              lastOperationTime: _stats.lastOperationTime,
            },
          }, null, 2)
        );
      }

      case "remote_read": {
        recordOp("remote_read");
        const readPath = requireNonEmptyString(args, "path");

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const content = await sshClient.readFile(readPath);
            return toTextResult(content);
          } catch (error) {
            return toTextResult(`Error reading file: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Consider calling remote_health first to check if remote service is reachable before reading."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }

        // Check local ETag cache first
        const cached = getEtagCache(readPath);
        if (cached) {
          // Send conditional read with If-None-Match
          try {
            const response = await getCurrentAxios().post("/api/fs/read", { path: readPath }, {
              headers: { "If-None-Match": cached.etag },
              validateStatus: (s) => s === 200 || s === 304,
            });
            if (response.status === 304) {
              _stats.cacheHits++;
              return toTextResult(cached.content);
            }
            // 200: content changed
            _stats.cacheMisses++;
            const newContent = response.data?.content ?? "";
            const newEtag = response.data?.etag;
            if (newEtag) setEtagCache(readPath, newEtag, newContent);
            return toTextResult(typeof newContent === "string" ? newContent : JSON.stringify(response.data, null, 2));
          } catch (error) {
            // Conditional read not supported by server, fall through to normal read
            if (isNetworkError(error)) throw error;
          }
        }

        // Normal read (no cache or conditional read not supported)
        const data = await postWithFallback(["/api/fs/read", "/read"], { path: readPath });
        const etag = data?.etag;
        const content = typeof data.content === "string" ? data.content : JSON.stringify(data, null, 2);
        _stats.cacheMisses++;
        if (etag && typeof data.content === "string") {
          setEtagCache(readPath, etag, data.content);
        }
        return toTextResult(content);
      }

      case "remote_write": {
        recordOp("remote_write");
        const writePath = requireNonEmptyString(args, "path");
        const content = sanitizeContent(requireNonEmptyString(args, "content"));

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            await sshClient.writeFile(writePath, content);
            return toTextResult("File written successfully.");
          } catch (error) {
            return toTextResult(`Error writing file: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Must confirm remote service is reachable before write operation. Consider calling remote_health first."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }
        let expectedEtag = typeof args.expectedEtag === "string" ? args.expectedEtag.trim() : "";

        if (!expectedEtag) {
          try {
            const current = await postWithFallback(["/api/fs/read", "/read"], { path: writePath });
            if (typeof current?.etag === "string" && current.etag) {
              expectedEtag = current.etag;
            }
          } catch (error) {
            const msg = errorMessage(error);
            if (!/ENOENT|no such file|not found/i.test(msg)) {
              // Ignore read-precheck errors and keep write best-effort for compatibility.
            }
          }
        }

        const data = await postWithFallback(["/api/fs/write", "/write"], {
          path: writePath,
          content,
          ...(expectedEtag ? { expectedEtag } : {}),
        });
        return toTextResult(data?.message || "File written successfully.");
      }

      case "remote_stat": {
        recordOp("remote_stat");
        const statPath = requireNonEmptyString(args, "path");

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const stats = await sshClient.stat(statPath);
            return toTextResult(JSON.stringify(withRuntimeMeta({
              path: statPath,
              ...stats,
            }), null, 2));
          } catch (error) {
            return toTextResult(`Stat error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        try {
          // Use batch with a single stat operation (server supports stat via batch)
          const response = await getCurrentAxios().post("/api/batch", {
            operations: [{ type: "stat", path: statPath }],
          });
          const data = response.data;
          if (data?.success && data.results?.length > 0) {
            const r = data.results[0];
            if (r.status === 200) {
              return toTextResult(JSON.stringify(withRuntimeMeta({
                path: statPath,
                size: r.size,
                mtime: r.mtime,
                isFile: r.isFile,
                // Normalize: server may return isDir or isDirectory
                isDirectory: r.isDirectory !== undefined ? r.isDirectory : (r.isDir !== undefined ? r.isDir : !r.isFile),
              }), null, 2));
            }
            return toTextResult(`Stat failed: ${r.error || "Unknown error"}`);
          }
          return toTextResult(`Stat failed: ${data?.error || "Unknown error"}`);
        } catch (error) {
          return toTextResult(`Stat error: ${errorMessage(error)}`);
        }
      }

      case "remote_glob": {
        recordOp("remote_glob");
        const pattern = requireNonEmptyString(args, "pattern");
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const files = await sshClient.glob(pattern, cwd);
            return toTextResult(JSON.stringify(files, null, 2));
          } catch (error) {
            return toTextResult(`Glob error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Consider calling remote_health first to check if remote service is reachable before searching."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }
        const data = await postWithFallback(["/api/fs/glob", "/glob"], {
          pattern,
          cwd,
        });
        return toTextResult(JSON.stringify(normalizeGlobEntries(data), null, 2));
      }

      case "remote_grep": {
        recordOp("remote_grep");
        requireNonEmptyString(args, "pattern");

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const maxResults = clampPositiveInt(args.maxResults, 200, 1, 5000);
            // Enforce workspace boundary on cwd so grep cannot escape the root.
            const safeCwd = sshClient.resolveWorkspaceCwd(args.cwd);
            const result = await sshClient.exec(buildSshGrepCommand({ ...args, maxResults, cwd: safeCwd || args.cwd }));
            const matches = parseSshGrepOutput(result.stdout);
            return toTextResult(JSON.stringify(withRuntimeMeta({
              success: true,
              engine: "grep",
              pattern: args.pattern,
              cwd: safeCwd || args.cwd || ".",
              maxResults,
              matches,
              truncated: matches.length >= maxResults,
              stderr: result.stderr || undefined,
            }), null, 2));
          } catch (error) {
            return toTextResult(`Grep error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Consider calling remote_health first to check if remote service is reachable before content search."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this鎻愮ず and retry directly."); throw e; }
        const data = await postWithFallback(["/api/fs/grep", "/grep"], {
          pattern: args.pattern,
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          include: normalizeStringArray(args.include),
          excludeDirs: normalizeStringArray(args.excludeDirs),
          exclude: normalizeStringArray(args.exclude),
          maxResults: args.maxResults,
          maxFileBytes: args.maxFileBytes,
          caseSensitive: Boolean(args.caseSensitive),
          regex: Boolean(args.regex),
        });
        return toTextResult(JSON.stringify(withRuntimeMeta(data), null, 2));
      }

      case "remote_bash": {
        recordOp("remote_bash");
        const command = requireNonEmptyString(args, "command");
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const result = await sshClient.exec(command, { cwd });
            return toTextResult(formatExecOutput(result));
          } catch (error) {
            return toTextResult(`Bash error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy("Consider calling remote_health first to check if remote service is reachable before executing commands."); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message + "\n\nIf you're sure the service is normal, you can ignore this提示 and retry directly."); throw e; }
        // Auto base64 escape for commands containing bash special chars
        const effectiveCommand = needsBase64Escape(command) ? wrapBase64Command(command) : command;
        const data = await postWithFallback(["/api/exec", "/api/cmd/execute", "/bash"], { command: effectiveCommand, cwd });
        return toTextResult(formatExecOutput(data));
      }

      case "remote_script": {
        recordOp("remote_script");
        const scriptContent = sanitizeContent(requireNonEmptyString(args, "content"));
        let interpreter = typeof args.interpreter === "string" && args.interpreter.trim() ? args.interpreter.trim() : "bash";
        // Validate interpreter against whitelist to prevent command injection
        if (!ALLOWED_INTERPRETERS.has(interpreter)) {
          return toTextResult(`Error: Unsupported interpreter '${interpreter}'. Allowed: ${[...ALLOWED_INTERPRETERS].join(", ")}`);
        }
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            // When workspaceRoot is enforced, /tmp is outside the boundary and
            // writeFile would reject it. Use a temp dir inside the workspace
            // instead; fall back to /tmp when workspaceRoot is unset (legacy).
            const wsRoot = sshClient.workspaceRoot;
            const tmpDir = wsRoot
              ? `${wsRoot}/.agentport-tmp`
              : '/tmp';
            const tmpFile = `${tmpDir}/agentport-script-${Date.now()}.sh`;
            if (wsRoot) {
              await sshClient.mkdir(tmpDir);
            }
            // Write script to temp file
            await sshClient.writeFile(tmpFile, scriptContent);
            // Execute the script
            const result = await sshClient.exec(`${interpreter} ${tmpFile}`, { cwd });
            // Cleanup temp file (best effort)
            sshClient.rm(tmpFile).catch(() => {});
            return toTextResult(formatExecOutput(result));
          } catch (error) {
            return toTextResult(`Script exec error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        try {
          const response = await getCurrentAxios().post("/api/exec/script", {
            content: scriptContent,
            interpreter,
            cwd,
          });
          const data = response.data;
          return toTextResult(formatExecOutput(data));
        } catch (error) {
          // If server doesn't support /api/exec/script yet, fallback to write + bash
          if (error?.response?.status === 404 || error?.response?.status === 405) {
            const tmpFile = _workspaceRoot
              ? `${_workspaceRoot}/.agentport-tmp/script-${Date.now()}.sh`
              : `/tmp/agentport-script-${Date.now()}.sh`;
            try {
              // Ensure temp directory exists (workspace mode)
              if (_workspaceRoot) {
                await postWithFallback(["/api/exec", "/bash"], {
                  command: `mkdir -p ${_workspaceRoot}/.agentport-tmp`,
                }).catch(() => {});
              }
              // Write script to temp file
              await postWithFallback(["/api/fs/write", "/write"], {
                path: tmpFile,
                content: scriptContent,
              });
              // Execute the script
              const execData = await postWithFallback(["/api/exec", "/api/cmd/execute", "/bash"], {
                command: `${interpreter} ${tmpFile}`,
                cwd,
              });
              // Cleanup temp file (best effort)
              postWithFallback(["/api/exec", "/bash"], { command: `rm -f ${tmpFile}` }).catch(() => {});
              return toTextResult(formatExecOutput(execData));
            } catch (fallbackError) {
              return toTextResult(`Script exec error (fallback): ${errorMessage(fallbackError)}`);
            }
          }
          return toTextResult(`Script exec error: ${errorMessage(error)}`);
        }
      }

      case "remote_script_async": {
        recordOp("remote_script_async");
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify(withRuntimeMeta({
            error: "Async script execution requires a daemon connection",
            message: "Switch to a daemon connection, or use CLI safe-job --route ssh as the recovery path.",
          }), null, 2));
        }

        const scriptContent = sanitizeContent(requireNonEmptyString(args, "content"));
        const interpreter = typeof args.interpreter === "string" && args.interpreter.trim()
          ? args.interpreter.trim()
          : "bash";
        if (!ALLOWED_INTERPRETERS.has(interpreter)) {
          return toTextResult(`Error: Unsupported interpreter '${interpreter}'. Allowed: ${[...ALLOWED_INTERPRETERS].join(", ")}`);
        }

        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        const requestedCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : "";
        const cwd = requestedCwd || _workspaceRoot;
        if (!cwd) return toTextResult("Error: remote_script_async requires cwd when the daemon does not expose workspaceRoot.");
        const absoluteCwd = cwd.startsWith("/") || !_workspaceRoot
          ? cwd
          : `${_workspaceRoot.replace(/\/+$/, "")}/${cwd.replace(/^\/+/, "")}`;
        const wrapperPath = `${absoluteCwd.replace(/\/+$/, "")}/.agentport-tmp/agentport-async-${Date.now()}-${randomBytes(6).toString("hex")}.sh`;
        const wrapperContent = buildAsyncScriptWrapper(scriptContent, interpreter);
        const timeoutMs = asyncTimeoutMs(args.timeoutMs);

        let uploaded = false;
        try {
          await postWithFallback(["/api/fs/write", "/write"], {
            path: wrapperPath,
            content: wrapperContent,
          });
          uploaded = true;
          const readback = await postWithFallback(["/api/fs/read", "/read"], { path: wrapperPath });
          if ((readback.content ?? "") !== wrapperContent) {
            throw new Error("Async script upload verification failed");
          }
          const data = (await getCurrentAxios().post("/api/exec/async", {
            command: `bash ${shellSingleQuote(wrapperPath)}`,
            cwd,
            timeoutMs,
            connection: currentConnectionSummary(),
          })).data;
          return toTextResult(JSON.stringify(withRuntimeMeta({
            taskId: data.taskId,
            status: data.status,
            createdAt: data.createdAt,
            interpreter,
            cwd,
            timeoutMs,
            verifiedUpload: true,
            message: `Task ${data.taskId} started. Use remote_task with this taskId to check progress.`,
          }), null, 2));
        } catch (error) {
          if (uploaded) {
            postWithFallback(["/api/exec/script"], {
              content: `rm -f -- ${shellSingleQuote(wrapperPath)}\n`,
              interpreter: "bash",
              cwd,
            }).catch(() => {});
          }
          return toTextResult(`Async script error: ${errorMessage(error)}`);
        }
      }

      case "remote_batch": {
        recordOp("remote_batch");
        const operations = args.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          return toTextResult("Error: operations must be a non-empty array.");
        }
        if (operations.length > 20) {
          return toTextResult("Error: Maximum 20 operations per batch.");
        }

        // SSH mode
        if (isSSHConnection()) {
          try {
            const sshClient = getSSHClient();
            const results = [];
            for (const op of operations) {
              try {
                if (op.type === "read") {
                  const content = await sshClient.readFile(op.path);
                  results.push({ type: "read", path: op.path, status: 200, content });
                } else if (op.type === "stat") {
                  const stats = await sshClient.stat(op.path);
                  results.push({ type: "stat", path: op.path, status: 200, ...stats });
                } else if (op.type === "glob") {
                  const files = await sshClient.glob(op.pattern, op.cwd);
                  results.push({ type: "glob", pattern: op.pattern, status: 200, entries: files });
                } else if (op.type === "grep") {
                  const maxResults = clampPositiveInt(op.maxResults, 200, 1, 5000);
                  const safeCwd = sshClient.resolveWorkspaceCwd(op.cwd);
                  const result = await sshClient.exec(buildSshGrepCommand({ ...op, maxResults, cwd: safeCwd || op.cwd }));
                  results.push({
                    type: "grep",
                    pattern: op.pattern,
                    status: 200,
                    engine: "grep",
                    matches: parseSshGrepOutput(result.stdout),
                    truncated: parseSshGrepOutput(result.stdout).length >= maxResults,
                    stderr: result.stderr || undefined,
                  });
                } else if (op.type === "bash") {
                  const result = await sshClient.exec(op.command, { cwd: op.cwd });
                  results.push({ type: "bash", command: op.command, status: 200, ...result });
                } else {
                  results.push({ type: op.type, status: 400, error: "Unknown operation type" });
                }
              } catch (error) {
                results.push({ type: op.type, status: 500, error: error.message });
              }
            }

            // Format results
            const lines = [
              `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}`,
              `Batch completed: ${results.length} operations`
            ];
            for (const r of results) {
              if (r.status === 200) {
                if (r.type === "read") {
                  lines.push(`\n--- READ ${r.path} ---`);
                  lines.push(r.content || "");
                } else if (r.type === "stat") {
                  lines.push(`\n--- STAT ${r.path} ---`);
                  lines.push(`size=${r.size} mtime=${r.mtime} isFile=${r.isFile} isDirectory=${r.isDirectory}`);
                } else if (r.type === "glob") {
                  lines.push(`\n--- GLOB ${r.pattern} ---`);
                  lines.push(JSON.stringify(r.entries, null, 2));
                } else if (r.type === "grep") {
                  lines.push(`\n--- GREP ${r.pattern} ---`);
                  lines.push(JSON.stringify(r.matches, null, 2));
                } else if (r.type === "bash") {
                  lines.push(`\n--- BASH ${r.command} ---`);
                  if (r.stdout) lines.push(r.stdout);
                  if (r.stderr) lines.push(`STDERR: ${r.stderr}`);
                }
              } else {
                lines.push(`\n--- ${r.type.toUpperCase()} FAILED (status=${r.status}) ---`);
                lines.push(r.error || "Unknown error");
              }
            }
            return toTextResult(lines.join("\n"));
          } catch (error) {
            return toTextResult(`Batch error: ${error.message}`);
          }
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        try {
          const response = await getCurrentAxios().post("/api/batch", { operations });
          const data = response.data;
          if (!data?.success) {
            return toTextResult(`Batch error: ${data?.error || "Unknown error"}`);
          }
          // Format results
          const lines = [
            `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}`,
            `Batch completed: ${data.results.length} operations`
          ];
          for (const r of data.results) {
            if (r.status === 200) {
              if (r.type === "read") {
                lines.push(`\n--- READ ${r.path} (${r.ms}ms) ---`);
                lines.push(r.content || "");
              } else if (r.type === "stat") {
                lines.push(`\n--- STAT ${r.path} (${r.ms}ms) ---`);
                const isDir = r.isDirectory !== undefined ? r.isDirectory : (r.isDir !== undefined ? r.isDir : !r.isFile);
                lines.push(`size=${r.size} mtime=${r.mtime} isFile=${r.isFile} isDirectory=${isDir}`);
              } else if (r.type === "glob") {
                lines.push(`\n--- GLOB ${r.pattern} (${r.ms}ms) ---`);
                lines.push(JSON.stringify(r.entries, null, 2));
              } else if (r.type === "grep") {
                lines.push(`\n--- GREP ${r.pattern} (${r.ms}ms) ---`);
                lines.push(JSON.stringify(r.matches, null, 2));
                if (r.truncated) lines.push("TRUNCATED: true");
              } else if (r.type === "bash") {
                lines.push(`\n--- BASH ${r.command} (${r.ms}ms) ---`);
                if (r.stdout) lines.push(r.stdout);
                if (r.stderr) lines.push(`STDERR: ${r.stderr}`);
              }
            } else {
              lines.push(`\n--- ${r.type.toUpperCase()} FAILED (status=${r.status}) ---`);
              lines.push(r.error || "Unknown error");
            }
          }
          return toTextResult(lines.join("\n"));
        } catch (error) {
          return toTextResult(`Batch error: ${errorMessage(error)}`);
        }
      }

      case "remote_exec_async": {
        recordOp("remote_exec_async");
        
        // SSH mode - not supported
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify(withRuntimeMeta({
            error: "Async execution is not supported in SSH mode",
            message: "SSH connections do not support async execution. Use remote_bash for synchronous execution, or switch to daemon mode for async support.",
          }), null, 2));
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        const command = requireNonEmptyString(args, "command");
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
        const timeoutMs = args.timeoutMs === undefined ? undefined : asyncTimeoutMs(args.timeoutMs, undefined);
        // Auto base64 escape for commands containing bash special chars (same as remote_bash)
        const effectiveCommand = needsBase64Escape(command) ? wrapBase64Command(command) : command;
        try {
          const body = {
            command: effectiveCommand,
            cwd,
            connection: currentConnectionSummary(),
          };
          if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
          const data = (await getCurrentAxios().post("/api/exec/async", body)).data;
          return toTextResult(JSON.stringify(withRuntimeMeta({
            taskId: data.taskId,
            status: data.status,
            createdAt: data.createdAt,
            message: `Task ${data.taskId} started. Use remote_task with this taskId to check progress.`,
          }), null, 2));
        } catch (error) {
          return toTextResult(`Async exec error: ${errorMessage(error)}`);
        }
      }

      case "remote_task": {
        recordOp("remote_task");
        
        // SSH mode - not supported
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify(withRuntimeMeta({
            error: "Task query is not supported in SSH mode",
            message: "SSH connections do not support task queries. Use remote_bash for synchronous execution, or switch to daemon mode for task support.",
          }), null, 2));
        }

        // Daemon mode
        try { await ensureHealthy(); } catch (e) { if (isHealthError(e)) return healthCheckError(e.message); throw e; }
        const taskId = requireNonEmptyString(args, "taskId");
        try {
          const response = await getCurrentAxios().get(`/api/task/${taskId}`);
          const data = response.data;
          const result = withRuntimeMeta({
            taskId: data.id,
            status: data.status,
            command: data.command,
          });
          if (data.status === "completed" || data.status === "error") {
            result.exitCode = data.exitCode;
            result.stdout = data.stdout;
            result.stderr = data.stderr;
            // Safely calculate duration — handle both timestamps (ms) and ISO strings
            if (data.finishedAt && data.createdAt) {
              const finished = typeof data.finishedAt === "number" ? data.finishedAt : new Date(data.finishedAt).getTime();
              const created = typeof data.createdAt === "number" ? data.createdAt : new Date(data.createdAt).getTime();
              const durationSec = (finished - created) / 1000;
              result.duration = Number.isFinite(durationSec) ? `${durationSec.toFixed(1)}s` : null;
            } else {
              result.duration = null;
            }
          }
          return toTextResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return toTextResult(`Task error: ${errorMessage(error)}`);
        }
      }

      case "remote_config": {
        recordOp("remote_config");
        
        // SSH mode - not supported
        if (isSSHConnection()) {
          return toTextResult(JSON.stringify(withRuntimeMeta({
            error: "Config management is not supported in SSH mode",
            message: "SSH connections do not support config management. Switch to daemon mode for config support.",
          }), null, 2));
        }

        // Daemon mode
        const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
        if (action === "read") {
          try {
            const response = await getCurrentAxios().get("/api/config");
            const data = response.data;
            if (data.success) {
              return toTextResult(
                `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}\nConfig (${data.envPath}):\n${data.config}\n\nRuntime:\n${JSON.stringify(data.runtime, null, 2)}`
              );
            }
            return toTextResult(`Config read failed: ${data.error || "Unknown error"}`);
          } catch (error) {
            return toTextResult(`Config read error: ${errorMessage(error)}`);
          }
        } else if (action === "write") {
          const newConfig = typeof args.config === "string" ? args.config : "";
          if (!newConfig.trim()) {
            return toTextResult("Error: config field is required for write action.");
          }
          try {
            const response = await getCurrentAxios().put("/api/config", { config: newConfig });
            const data = response.data;
            if (data.success) {
              return toTextResult(
                `[Runtime] mode=${_runtimeMode.mode}, source=${_runtimeMode.source}\n✅ Config updated and reloaded!\nClients: ${data.clients?.join(", ")}\nWorkspace: ${data.workspaceRoot}`
              );
            }
            return toTextResult(`Config write failed: ${data.error || "Unknown error"}`);
          } catch (error) {
            return toTextResult(`Config write error: ${errorMessage(error)}`);
          }
        } else {
          return toTextResult("Error: action must be 'read' or 'write'.");
        }
      }

      case "remote_setup": {
        recordOp("remote_setup");
        
        const host = requireNonEmptyString(args, "host");
        const username = requireNonEmptyString(args, "username");
        const port = typeof args.port === "number" ? args.port : 22;
        const password = typeof args.password === "string" ? args.password : "";
        const privateKey = typeof args.privateKey === "string" ? args.privateKey : "";
        const passphrase = typeof args.passphrase === "string" ? args.passphrase : "";
        const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : `ssh-${host.replace(/\./g, '-')}`;
        const description = typeof args.description === "string" ? args.description : `${username}@${host}:${port}`;
        const testOnly = args.testOnly === true;

        // Validate: need either password or privateKey
        // If neither provided, auto-scan SSH environment and return smart recommendations
        if (!password && !privateKey) {
          const sshInfo = scanLocalSSH();
          const recommendations = [];

          // Check SSH config for host match
          const configMatches = sshInfo.configHosts.filter(h =>
            h.host === host || h.alias === host
          );
          if (configMatches.length > 0) {
            for (const m of configMatches) {
              recommendations.push({
                type: "config",
                message: `SSH config 中发现匹配主机 '${m.alias}' → ${m.host || host}:${m.port} user=${m.user || username}`,
                alias: m.alias,
                user: m.user,
                port: m.port,
                identityFile: m.identityFile,
              });
            }
          }

          // List usable (unencrypted) private keys
          const usableKeys = sshInfo.privateKeys.filter(k => !k.encrypted);
          const encryptedKeys = sshInfo.privateKeys.filter(k => k.encrypted);
          if (usableKeys.length > 0) {
            for (const k of usableKeys) {
              recommendations.push({
                type: "key",
                message: `发现可用密钥 ${k.file}（${k.type}，未加密）`,
                file: k.file,
                path: k.path,
                keyType: k.type,
              });
            }
          }
          if (encryptedKeys.length > 0) {
            for (const k of encryptedKeys) {
              recommendations.push({
                type: "key_encrypted",
                message: `发现加密密钥 ${k.file}（${k.type}，需要密钥密码）`,
                file: k.file,
                path: k.path,
                keyType: k.type,
              });
            }
          }

          // Check known_hosts
          const knownHostMatch = sshInfo.knownHosts.includes(host);

          // Build human-readable summary
          const lines = [`## 🔍 SSH 环境扫描结果\n`];
          lines.push(formatSSHScanSummary(sshInfo));
          lines.push('');

          if (configMatches.length > 0) {
            lines.push(`### ✅ 推荐：使用 SSH config 配置`);
            lines.push(`检测到 config 中已有 ${host} 的配置，可直接连接。`);
            lines.push('');
          } else if (usableKeys.length > 0) {
            lines.push(`### 💡 推荐：使用密钥登录`);
            for (const k of usableKeys) {
              lines.push(`  - ${k.file} (${k.type}) → privateKey="${k.path}"`);
            }
            lines.push('');
          } else {
            lines.push(`### ❌ 未找到可用密钥`);
            lines.push(`建议选择以下方式之一：`);
            lines.push(`  1. 使用密码登录（提供 password 参数）`);
            lines.push(`  2. 使用加密密钥（提供 privateKey + passphrase 参数）`);
            lines.push('');
          }

          if (knownHostMatch) {
            lines.push(`ℹ️ 此主机已在 known_hosts 中，之前连接过。`);
          }

          return toTextResult(JSON.stringify(withRuntimeMeta({
            success: false,
            needsAuth: true,
            message: `未提供认证信息，已自动扫描本地 SSH 环境`,
            host,
            username,
            sshInfo,
            recommendations,
            knownHostMatch,
            summary: lines.join('\n'),
            hint: "请根据以上推荐信息，提供 privateKey 或 password 参数后重新调用 remote_setup",
          }), null, 2));
        }

        // Build SSH config
        const sshConfig = { host, port, username };
        if (password) sshConfig.password = password;
        if (privateKey) sshConfig.privateKey = privateKey;
        if (passphrase) sshConfig.passphrase = passphrase;

        // Test connection
        const testClient = new SSHClient(sshConfig);
        try {
          await testClient.connect();
          const result = await testClient.exec('echo "connected" && uname -a && whoami');
          
          const hasLegacyAutoDeploy = Object.prototype.hasOwnProperty.call(args || {}, "autoDeploy");
          const deploy = args.deploy === true || (hasLegacyAutoDeploy && args.autoDeploy === true);
          const forceDeploy = args.forceDeploy === true;
          const daemonPort = typeof args.daemonPort === "number" && Number.isFinite(args.daemonPort) ? args.daemonPort : 3183;
          let daemonInfo = null;
          
          try {
            const daemonCheck = await testClient.exec('test -d ~/.agentport/daemon && echo "exists" || echo "not exists"');
            const daemonExists = daemonCheck.stdout.includes('exists');
            const runningCheck = await testClient.exec('pgrep -f "node server.js" || echo "not running"');
            const daemonRunning = !runningCheck.stdout.includes('not running');

            if (deploy) {
              if (daemonExists && !forceDeploy) {
                daemonInfo = {
                  skipped: true,
                  reason: "daemon-exists-safe-skip",
                  url: `http://${host}:${daemonPort}`,
                  workspaceRoot: `/home/${username}`,
                  daemonExists: true,
                  daemonRunning,
                  message: "Remote daemon already exists. Skipped deployment to avoid overwriting existing server files and tokens.",
                };
              } else {
                // Upload server files
                const serverDir = path.join(__dirname, 'server');
                const files = ['server.js', 'package.json', 'agentport-manager.sh', 'setup-autostart-agentport.sh', 'dashboard.html'];
                
                await testClient.exec('mkdir -p ~/.agentport/daemon');
                await testClient.exec('rm -f ~/.agentport/daemon/*.clobbered ~/.agentport/daemon/*.tmp ~/.agentport/daemon/*.bak 2>/dev/null; true');
                if (daemonExists && forceDeploy) {
                  await testClient.exec('if [ -f ~/.agentport/daemon/.env ]; then cp ~/.agentport/daemon/.env ~/.agentport/daemon/.env.bak.$(date +%Y%m%d-%H%M%S); fi');
                }
                
                for (const file of files) {
                  const localPath = path.join(serverDir, file);
                  if (fs.existsSync(localPath)) {
                    const content = fs.readFileSync(localPath, 'utf-8');
                    await testClient.writeFile(`~/.agentport/daemon/${file}`, content);
                  }
                }
                
                await testClient.exec('cd ~/.agentport/daemon && npm install --production 2>&1');

                // Generate secure auth token (auto-generated, no user input needed)
                const token = `agentport-${host.replace(/\./g, '-')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
                const clientId = args.clientId || `client-${username}-${host.replace(/\./g, '-')}`;
                
                // Create .env file
                const envContent = [
                  `PORT=${daemonPort}`,
                  `BIND_HOST=0.0.0.0`,
                  `WORKSPACE_ROOT=/home/${username}`,
                  `AUTH_TOKENS=${clientId}=${token}`,
                  `ADMIN_TOKENS=${token}`,
                  `EXEC_TIMEOUT_MS=120000`,
                  `EXEC_MAX_CONCURRENCY=2`,
                ].join('\n');
                await testClient.writeFile(`~/.agentport/daemon/.env`, envContent);
                
                const refreshRunning = await testClient.exec('pgrep -f "node server.js" || echo "not running"');
                if (refreshRunning.stdout.includes('not running')) {
                  await testClient.exec('cd ~/.agentport/daemon && nohup node server.js > daemon.log 2>&1 &');
                  await testClient.exec('sleep 2');
                }
                
                daemonInfo = {
                  url: `http://${host}:${daemonPort}`,
                  authToken: token,
                  clientId: clientId,
                  workspaceRoot: `/home/${username}`,
                  deployed: true,
                  forceDeploy,
                };
              }
            } else {
              daemonInfo = {
                deploySkipped: true,
                reason: "client-only-mode",
                url: `http://${host}:${daemonPort}`,
                workspaceRoot: `/home/${username}`,
                daemonExists,
                daemonRunning,
                message: "Client-only setup completed. Remote daemon files were not modified.",
              };
            }
          } catch (deployError) {
            // Deployment or daemon detection failed, but SSH connection worked
            daemonInfo = { error: deployError.message };
          }
          
          testClient.disconnect();

          if (testOnly) {
            return toTextResult(JSON.stringify(withRuntimeMeta({
              success: true,
              message: "Connection test successful!",
              server: result.stdout,
            }), null, 2));
          }

          // Save SSH connection config
          const connConfig = {
            name,
            type: "ssh",
            description,
            host,
            port,
            username,
          };
          if (password) connConfig.password = password;
          if (privateKey) connConfig.privateKey = privateKey;
          if (passphrase) connConfig.passphrase = passphrase;

          // Update connections.json
          const configPath = path.join(__dirname, 'local', 'connections.json');
          let config = { connections: [], default: name };
          try {
            if (fs.existsSync(configPath)) {
              config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
          } catch {}

          const daemonConnectionReady = Boolean(daemonInfo && !daemonInfo.error && daemonInfo.authToken && daemonInfo.clientId);

          // Save daemon connection only when deployment generated usable credentials
          if (daemonConnectionReady) {
            const daemonName = `${name}-daemon`;
            const daemonConn = {
              name: daemonName,
              type: "daemon",
              description: `${description} (daemon)`,
              url: daemonInfo.url,
              authToken: daemonInfo.authToken,
              clientId: daemonInfo.clientId,
            };
            
            // Add daemon connection
            const existingDaemonIdx = config.connections.findIndex(c => c.name === daemonName);
            if (existingDaemonIdx >= 0) {
              config.connections[existingDaemonIdx] = daemonConn;
            } else {
              config.connections.push(daemonConn);
            }
            config.default = daemonName; // Switch to daemon by default
          }

          // Add or update SSH connection
          const existingIdx = config.connections.findIndex(c => c.name === name);
          if (existingIdx >= 0) {
            config.connections[existingIdx] = connConfig;
          } else {
            config.connections.push(connConfig);
          }
          // Don't override default if daemon connection was added
          if (!daemonConnectionReady) {
            config.default = name;
          }

          // Ensure local directory exists
          const localDir = path.join(__dirname, 'local');
          if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
          }
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

          // Register daemon connection in memory only when usable credentials were generated
          if (daemonConnectionReady) {
            const daemonName = `${name}-daemon`;
            _connections[daemonName] = {
              type: "daemon",
              url: daemonInfo.url,
              authToken: daemonInfo.authToken,
              clientId: daemonInfo.clientId,
            };
            _currentConnection = daemonName;
            _connectionAxios = attachTraceInterceptors(axios.create({
              baseURL: daemonInfo.url,
              timeout: REQUEST_TIMEOUT_MS,
              httpAgent: HTTP_AGENT,
              httpsAgent: HTTPS_AGENT,
              headers: {
                authorization: `Bearer ${daemonInfo.authToken}`,
                "x-mcp-client-id": daemonInfo.clientId,
                "Content-Type": "application/json",
              },
            }));
          } else {
            // Register SSH connection in memory
            _connections[name] = connConfig;
            _sshManager.addConnection(name, connConfig);
            _currentConnection = name;
            _connectionAxios = null;
          }

          // Build response message
          let message = '✅ Connection successful!';
          if (daemonConnectionReady) {
            const dashboardUrl = `${daemonInfo.url}/?token=${daemonInfo.authToken}`;
            message = [
              '✅ Development environment ready!',
              '',
              '**Connection Info:**',
              `- SSH: ${username}@${host}:${port}`,
              `- Daemon: ${daemonInfo.url}`,
              `- Workspace: ${daemonInfo.workspaceRoot}`,
              '',
              '**📊 Monitor Status:**',
              `Open Dashboard to view real-time status: ${dashboardUrl}`,
              '(View connection status, client list, command execution logs, etc.)',
              '',
              'Ready for remote development!',
            ].join('\n');
          } else if (daemonInfo && daemonInfo.error) {
            message = `⚠️ SSH connection succeeded, but daemon deployment failed: ${daemonInfo.error}\n\nYou can still develop via SSH mode.`;
          } else {
            message = `✅ SSH connection saved!\nReady for remote development.`;
          }

          if (daemonInfo && daemonInfo.deploySkipped) {
            message = [
              "✅ SSH connection saved (client-only mode).",
              "",
              "Remote daemon files were not modified.",
              `- daemonExists: ${daemonInfo.daemonExists ? "yes" : "no"}`,
              `- daemonRunning: ${daemonInfo.daemonRunning ? "yes" : "no"}`,
              "",
              "If this is a first-time server setup, rerun remote_setup with deploy=true.",
            ].join("\n");
          } else if (daemonInfo && daemonInfo.skipped) {
            message = [
              "✅ SSH connection saved.",
              "",
              "Remote daemon already exists. Deployment skipped to avoid overwrite.",
              `- daemonRunning: ${daemonInfo.daemonRunning ? "yes" : "no"}`,
              "",
              "To intentionally replace server files, rerun with deploy=true and forceDeploy=true.",
            ].join("\n");
          }

          const resultData = withRuntimeMeta({
            success: true,
            message: message,
            ssh: { connection: name, host: `${username}@${host}:${port}`, server: result.stdout },
            saved: configPath,
            defaultConnection: _currentConnection,
          });
          
          if (daemonConnectionReady) {
            resultData.daemon = {
              url: daemonInfo.url,
              dashboardUrl: `${daemonInfo.url}/?token=${daemonInfo.authToken}`,
              authToken: daemonInfo.authToken,
              workspaceRoot: daemonInfo.workspaceRoot,
            };
          } else if (daemonInfo) {
            resultData.daemon = daemonInfo;
          }
          
          return toTextResult(JSON.stringify(resultData, null, 2));
        } catch (error) {
          try { testClient.disconnect(); } catch {}
          return toTextResult(JSON.stringify(withRuntimeMeta({
            success: false,
            error: error.message,
            hint: password 
              ? "Please check if the password is correct and if the server allows password login."
              : "Please check if the key path is correct and if the key has a passphrase (if so, provide passphrase).",
          }), null, 2));
        }
      }

      case "remote_ssh_info": {
        recordOp("remote_ssh_info");
        const sshInfo = scanLocalSSH();

        // Add saved connections
        const connPath = path.join(__dirname, 'local', 'connections.json');
        if (fs.existsSync(connPath)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(connPath, 'utf-8'));
            for (const c of cfg.connections || []) {
              const info = { name: c.name, type: c.type || "daemon" };
              if (c.type === 'ssh') {
                info.host = `${c.username}@${c.host}:${c.port || 22}`;
                if (c.identityFile) info.identityFile = c.identityFile;
              } else {
                info.url = c.url;
              }
              sshInfo.savedConnections.push(info);
            }
          } catch {}
        } else {
          sshInfo.savedConnections = [];
        }

        // Human-readable summary
        const summary = [];
        summary.push(`## Local SSH Environment\n`);
        summary.push(formatSSHScanSummary(sshInfo));
        summary.push('');
        if (sshInfo.savedConnections && sshInfo.savedConnections.length) {
          summary.push(`Saved Connections (${sshInfo.savedConnections.length}):`);
          for (const c of sshInfo.savedConnections) {
            const detail = c.type === 'ssh' ? c.host : c.url;
            summary.push(`  - ${c.name} [${c.type}] → ${detail}`);
          }
        } else {
          summary.push(`Saved Connections: None`);
        }
        summary.push('');
        summary.push('---');
        summary.push(`💡 Use \`remote_setup\` to connect. Pick a host from SSH Config Hosts above, or provide a new IP.`);
        summary.push(`   If a private key is listed, use \`privateKey\` param. Otherwise use \`password\`.`);

        sshInfo._summary = summary.join('\n');
        return toTextResult(JSON.stringify(withRuntimeMeta(sshInfo), null, 2));
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    caughtError = error;
    
    // Mark unhealthy on network errors so next call prompts health check
    if (isNetworkError(error)) {
      markUnhealthy();
      _stats.errors++;
    }
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    _currentTraceContext = previousTraceContext;
    const durationMs = Date.now() - startTime;
    markToolCallFinished(callId, caughtError ? "failed" : "completed", durationMs, caughtError);
    const payload = {
      callId,
      sessionId: PROCESS_SESSION_ID,
      durationMs,
      connection: currentConnectionSummary(),
      args: summarizeArgs(toolName, args),
    };

    if (caughtError) {
      logger.error(toolName, `Failed call #${callId}: ${errorMessage(caughtError)}`, {
        ...payload,
        errorCode: caughtError?.code,
        error: errorMessage(caughtError),
        hint: timeoutHint(durationMs, caughtError),
        diagnostic: diagnosticSnapshot("tool failure", {
          failedCall: callInfo,
          failedDurationMs: durationMs,
        }),
      });
    } else if (durationMs >= SLOW_CALL_MS) {
      logger.warn(toolName, `Slow call #${callId}`, {
        ...payload,
        hint: timeoutHint(durationMs),
        diagnostic: diagnosticSnapshot("slow tool call", {
          slowCall: callInfo,
          slowDurationMs: durationMs,
        }),
      });
    } else if (LOG_TOOL_SUCCESS) {
      logger.info(toolName, `Completed call #${callId}`, payload);
    }
    if (restoreCallConnection) {
      try {
        restoreCallConnection();
      } catch {}
    }
  }
});

async function main() {
  pushDiagnosticEvent("process.start", {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv,
  });
  logProcessEvent("info", "Process start", {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    argv: process.argv.slice(0, 2),
    packageName: PKG_NAME,
    packageVersion: PKG_VERSION,
    timeoutMs: REQUEST_TIMEOUT_MS,
    slowCallMs: SLOW_CALL_MS,
    runtimeMode: _runtimeMode.mode,
    modeSource: _runtimeMode.source,
    defaultRemote: REMOTE_URL,
    authEnabled: Boolean(AUTH_TOKEN),
    clientId: CLIENT_ID || null,
  });

  const singleton = acquireSingletonLock();
  if (!singleton.ok) {
    if (singleton.duplicate) {
      const broker = singleton.existing?.broker;
      if (broker?.url && broker?.token) {
        _proxyBroker = {
          url: broker.url,
          token: broker.token,
          pid: singleton.existing?.pid || null,
          sessionId: singleton.existing?.sessionId || null,
          lockPath: singleton.lockPath,
        };
        try {
          await axios.get(`${broker.url}/health`, {
            timeout: 3000,
            headers: { "x-agentport-broker-token": broker.token },
          });
          logProcessEvent("warn", "Duplicate instance switched to proxy mode", {
            lockPath: singleton.lockPath,
            existing: singleton.existing || null,
            proxyBroker: _proxyBroker,
          });
        } catch (error) {
          _proxyBroker = null;
          logProcessEvent("warn", "Duplicate instance found but broker unavailable", {
            lockPath: singleton.lockPath,
            existing: singleton.existing || null,
            error: errorMessage(error),
          });
        }
      }

      if (_proxyBroker) {
        writeStderrLine(
          `[agentport] duplicate instance proxy mode enabled (clientId=${CLIENT_ID || "default"}, ownerPid=${singleton.existing?.pid || "unknown"}, broker=${_proxyBroker.url})`
        );
      } else {
        logProcessEvent("warn", "Duplicate instance blocked", {
          lockPath: singleton.lockPath,
          existing: singleton.existing || null,
          hint: "Owner instance has no proxy broker yet. Close stale process or restart agentport.",
        });
        writeStderrLine(
          `[agentport] duplicate instance blocked (clientId=${CLIENT_ID || "default"}, existingPid=${singleton.existing?.pid || "unknown"}, lock=${singleton.lockPath})`
        );
        process.exit(0);
        return;
      }

      logProcessEvent("info", "Running as proxy process", {
        lockPath: singleton.lockPath,
        proxyBroker: _proxyBroker,
      });
      writeProcessRegistry();
    } else {
      logProcessEvent("error", "Singleton lock acquire failed", {
        lockPath: singleton.lockPath,
        reason: singleton.reason || "unknown",
      });
      writeStderrLine(
        `[agentport] singleton lock failed: ${singleton.reason || "unknown"} (lock=${singleton.lockPath})`
      );
      process.exit(1);
      return;
    }
  } else {
    logProcessEvent("info", "Singleton lock acquired", {
      lockPath: singleton.lockPath,
    });
    try {
      const broker = await startSingletonBroker();
      updateSingletonLockFile({
        broker: {
          url: broker.url,
          token: broker.token,
          port: broker.port,
          startedAt: broker.startedAt,
        },
      });
      logProcessEvent("info", "Singleton broker started", {
        broker: {
          url: broker.url,
          port: broker.port,
        },
      });
    } catch (error) {
      logProcessEvent("error", "Failed to start singleton broker", {
        error: errorMessage(error),
      });
      writeStderrLine(`[agentport] failed to start singleton broker: ${errorMessage(error)}`);
    }
    writeProcessRegistry();
  }

  // Initialize connection manager
  const defaultConn = loadConnections();
  if (defaultConn && _connections[defaultConn]) {
    _currentConnection = defaultConn;
    const conn = _connections[defaultConn];
    
    if (conn.type === 'ssh') {
      // SSH connection - will connect on first use
      writeStderrLine(`Loaded ${Object.keys(_connections).length} connections, default: ${defaultConn} (SSH)`);
    } else {
      // Daemon connection
      _connectionAxios = getAxiosInstance(defaultConn);
      writeStderrLine(`Loaded ${Object.keys(_connections).length} connections, default: ${defaultConn} (daemon)`);
    }
  }
  
  const transport = new StdioServerTransport();
  const previousOnClose = transport.onclose;
  const previousOnError = transport.onerror;
  transport.onclose = () => {
    _transportState.closed = true;
    _transportState.closedAt = new Date().toISOString();
    _lastTransportEvent = {
      type: "close",
      at: _transportState.closedAt,
      activeCallCount: _activeToolCalls.size,
    };
    pushDiagnosticEvent("transport.close", _lastTransportEvent);
    logProcessEvent("warn", "Stdio transport closed", {
      diagnostic: diagnosticSnapshot("transport.close"),
    });
    if (typeof previousOnClose === "function") previousOnClose();
    releaseSingletonLock();
    scheduleStdioExit("stdio transport closed");
  };
  transport.onerror = (error) => {
    _transportState.errored = true;
    _transportState.errorAt = new Date().toISOString();
    _lastTransportEvent = {
      type: "error",
      at: _transportState.errorAt,
      error: error instanceof Error ? error.message : String(error),
      activeCallCount: _activeToolCalls.size,
    };
    pushDiagnosticEvent("transport.error", _lastTransportEvent);
    logProcessEvent("error", "Stdio transport error", {
      error: error instanceof Error ? error.stack || error.message : String(error),
      diagnostic: diagnosticSnapshot("transport.error"),
    });
    if (typeof previousOnError === "function") previousOnError(error);
    if (isBrokenPipeError(error)) {
      releaseSingletonLock();
      scheduleStdioExit("stdio transport error", error);
    }
  };
  process.stdin.on("end", () => {
    _stdioState.stdinEnded = true;
    pushDiagnosticEvent("stdin.end", { activeCallCount: _activeToolCalls.size });
    logProcessEvent("warn", "stdin end", { diagnostic: diagnosticSnapshot("stdin.end") });
    releaseSingletonLock();
    scheduleStdioExit("stdin ended");
  });
  process.stdin.on("close", () => {
    _stdioState.stdinClosed = true;
    pushDiagnosticEvent("stdin.close", { activeCallCount: _activeToolCalls.size });
    logProcessEvent("warn", "stdin close", { diagnostic: diagnosticSnapshot("stdin.close") });
    releaseSingletonLock();
    scheduleStdioExit("stdin closed");
  });
  process.stdin.on("error", (error) => {
    _stdioState.stdinErrored = true;
    pushDiagnosticEvent("stdin.error", {
      error: error instanceof Error ? error.message : String(error),
      activeCallCount: _activeToolCalls.size,
    });
    logProcessEvent("error", "stdin error", {
      error: error instanceof Error ? error.stack || error.message : String(error),
      diagnostic: diagnosticSnapshot("stdin.error"),
    });
    if (isBrokenPipeError(error)) {
      releaseSingletonLock();
      scheduleStdioExit("stdin error", error);
    }
  });
  process.stdout.on("error", (error) => {
    _stdioState.stdoutErrored = true;
    pushDiagnosticEvent("stdout.error", {
      error: error instanceof Error ? error.message : String(error),
      activeCallCount: _activeToolCalls.size,
    });
    logProcessEvent("error", "stdout error", {
      error: error instanceof Error ? error.stack || error.message : String(error),
      diagnostic: diagnosticSnapshot("stdout.error"),
    });
    if (isBrokenPipeError(error)) {
      releaseSingletonLock();
      scheduleStdioExit("stdout error", error);
    }
  });
  process.stderr.on("error", (error) => {
    _stdioState.stderrErrored = true;
    pushDiagnosticEvent("stderr.error", {
      error: error instanceof Error ? error.message : String(error),
      activeCallCount: _activeToolCalls.size,
    });
    logProcessEvent("error", "stderr error", {
      error: error instanceof Error ? error.stack || error.message : String(error),
      diagnostic: diagnosticSnapshot("stderr.error"),
    });
    if (isBrokenPipeError(error)) {
      releaseSingletonLock();
      scheduleStdioExit("stderr error", error);
    }
  });
  await server.connect(transport);
  _transportState.connected = true;
  _transportState.connectedAt = new Date().toISOString();
  pushDiagnosticEvent("transport.connected", {
    connection: currentConnectionSummary(),
  });
  logProcessEvent("info", "Stdio transport connected", {
    diagnostic: diagnosticSnapshot("transport.connected"),
  });
  
  const connType = _currentConnection ? (_connections[_currentConnection]?.type || 'daemon') : 'daemon';
  const connInfo = connType === 'ssh' 
    ? `ssh://${_connections[_currentConnection]?.host}:${_connections[_currentConnection]?.port || 22}`
    : (_currentConnection ? _connections[_currentConnection]?.url : REMOTE_URL);
  
  writeStderrLine(
    `AgentPort v${PKG_VERSION} running on stdio (name=${PKG_NAME}, type=${connType}, remote=${connInfo}, auth=${AUTH_TOKEN ? "on" : "off"}, timeout=${REQUEST_TIMEOUT_MS}ms, runtimeMode=${_runtimeMode.mode}, modeSource=${_runtimeMode.source})`
  );
}

main().catch((error) => {
  writeStderrLine("Server error:", localErrorMessage(error));
  process.exit(1);
});
