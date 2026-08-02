#!/usr/bin/env node
/**
 * AgentPort Post-Installation Test Suite
 *
 * Usage:
 *   cd <skillDir>
 *   node test/test.cjs                            # Full test (local + remote)
 *   node test/test.cjs --local-only               # Local checks only
 *   node test/test.cjs --preflight --mode=auto    # 环境/依赖/连通预检
 *   node test/test.cjs --probe --mode=auto        # 模式探测（native-mcp / executable-skill）
 *   node test/test.cjs --verbose                  # Show detailed output
 *
 * Exit codes: 0=pass, 1=fail, 2=fatal
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const args = process.argv.slice(2);
const LOCAL_ONLY = args.includes("--local-only");
const VERBOSE = args.includes("--verbose");
const PREFLIGHT_ONLY = args.includes("--preflight");
const PROBE_ONLY = args.includes("--probe");
const MODE_ARG = args.find((a) => a.startsWith("--mode="));
const MODE_RAW = MODE_ARG ? MODE_ARG.slice("--mode=".length).trim() : "";
const ALLOWED_MODES = new Set(["auto", "native-mcp", "executable-skill"]);
const MODE_CLI = MODE_RAW && ALLOWED_MODES.has(MODE_RAW) ? MODE_RAW : (MODE_RAW ? "auto" : "");

const C = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m" };
const results = { pass: 0, fail: 0, skip: 0 };
const failures = [];

function pass(name, detail) { results.pass++; console.log(`  ${C.green}✓${C.reset} ${name}${detail ? ` ${C.dim}(${detail})${C.reset}` : ""}`); }
function fail(name, reason) { results.fail++; failures.push({ name, reason }); console.log(`  ${C.red}✗${C.reset} ${name}${reason ? ` — ${C.red}${reason}${C.reset}` : ""}`); }
function skip(name, reason) { results.skip++; console.log(`  ${C.yellow}⊘${C.reset} ${name}${reason ? ` ${C.dim}(${reason})${C.reset}` : ""}`); }
function section(title) { console.log(`\n${C.bold}${C.cyan}${title}${C.reset}\n${C.dim}${"─".repeat(50)}${C.reset}`); }

const SKILL_DIR = path.resolve(__dirname, "..");
const LOCAL_DIR = path.join(SKILL_DIR, "local");
const PRIMARY_MAIN_CONFIG_PATH = path.join(LOCAL_DIR, "agentport.json");
function resolveMainConfigPath() {
  if (fs.existsSync(PRIMARY_MAIN_CONFIG_PATH)) return PRIMARY_MAIN_CONFIG_PATH;
  return PRIMARY_MAIN_CONFIG_PATH;
}
const MAIN_CONFIG_PATH = resolveMainConfigPath();
const RUNTIME_MODE_PATH = path.join(LOCAL_DIR, "runtime-mode.json");

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonPretty(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function loadRuntimeMode() {
  const d = readJsonSafe(RUNTIME_MODE_PATH);
  if (!d || typeof d !== "object") return null;
  return d;
}

function normalizeMode(v) {
  return ALLOWED_MODES.has(v) ? v : "auto";
}

function resolveRequestedMode(runtimeModeObj) {
  if (MODE_CLI) return MODE_CLI;
  const runtimeMode = runtimeModeObj?.mode;
  if (typeof runtimeMode === "string" && ALLOWED_MODES.has(runtimeMode)) return runtimeMode;
  return "auto";
}

function decideDetectedMode(requestedMode, nativeReady, executableReady) {
  if (requestedMode === "native-mcp") return nativeReady ? "native-mcp" : "unknown";
  if (requestedMode === "executable-skill") return executableReady ? "executable-skill" : "unknown";
  return nativeReady ? "native-mcp" : (executableReady ? "executable-skill" : "unknown");
}

function detectMode(config, runtimeModeObj) {
  const vars = config?.variables || {};
  const mcpServerName = vars.mcpServerName || config?.name || "agentport";
  const mcpConfigPath = vars.mcpConfigPath || "";
  const requestedMode = resolveRequestedMode(runtimeModeObj);

  const native = { ready: false, blockers: [], evidence: {} };
  const executable = { ready: false, blockers: [], evidence: {} };

  // native-mcp readiness
  if (!mcpConfigPath) {
    native.blockers.push("mcpConfigPath 未配置");
  } else if (!fs.existsSync(mcpConfigPath)) {
    native.blockers.push(`MCP 配置文件不存在: ${mcpConfigPath}`);
  } else {
    const mcpCfg = readJsonSafe(mcpConfigPath);
    const serverCfg = mcpCfg?.mcpServers?.[mcpServerName];
    if (!serverCfg) {
      native.blockers.push(`mcpServers.${mcpServerName} 缺失`);
    } else {
      native.evidence.command = serverCfg.command || null;
      native.evidence.args = serverCfg.args || null;
      native.evidence.envKeys = Object.keys(serverCfg.env || {});
      if (!serverCfg.command) native.blockers.push("MCP server command 缺失");
      if (!Array.isArray(serverCfg.args) || serverCfg.args.length === 0) native.blockers.push("MCP server args 缺失");
      const hasIndexArg = Array.isArray(serverCfg.args) && serverCfg.args.some((a) => String(a).includes("index.js"));
      if (!hasIndexArg) native.blockers.push("MCP args 未指向 index.js");
      native.ready = native.blockers.length === 0;
    }
  }

  // executable-skill readiness
  const nm = path.join(SKILL_DIR, "node_modules");
  const depList = ["ssh2", "@modelcontextprotocol/sdk", "axios"];
  if (!fs.existsSync(path.join(SKILL_DIR, "index.js"))) executable.blockers.push("index.js 缺失");
  if (!fs.existsSync(nm)) executable.blockers.push("node_modules 缺失");
  for (const dep of depList) {
    if (!fs.existsSync(path.join(nm, dep))) executable.blockers.push(`依赖缺失: ${dep}`);
  }
  executable.evidence.nodeModules = fs.existsSync(nm);
  executable.ready = executable.blockers.length === 0;

  const detectedMode = decideDetectedMode(requestedMode, native.ready, executable.ready);

  const blockers = [];
  if (detectedMode === "unknown") blockers.push(...native.blockers, ...executable.blockers);

  const fallbackUsed = requestedMode === "auto" && detectedMode === "executable-skill" && !native.ready;
  const fallbackReason = fallbackUsed ? `native-mcp 不可用，自动降级到 executable-skill：${native.blockers.join("; ") || "未知原因"}` : null;

  return {
    requestedMode,
    detectedMode,
    fallbackUsed,
    fallbackReason,
    capabilities: {
      nativeMcpReady: native.ready,
      executableSkillReady: executable.ready,
      canAutoFallback: native.ready || executable.ready,
    },
    blockers,
    evidence: {
      mcpConfigPath: mcpConfigPath || null,
      mcpServerName,
      native,
      executable,
    },
  };
}

async function runPreflight(config) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || "" });

  push("file: SKILL.md", fs.existsSync(path.join(SKILL_DIR, "SKILL.md")));
  push("file: index.js", fs.existsSync(path.join(SKILL_DIR, "index.js")));
  push("file: package.json", fs.existsSync(path.join(SKILL_DIR, "package.json")));
  push("file: local/agentport.json", fs.existsSync(MAIN_CONFIG_PATH));

  const nm = path.join(SKILL_DIR, "node_modules");
  push("dep: node_modules", fs.existsSync(nm));
  for (const dep of ["ssh2", "@modelcontextprotocol/sdk", "axios"]) {
    push(`dep: ${dep}`, fs.existsSync(path.join(nm, dep)));
  }

  const runtime = getRemoteRuntimeEnv(config);
  const remoteUrl = runtime.remoteUrl;
  const authToken = runtime.authToken;
  push("config: REMOTE_URL", Boolean(remoteUrl));
  push("config: AUTH_TOKEN", Boolean(authToken));

  let remoteReachable = false;
  if (remoteUrl) {
    try {
      const r = await api(remoteUrl, "/healthz", authToken);
      remoteReachable = r.status === 200;
      push("remote: /healthz reachable", remoteReachable, `HTTP ${r.status}`);
    } catch (e) {
      push("remote: /healthz reachable", false, e.message);
    }
  } else {
    push("remote: /healthz reachable", false, "REMOTE_URL 未配置");
  }

  const failCount = checks.filter((c) => !c.ok).length;
  return {
    status: failCount === 0 ? "pass" : "fail",
    failCount,
    total: checks.length,
    checks,
  };
}

function saveRuntimeModeResult(modeResult) {
  const effectiveMode = modeResult.detectedMode === "unknown"
    ? normalizeMode(modeResult.requestedMode || "auto")
    : normalizeMode(modeResult.detectedMode);
  const payload = {
    mode: effectiveMode,
    requestedMode: modeResult.requestedMode,
    detectedMode: modeResult.detectedMode,
    lastProbeAt: new Date().toISOString(),
    probeResult: {
      capabilities: modeResult.capabilities,
      blockers: modeResult.blockers,
    },
  };
  writeJsonPretty(RUNTIME_MODE_PATH, payload);
  return payload;
}

function resolveTemplateValue(v, vars) {
  if (typeof v !== "string") return v;
  return v.replace(/\$\{(\w+)\}/g, (_, key) => (vars && key in vars ? String(vars[key]) : ""));
}

function getRemoteRuntimeEnv(config) {
  const env = config?.mcp?.server?.env || {};
  const vars = config?.variables || {};
  return {
    remoteUrl: resolveTemplateValue(env.MCP_REMOTE_URL || env.NIUMA_SSH_REMOTE_URL || "", vars),
    authToken: resolveTemplateValue(env.MCP_REMOTE_AUTH_TOKEN || env.NIUMA_SSH_AUTH_TOKEN || "", vars),
  };
}

// ─── HTTP helper ─────────────────────────────────────────────────────
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: options.timeout || 15000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function api(remoteUrl, endpoint, authToken, body) {
  const headers = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return httpRequest(`${remoteUrl}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Normalize exit code: server uses 'code', async task uses 'exitCode'
function exitCode(d) { return d.exitCode !== undefined ? d.exitCode : d.code; }

// ─── Phase 1: Local ──────────────────────────────────────────────────
async function localTests() {
  section("Phase 1: Local Checks (本地检查)");

  // Core files
  for (const f of ["SKILL.md", "index.js", "package.json"]) {
    fs.existsSync(path.join(SKILL_DIR, f)) ? pass(`File: ${f}`) : fail(`File missing: ${f}`);
  }
  // Check local config
  fs.existsSync(MAIN_CONFIG_PATH)
    ? pass(`File: ${path.relative(SKILL_DIR, MAIN_CONFIG_PATH).replace(/\\/g, "/")}`)
    : fail("File missing: local/agentport.json", "cp agentport.example.json local/agentport.json");

  // Dependencies
  const nm = path.join(SKILL_DIR, "node_modules");
  if (fs.existsSync(nm)) {
    pass("node_modules exists");
    for (const d of ["@modelcontextprotocol/sdk", "axios"]) {
      fs.existsSync(path.join(nm, d)) ? pass(`Dep: ${d}`) : fail(`Dep missing: ${d}`, "npm install");
    }
  } else {
    fail("node_modules missing", "npm install");
  }

  // index.js content
  try {
    const src = fs.readFileSync(path.join(SKILL_DIR, "index.js"), "utf-8");
    src.length > 1000 ? pass("index.js: OK", `${(src.length / 1024).toFixed(1)}KB`) : fail("index.js: too small");
    for (const [pat, desc] of [["ensureHealthy", "ensureHealthy()"], ["ALLOWED_INTERPRETERS", "interpreter whitelist"], ["needsBase64Escape", "base64 detection"], ["wrapBase64Command", "base64 wrapper"], ["healthCheckError", "healthCheckError()"], ["isHealthError", "isHealthError()"], ["recordOp", "recordOp()"]]) {
      src.includes(pat) ? pass(`index.js: ${desc}`) : fail(`index.js missing: ${desc}`);
    }
    !src.includes("console.error") ? pass("index.js: no raw console.error") : fail("index.js: raw console.error still present");
    src.includes("scheduleStdioExit") && src.includes("isBrokenPipeError")
      ? pass("index.js: broken-pipe stdio exit guard")
      : fail("index.js: missing broken-pipe stdio exit guard");
  } catch (e) { fail("index.js read error", e.message); }

  try {
    const loggerSrc = fs.readFileSync(path.join(SKILL_DIR, "logger.js"), "utf-8");
    loggerSrc.includes("LOG_SEGMENT_MAX_BYTES") && loggerSrc.includes("LOG_MAX_SEGMENTS_PER_DAY")
      ? pass("logger.js: size-based log rotation")
      : fail("logger.js: missing size-based log rotation");
  } catch (e) { fail("logger.js read error", e.message); }

  // Release metadata is tracked in package.json. Local config is machine-specific.
  const cfgPath = MAIN_CONFIG_PATH;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "package.json"), "utf-8"));
    typeof pkg.version === "string" && pkg.version.trim()
      ? pass(`version: ${pkg.version}`)
      : fail("package.json version missing");
  } catch (e) { fail("package.json error", e.message); }

  // Config
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(cfgPath, "utf-8").replace(/^\uFEFF/, ""));
    pass(`${path.relative(SKILL_DIR, cfgPath).replace(/\\/g, "/")}: OK`);
    const env = config.mcp?.server?.env || {};
    // Support both new (MCP_REMOTE_*) and legacy (NIUMA_SSH_*) env var names
    (env.MCP_REMOTE_URL || env.NIUMA_SSH_REMOTE_URL) ? pass("REMOTE_URL configured") : fail("REMOTE_URL missing");
    (env.MCP_REMOTE_AUTH_TOKEN || env.NIUMA_SSH_AUTH_TOKEN) ? pass("AUTH_TOKEN configured") : fail("AUTH_TOKEN missing");
  } catch (e) { fail("local config error", e.message); }

  return config;
}

function runModeRegressionScenarios(config) {
  section("Phase 1b: Mode Strategy Regression (模式策略回归)");

  const forcedNative = detectMode(config, { mode: "native-mcp" });
  if (forcedNative.capabilities.nativeMcpReady) {
    pass("forced native-mcp: available");
  } else if (forcedNative.detectedMode === "unknown" && forcedNative.evidence?.native?.blockers?.length > 0) {
    pass("forced native-mcp: diagnosable failure", forcedNative.evidence.native.blockers.join("; "));
  } else {
    fail("forced native-mcp: invalid failure mapping");
  }

  const autoMode = detectMode(config, { mode: "auto" });
  if (!autoMode.capabilities.nativeMcpReady && autoMode.capabilities.executableSkillReady) {
    if (autoMode.detectedMode === "executable-skill" && autoMode.fallbackUsed && autoMode.fallbackReason) {
      pass("auto fallback: native -> executable", autoMode.fallbackReason);
    } else {
      fail("auto fallback: missing fallback metadata");
    }
  } else {
    skip("auto fallback scenario", "当前环境不满足 native 不可用且 executable 可用");
  }
}

// ─── Phase 2: Remote ─────────────────────────────────────────────────
async function remoteTests(remoteUrl, authToken) {
  section("Phase 2: Remote Connection (远程连接)");

  let ok = false;
  try {
    const r = await api(remoteUrl, "/healthz", authToken);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      d.ok === true ? (pass("remote_health: OK"), ok = true) : fail("remote_health: ok !== true");
    } else { fail(`remote_health: HTTP ${r.status}`); }
  } catch (e) { fail(`remote_health: ${e.message}`); }

  if (!ok) { skip("All remote tests", "health check failed"); return; }

  // ── File ops ────────────────────────────────────────────────────
  section("Phase 2a: File Operations (文件操作)");

  // stat — implemented via /api/batch (no dedicated /api/fs/stat endpoint)
  try {
    const r = await api(remoteUrl, "/api/batch", authToken, { operations: [{ type: "stat", path: "." }] });
    const d = JSON.parse(r.body);
    const result = d.results?.[0];
    r.status === 200 && result && result.status === 200
      ? pass("remote_stat: workspace root", `size=${result.size}`)
      : fail("remote_stat: unexpected", VERBOSE ? JSON.stringify(d).slice(0, 150) : undefined);
  } catch (e) { fail(`remote_stat: ${e.message}`); }

  // Create deterministic markdown file for glob/read checks
  const rf = ".agentport-read-test.md";
  const rc = `# agentport read test\nts: ${new Date().toISOString()}\n`;
  try {
    const wr = await api(remoteUrl, "/api/fs/write", authToken, { path: rf, content: rc });
    if (wr.status === 200) {
      pass("remote_read/glob: fixture created", rf);
    } else {
      fail("remote_read/glob: fixture create failed", `HTTP ${wr.status}`);
    }
  } catch (e) {
    fail(`remote_read/glob: fixture create failed`, e.message);
  }

  // glob — server returns {success, files:[...]} or {entries:[...]}
  try {
    const r = await api(remoteUrl, "/api/fs/glob", authToken, { pattern: ".agentport-*.md" });
    const d = JSON.parse(r.body);
    const files = d.files || d.entries || (Array.isArray(d) ? d : []);
    const okGlob = r.status === 200 && Array.isArray(files) && files.some((f) => String(f).includes(rf));
    okGlob
      ? pass("remote_glob: OK", `${files.length} files`)
      : fail("remote_glob: unexpected", VERBOSE ? JSON.stringify(d).slice(0, 200) : undefined);
  } catch (e) { fail(`remote_glob: ${e.message}`); }

  // read + ETag (read deterministic fixture)
  try {
    const r = await api(remoteUrl, "/api/fs/read", authToken, { path: rf });
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      typeof d.content === "string" && d.content.includes("agentport read test")
        ? pass("remote_read: content", `${(d.content.length / 1024).toFixed(1)}KB`)
        : fail("remote_read: no/invalid content");
      d.etag ? pass("remote_read: ETag", d.etag.slice(0, 16) + "...") : fail("remote_read: no ETag");
    } else {
      fail(`remote_read: HTTP ${r.status}`);
    }
  } catch (e) { fail(`remote_read: ${e.message}`); }

  // write + verify + cleanup
  const tf = ".agentport-test.txt";
  const tc = `agentport test\nts: ${new Date().toISOString()}\n`;
  try {
    const wr = await api(remoteUrl, "/api/fs/write", authToken, { path: tf, content: tc });
    if (wr.status === 200) {
      pass("remote_write: written");
      const rr = await api(remoteUrl, "/api/fs/read", authToken, { path: tf });
      if (rr.status === 200) {
        JSON.parse(rr.body).content === tc ? pass("remote_write: read-back match") : fail("remote_write: content mismatch");
      }
      await api(remoteUrl, "/api/exec", authToken, { command: `rm -f ${tf} .agentport-read-test.md` });
      pass("remote_write: cleaned up");
    } else { fail(`remote_write: HTTP ${wr.status}`); }
  } catch (e) { fail(`remote_write: ${e.message}`); }

  // ── Command execution ───────────────────────────────────────────
  section("Phase 2b: Command Execution (命令执行)");

  // bash simple — server uses 'code' not 'exitCode'
  try {
    const r = await api(remoteUrl, "/api/exec", authToken, { command: "whoami" });
    const d = JSON.parse(r.body);
    r.status === 200 && exitCode(d) === 0 && d.stdout.trim()
      ? pass("remote_bash (simple)", `user=${d.stdout.trim()}`)
      : fail("remote_bash (simple)", VERBOSE ? `code=${exitCode(d)}` : undefined);
  } catch (e) { fail(`remote_bash (simple): ${e.message}`); }

  // bash special chars (base64)
  try {
    const r = await api(remoteUrl, "/api/exec", authToken, { command: "echo $HOME && echo 'special: $ ` \\ | &'" });
    const d = JSON.parse(r.body);
    r.status === 200 && exitCode(d) === 0 && d.stdout.includes("special:")
      ? pass("remote_bash (special chars)")
      : fail("remote_bash (special chars)", VERBOSE ? `code=${exitCode(d)} stderr=${(d.stderr || "").slice(0, 80)}` : undefined);
  } catch (e) { fail(`remote_bash (special chars): ${e.message}`); }

  // bash pipe
  try {
    const r = await api(remoteUrl, "/api/exec", authToken, { command: "df -h / | tail -1" });
    const d = JSON.parse(r.body);
    r.status === 200 && exitCode(d) === 0 && d.stdout.includes("/")
      ? pass("remote_bash (pipe)", d.stdout.trim())
      : fail("remote_bash (pipe)");
  } catch (e) { fail(`remote_bash (pipe): ${e.message}`); }

  // script bash
  try {
    const r = await api(remoteUrl, "/api/exec/script", authToken, { content: "#!/bin/bash\necho 'script OK'\nwhoami", interpreter: "bash" });
    const d = JSON.parse(r.body);
    r.status === 200 && exitCode(d) === 0 && d.stdout.includes("script OK")
      ? pass("remote_script (bash)")
      : fail("remote_script (bash)", VERBOSE ? `code=${exitCode(d)}` : undefined);
  } catch (e) { fail(`remote_script (bash): ${e.message}`); }

  // script python3
  try {
    const r = await api(remoteUrl, "/api/exec/script", authToken, { content: "print('python3 OK')", interpreter: "python3" });
    const d = JSON.parse(r.body);
    r.status === 200 && exitCode(d) === 0 && d.stdout.includes("python3 OK")
      ? pass("remote_script (python3)")
      : fail("remote_script (python3)", VERBOSE ? `code=${exitCode(d)}` : undefined);
  } catch (e) { fail(`remote_script (python3): ${e.message}`); }

  // ── Batch & Async ───────────────────────────────────────────────
  section("Phase 2c: Batch & Async (批量与异步)");

  // batch — server returns {success, results:[...]}
  try {
    const r = await api(remoteUrl, "/api/batch", authToken, {
      operations: [{ type: "bash", command: "hostname" }, { type: "bash", command: "uptime" }],
    });
    const d = JSON.parse(r.body);
    const items = d.results || (Array.isArray(d) ? d : null);
    r.status === 200 && Array.isArray(items) && items.length >= 2
      ? pass("remote_batch", `${items.length} results`)
      : fail("remote_batch", VERBOSE ? JSON.stringify(d).slice(0, 150) : undefined);
  } catch (e) { fail(`remote_batch: ${e.message}`); }

  // async + task
  try {
    const ar = await api(remoteUrl, "/api/exec/async", authToken, { command: "sleep 1 && echo 'async OK' && date" });
    if (ar.status === 200) {
      const ad = JSON.parse(ar.body);
      const tid = ad.taskId;
      tid ? pass("remote_exec_async", `taskId=${tid}`) : fail("remote_exec_async: no taskId");

      if (tid) {
        await wait(2000);
        const tr = await api(remoteUrl, `/api/task/${tid}`, authToken);
        if (tr.status === 200) {
          const td = JSON.parse(tr.body);
          if (td.status === "completed") {
            pass("remote_task: completed", `exitCode=${td.exitCode}`);
            // Duration calc: server returns createdAt/finishedAt as ms timestamps
            if (td.finishedAt && td.createdAt) {
              const dur = (td.finishedAt - td.createdAt) / 1000;
              Number.isFinite(dur) ? pass("remote_task: duration OK", `${dur.toFixed(1)}s`) : fail("remote_task: duration NaN");
            } else {
              skip("remote_task: duration", "no timestamps");
            }
          } else { fail(`remote_task: status=${td.status}`); }
        } else { fail(`remote_task: HTTP ${tr.status}`); }
      }
    } else { fail(`remote_exec_async: HTTP ${ar.status}`); }
  } catch (e) { fail(`remote_exec_async: ${e.message}`); }

  // ── Diagnostics & Encoding ──────────────────────────────────────
  section("Phase 2d: Diagnostics & Encoding (诊断与编码)");

  try {
    const r = await api(remoteUrl, "/api/stats", authToken);
    r.status === 200 ? pass("remote_status: OK") : fail(`remote_status: HTTP ${r.status}`);
  } catch (e) { fail(`remote_status: ${e.message}`); }

  try {
    const r = await api(remoteUrl, "/api/exec", authToken, { command: "echo '测试中文输出'" });
    const d = JSON.parse(r.body);
    r.status === 200 && d.stdout.includes("测试中文输出")
      ? pass("UTF-8: Chinese output")
      : fail("UTF-8: Chinese output garbled");
  } catch (e) { fail(`UTF-8: ${e.message}`); }

  // ── Path Boundary & BOM ──────────────────────────────────────
  section("Phase 2e: Path Boundary & BOM (路径越界与 BOM)");

  // Test: stat on root path should return Access denied
  try {
    const r = await api(remoteUrl, "/api/batch", authToken, { operations: [{ type: "stat", path: "/" }] });
    const d = JSON.parse(r.body);
    const statResult = d?.results?.[0];
    statResult?.status !== 200 || statResult?.error
      ? pass("path boundary: stat / denied")
      : fail("path boundary: stat / should be denied");
  } catch (e) { fail(`path boundary (stat /): ${e.message}`); }

  // Test: write to /tmp should fail
  try {
    const r = await api(remoteUrl, "/api/fs/write", authToken, { path: "/tmp/agentport-boundary-test.txt", content: "test" });
    const d = JSON.parse(r.body);
    d?.error || r.status !== 200
      ? pass("path boundary: write /tmp denied")
      : fail("path boundary: write /tmp should be denied");
  } catch (e) { fail(`path boundary (write /tmp): ${e.message}`); }

  // Test: write with BOM should be auto-stripped by sanitizeContent in MCP layer
  // Note: direct API call bypasses MCP sanitization, so we verify index.js code instead
  try {
    const src = fs.readFileSync(path.join(SKILL_DIR, "index.js"), "utf-8");
    src.includes('content.startsWith("\\uFEFF")') || src.includes("startsWith(\"\\uFEFF\")")
      ? pass("BOM: sanitizeContent strips BOM in index.js")
      : fail("BOM: sanitizeContent missing BOM stripping");
  } catch (e) { fail(`BOM test: ${e.message}`); }

  // Test: formatExecOutput handles exitCode (not just code)
  try {
    const src = fs.readFileSync(path.join(SKILL_DIR, "index.js"), "utf-8");
    src.includes("data?.exitCode")
      ? pass("index.js: exitCode compatibility")
      : fail("index.js: missing exitCode compat in formatExecOutput");
  } catch (e) { fail(`exitCode check: ${e.message}`); }

  // Test: isDir compatibility in stat
  try {
    const src = fs.readFileSync(path.join(SKILL_DIR, "index.js"), "utf-8");
    src.includes("r.isDir") || src.includes("data.isDir")
      ? pass("index.js: isDir compatibility in stat")
      : fail("index.js: missing isDir compat in stat");
  } catch (e) { fail(`isDir check: ${e.message}`); }

  // Test: workspaceRoot caching from healthz
  try {
    const src = fs.readFileSync(path.join(SKILL_DIR, "index.js"), "utf-8");
    src.includes("_workspaceRoot")
      ? pass("index.js: workspaceRoot caching")
      : fail("index.js: missing workspaceRoot caching");
  } catch (e) { fail(`workspaceRoot check: ${e.message}`); }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  let pkgName = "agentport", pkgVersion = "?";
  let config = null;
  try {
    const pkg = readJsonSafe(path.join(SKILL_DIR, "package.json"));
    if (pkg) {
      pkgName = pkg.name || pkgName;
      pkgVersion = pkg.version || pkgVersion;
    }
    config = readJsonSafe(MAIN_CONFIG_PATH);
  } catch (_) {}
  
  const rm = loadRuntimeMode();
  const probeResult = detectMode(config, rm);
  const runtimeMode = probeResult.requestedMode;

  console.log(`\n${C.bold}${pkgName} Test Suite v${pkgVersion}${C.reset}`);
  let runModeStr = LOCAL_ONLY ? "Local-only" : "Full test";
  if (PREFLIGHT_ONLY) runModeStr = "Preflight checks";
  if (PROBE_ONLY) runModeStr = "Probe capabilities";
  console.log(`${C.dim}${new Date().toISOString()} | ${runModeStr} | mode=${runtimeMode}${C.reset}`);

  if (PROBE_ONLY) {
    section("Capability Probe (能力探测)");
    const pr = saveRuntimeModeResult(probeResult);
    console.log(JSON.stringify(pr, null, 2));
    process.exit(probeResult.detectedMode === "unknown" ? 1 : 0);
  }

  if (PREFLIGHT_ONLY) {
    section("Preflight Checks (预检)");
    const pr = await runPreflight(config);
    for (const c of pr.checks) {
      if (c.ok) pass(c.name, c.detail);
      else fail(c.name, c.detail);
    }
    console.log(`\nPreflight ${pr.status.toUpperCase()} (${pr.failCount} failed)`);
    process.exit(pr.status === "pass" ? 0 : 1);
  }

  // Fallback to existing full test logic
  const oldConfig = await localTests();
  if (oldConfig) {
    runModeRegressionScenarios(oldConfig);
  }

  if (!LOCAL_ONLY && oldConfig) {
    const runtime = getRemoteRuntimeEnv(oldConfig);
    const remoteUrl = runtime.remoteUrl;
    const authToken = runtime.authToken;
    if (remoteUrl) {
      await remoteTests(remoteUrl, authToken);
    } else {
      section("Phase 2: Remote Connection");
      skip("All remote tests", "REMOTE_URL not configured");
    }
  } else if (!LOCAL_ONLY) {
    section("Phase 2: Remote Connection");
    skip("All remote tests", "local config not found (expected local/agentport.json)");
  }

  const total = results.pass + results.fail;
  console.log(`\n${C.bold}${"═".repeat(50)}${C.reset}`);
  console.log(`${C.bold}Summary${C.reset}`);
  console.log(`${C.dim}${"─".repeat(50)}${C.reset}`);

  if (results.fail === 0) {
    console.log(`  ${C.green}${C.bold}ALL PASSED${C.reset}  ${results.pass}/${total}`);
  } else {
    console.log(`  ${C.red}${C.bold}FAILED${C.reset}  ${results.pass}/${total} passed, ${results.fail} failed`);
    for (const f of failures) console.log(`    - ${f.name}${f.reason ? ` — ${f.reason}` : ""}`);
  }
  if (results.skip > 0) console.log(`  ${C.yellow}${results.skip} skipped${C.reset}`);
  console.log();
  process.exit(results.fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(`\n${C.red}Fatal: ${e.message}${C.reset}`); process.exit(2); });
