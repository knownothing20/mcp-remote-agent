const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");
const {
  createCommandPolicy,
  createExecService,
  createExecutionQueue,
  createFileReadService,
  createFileSearchService,
  createFileWriteService,
  createJobService,
} = require("../packages/daemon-core/index.cjs");
const { createDaemonConfigLoader } = require("./config-loader.cjs");
const { createAuditLogWriter } = require("../server/audit-log.cjs");
const { startLegacyProcess } = require("./legacy-process.cjs");
const {
  assertResourceOwner,
  authorizeContext,
  extractToken: extractAuthToken,
  filterOwnedResources,
  requestedClientId: requestedAuthClientId,
  scopeIdempotencyKey,
} = require("./auth-context.cjs");

const FILE_ROUTES = Object.freeze({
  read: new Set(["/read", "/api/fs/read"]),
  readBytes: new Set(["/api/fs/read-bytes"]),
  stat: new Set(["/stat", "/api/fs/stat"]),
  manifest: new Set(["/api/fs/manifest"]),
  glob: new Set(["/glob", "/api/fs/glob"]),
  grep: new Set(["/grep", "/api/fs/grep"]),
  write: new Set(["/write", "/api/fs/write"]),
  remove: new Set(["/api/fs/remove", "/api/fs/delete"]),
});

const EXEC_ROUTES = Object.freeze({
  execute: new Set(["/bash", "/api/exec", "/api/cmd/execute"]),
  script: new Set(["/api/exec/script"]),
});

function nowIso() { return new Date().toISOString(); }

function extractToken(req, url) { return extractAuthToken(req, url); }
function requestedClientId(req) { return requestedAuthClientId(req); }
function authorizeApiContext(req, url, config) { return authorizeContext(req, url, config); }
function authorizeApi(req, url, config) { return authorizeApiContext(req, url, config).clientId; }

function readBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        const error = new Error(`Request body exceeds ${maxBytes} bytes`);
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

async function readJson(req, maxBytes) {
  const buffer = await readBody(req, maxBytes);
  if (buffer.length === 0) return { body: {}, buffer };
  try {
    return { body: JSON.parse(buffer.toString("utf8")), buffer };
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sanitizeProxyHeaders(headers, target, bodyBuffer) {
  const next = { ...headers, host: target.host };
  delete next.connection;
  if (bodyBuffer) {
    next["content-length"] = String(bodyBuffer.length);
    delete next["transfer-encoding"];
  }
  return next;
}

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

function requestLegacy(legacyOrigin, {
  method,
  requestPath,
  headers,
  bodyBuffer,
  timeoutMs = 120_000,
}) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, legacyOrigin);
    const request = transportFor(target).request(target, {
      method,
      headers: sanitizeProxyHeaders(headers || {}, target, bodyBuffer),
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Legacy request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    if (bodyBuffer?.length) request.write(bodyBuffer);
    request.end();
  });
}

function sendLegacyResponse(res, response) {
  const headers = { ...response.headers };
  delete headers.connection;
  delete headers["transfer-encoding"];
  headers["content-length"] = String(response.body.length);
  res.writeHead(response.statusCode, headers);
  res.end(response.body);
}

function proxyRequest(req, res, legacyOrigin) {
  const target = new URL(req.url || "/", legacyOrigin);
  const proxy = transportFor(target).request(target, {
    method: req.method,
    headers: sanitizeProxyHeaders(req.headers, target),
  }, (proxyResponse) => {
    const headers = { ...proxyResponse.headers };
    delete headers.connection;
    res.writeHead(proxyResponse.statusCode || 502, headers);
    proxyResponse.pipe(res);
  });
  proxy.on("error", (error) => {
    if (!res.headersSent) {
      sendJson(res, 502, { error: `Legacy daemon unavailable: ${error.message}` });
    } else {
      res.destroy(error);
    }
  });
  req.pipe(proxy);
}

function runtimeKey(config) {
  return JSON.stringify({
    workspaceRoot: config.workspaceRoot,
    defaultWorkspace: config.defaultWorkspace,
    workspaceRoots: config.workspaceRoots,
    jobsDir: config.jobsDir,
    command: config.command,
    exec: config.exec,
    jobs: config.jobs,
  });
}

function createServiceRegistry() {
  const cache = new Map();
  return function servicesFor(config) {
    const key = runtimeKey(config);
    if (!cache.has(key)) {
      const policy = createCommandPolicy({
        allowExec: config.command.allowExec,
        allowedCommands: config.command.allowedCommands,
        allowedInterpreters: config.command.allowedInterpreters || undefined,
      });
      const queue = createExecutionQueue({
        maxConcurrency: config.exec.maxConcurrency,
        queueTimeoutMs: config.exec.queueTimeoutMs,
      });
      cache.set(key, Object.freeze({
        reader: createFileReadService({ workspaceRoot: config.workspaceRoot, workspaceScope: config.workspaceScope }),
        search: createFileSearchService({ workspaceRoot: config.workspaceRoot, workspaceScope: config.workspaceScope }),
        writer: createFileWriteService({ workspaceRoot: config.workspaceRoot, workspaceScope: config.workspaceScope }),
        policy,
        queue,
        exec: createExecService({
          workspaceRoot: config.workspaceRoot,
          workspaceScope: config.workspaceScope,
          policy,
          queue,
          defaultTimeoutMs: config.exec.timeoutMs,
          maxTimeoutMs: config.exec.maxTimeoutMs,
          maxBufferBytes: config.exec.maxBufferBytes,
        }),
        jobs: createJobService({
          jobsDir: config.jobsDir,
          workspaceRoot: config.workspaceRoot,
          workspaceScope: config.workspaceScope,
          policy,
          maxConcurrency: config.jobs.maxConcurrency,
          queueTimeoutMs: config.jobs.queueTimeoutMs,
          defaultTimeoutMs: config.jobs.defaultTimeoutMs,
          maxTimeoutMs: config.jobs.maxTimeoutMs,
          logChunkBytes: config.jobs.logChunkBytes,
        }),
      }));
    }
    return cache.get(key);
  };
}

const auditWriters = new Map();

function auditWriterFor(config) {
  const key = JSON.stringify({
    path: config.auditLogPath,
    maxBytes: config.audit?.maxBytes,
    maxFiles: config.audit?.maxFiles,
  });
  if (!auditWriters.has(key)) {
    auditWriters.set(key, createAuditLogWriter({
      filePath: config.auditLogPath,
      maxBytes: config.audit?.maxBytes,
      maxFiles: config.audit?.maxFiles,
    }));
  }
  return auditWriters.get(key);
}

async function appendAudit(config, event) {
  try {
    await auditWriterFor(config).append({ ts: nowIso(), gateway: "modular-v3", ...event });
  } catch {}
}

function routeType(pathname) {
  for (const [type, paths] of Object.entries(FILE_ROUTES)) {
    if (paths.has(pathname)) return type;
  }
  return null;
}

function execRouteType(pathname) {
  for (const [type, paths] of Object.entries(EXEC_ROUTES)) {
    if (paths.has(pathname)) return type;
  }
  return null;
}

function jobRoute(pathname) {
  if (pathname === "/api/jobs") return { action: "collection" };
  if (pathname === "/api/jobs/start") return { action: "start" };
  if (pathname === "/api/exec/async") return { action: "async-start" };
  let match = pathname.match(/^\/api\/jobs\/([^/]+)\/logs$/);
  if (match) return { action: "logs", jobId: decodeURIComponent(match[1]) };
  match = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (match) return { action: "cancel", jobId: decodeURIComponent(match[1]) };
  match = pathname.match(/^\/api\/jobs\/([^/]+)\/delete$/);
  if (match) return { action: "delete", jobId: decodeURIComponent(match[1]) };
  match = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (match) return { action: "item", jobId: decodeURIComponent(match[1]) };
  match = pathname.match(/^\/api\/task\/([^/]+)$/);
  if (match) return { action: "task", jobId: decodeURIComponent(match[1]) };
  return null;
}

function idempotencyKey(req, body) {
  return String(
    req.headers["idempotency-key"]
      || req.headers["x-idempotency-key"]
      || body.idempotencyKey
      || body.key
      || "",
  ).trim();
}

function executionFailure(error, queueStats) {
  return {
    success: false,
    error: error.message,
    code: typeof error.code === "number" ? error.code : (error.code || null),
    stdout: error.stdout || "",
    stderr: error.stderr || "",
    signal: error.signal || null,
    timeoutMs: error.timeoutMs,
    exec: error.details || queueStats,
  };
}

async function handleExecRoute({
  req,
  res,
  pathname,
  config,
  services,
  clientId,
  maxBodyBytes,
  startedAt,
}) {
  const type = execRouteType(pathname);
  if (!type || req.method !== "POST") return false;
  const { body } = await readJson(req, maxBodyBytes);
  try {
    const value = type === "execute"
      ? await services.exec.execute(body.command, {
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        queueTimeoutMs: body.queueTimeoutMs,
        maxBufferBytes: body.maxBufferBytes,
      })
      : await services.exec.executeScript(body.content, {
        interpreter: body.interpreter,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        queueTimeoutMs: body.queueTimeoutMs,
        maxBufferBytes: body.maxBufferBytes,
      });
    await appendAudit(config, {
      type: type === "execute" ? "exec" : "exec.script",
      clientId,
      command: type === "execute" ? String(body.command || "").slice(0, 300) : undefined,
      interpreter: body.interpreter,
      ok: true,
      ms: Date.now() - startedAt,
    });
    sendJson(res, 200, { success: true, ...value, exec: services.queue.stats() });
  } catch (error) {
    await appendAudit(config, {
      type: type === "execute" ? "exec" : "exec.script",
      clientId,
      ok: false,
      error: error.message,
      ms: Date.now() - startedAt,
    });
    sendJson(res, Number(error.statusCode) || 500, executionFailure(error, services.queue.stats()));
  }
  return true;
}

async function handleJobRoute({
  req,
  res,
  url,
  pathname,
  config,
  services,
  auth,
  maxBodyBytes,
  startedAt,
}) {
  const route = jobRoute(pathname);
  const clientId = auth.clientId;
  if (!route) return false;
  try {
    if (
      (route.action === "collection" && req.method === "POST")
      || (route.action === "start" && req.method === "POST")
      || (route.action === "async-start" && req.method === "POST")
    ) {
      const { body } = await readJson(req, maxBodyBytes);
      const started = await services.jobs.start({
        command: body.command,
        cwd: body.cwd,
        clientId,
        connection: body.connection,
        timeoutMs: body.timeoutMs,
        queueTimeoutMs: body.queueTimeoutMs,
        resourceClass: body.resourceClass,
        idempotencyKey: scopeIdempotencyKey(clientId, idempotencyKey(req, body)),
      });
      const job = services.jobs.publicJob(started.job);
      await appendAudit(config, {
        type: route.action === "async-start" ? "exec.async" : "job.start",
        clientId,
        jobId: job.id,
        reused: started.reused,
        ok: true,
        ms: Date.now() - startedAt,
      });
      sendJson(res, 200, {
        success: true,
        jobId: job.id,
        taskId: job.id,
        status: job.status,
        createdAt: job.createdAt,
        job,
        reused: started.reused,
      });
      return true;
    }

    if (route.action === "collection" && req.method === "GET") {
      const requestedLimit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 500);
      const candidates = await services.jobs.list({
        limit: auth.isAdmin ? requestedLimit : 500,
        status: url.searchParams.get("status") || "",
      });
      const jobs = filterOwnedResources(candidates, auth).slice(0, requestedLimit);
      sendJson(res, 200, {
        success: true,
        jobs,
        count: jobs.length,
        jobRuntime: services.jobs.stats(),
      });
      return true;
    }

    if (route.action === "item" && req.method === "GET") {
      const job = assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");
      sendJson(res, 200, { success: true, job, ...job });
      return true;
    }

    if (route.action === "logs" && req.method === "GET") {
      assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");
      const value = await services.jobs.logs(route.jobId, {
        cursor: url.searchParams.get("cursor") || "",
        maxBytes: url.searchParams.get("maxBytes") || undefined,
        tailBytes: url.searchParams.get("tailBytes")
          || url.searchParams.get("bytes")
          || undefined,
      });
      sendJson(res, 200, { success: true, ...value });
      return true;
    }

    if (route.action === "cancel" && req.method === "POST") {
      assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");
      const value = await services.jobs.cancel(route.jobId);
      await appendAudit(config, {
        type: "job.cancel",
        clientId,
        jobId: route.jobId,
        cancelled: value.cancelled,
        ok: true,
        ms: Date.now() - startedAt,
      });
      sendJson(res, 200, { success: true, ...value });
      return true;
    }

    if (
      (route.action === "delete" && req.method === "POST")
      || (route.action === "item" && req.method === "DELETE")
    ) {
      assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");
      const value = await services.jobs.remove(route.jobId);
      await appendAudit(config, {
        type: "job.delete",
        clientId,
        jobId: route.jobId,
        ok: true,
        ms: Date.now() - startedAt,
      });
      sendJson(res, 200, { success: true, ...value });
      return true;
    }

    if (route.action === "task" && req.method === "GET") {
      const job = assertResourceOwner(await services.jobs.get(route.jobId), auth, "Job");
      const logs = await services.jobs.logs(route.jobId, {
        tailBytes: config.jobs.logChunkBytes,
      });
      sendJson(res, 200, {
        success: true,
        ...job,
        id: job.id,
        taskId: job.id,
        command: job.commandPreview,
        terminalStatus: job.status,
        status: ["timeout", "cancelled", "orphaned"].includes(job.status)
          ? "error"
          : job.status,
        stdout: logs.stdout.content,
        stderr: logs.stderr.content,
        cursor: logs.cursor,
      });
      return true;
    }

    return false;
  } catch (error) {
    await appendAudit(config, {
      type: `job.${route.action}`,
      clientId,
      jobId: route.jobId || null,
      ok: false,
      error: error.message,
      ms: Date.now() - startedAt,
    });
    const statusCode = Number(error.statusCode)
      || (error.code === "ENOENT" ? 404 : 500);
    sendJson(res, statusCode, {
      error: statusCode === 404 ? "Job not found" : error.message,
      code: error.code || null,
      jobId: error.jobId || route.jobId || null,
      jobQueue: error.jobQueue || null,
    });
    return true;
  }
}

async function handleBatch({
  req,
  res,
  config,
  services,
  clientId,
  maxBodyBytes,
  startedAt,
}) {
  if (req.method !== "POST") return false;
  const { body } = await readJson(req, maxBodyBytes);
  const operations = Array.isArray(body.operations) ? body.operations : [];
  if (!operations.length) {
    sendJson(res, 400, { error: "operations array is required" });
    return true;
  }
  if (operations.length > 20) {
    sendJson(res, 400, { error: "Maximum 20 operations per batch" });
    return true;
  }
  const results = [];
  for (const op of operations) {
    const opStarted = Date.now();
    try {
      if (op.type === "read") {
        const value = await services.reader.readText(op.path, op);
        const ifNoneMatch = String(op.ifNoneMatch || "").trim();
        results.push(
          ifNoneMatch && ifNoneMatch === value.etag
            ? {
              type: "read",
              path: op.path,
              status: 304,
              etag: value.etag,
              cached: true,
              ms: Date.now() - opStarted,
            }
            : {
              type: "read",
              path: op.path,
              status: 200,
              ...value,
              ms: Date.now() - opStarted,
            },
        );
      } else if (op.type === "stat") {
        const value = await services.reader.stat(op.path);
        results.push({
          type: "stat",
          path: op.path,
          status: 200,
          ...value,
          mtime: new Date(value.mtimeMs).toISOString(),
          isDir: value.isDirectory,
          ms: Date.now() - opStarted,
        });
      } else if (op.type === "glob") {
        const value = await services.search.glob(op.pattern, op);
        results.push({
          type: "glob",
          pattern: op.pattern,
          status: 200,
          ...value,
          ms: Date.now() - opStarted,
        });
      } else if (op.type === "grep") {
        const value = await services.search.grep(op);
        results.push({
          type: "grep",
          pattern: op.pattern,
          status: 200,
          ...value,
          ms: Date.now() - opStarted,
        });
      } else if (op.type === "bash") {
        const value = await services.exec.execute(op.command, {
          cwd: op.cwd,
          timeoutMs: op.timeoutMs,
          queueTimeoutMs: op.queueTimeoutMs,
        });
        results.push({
          type: "bash",
          command: op.command,
          status: 200,
          ...value,
          ms: Date.now() - opStarted,
        });
      } else if (op.type === "write") {
        const value = await services.writer.writeText(op.path, op.content, op);
        results.push({
          type: "write",
          path: op.path,
          status: 200,
          ...value,
          ms: Date.now() - opStarted,
        });
      } else {
        results.push({
          type: op.type,
          status: 400,
          error: "Unknown operation type",
          ms: Date.now() - opStarted,
        });
      }
    } catch (error) {
      results.push({
        type: op.type,
        path: op.path,
        command: op.command,
        status: Number(error.statusCode) || 500,
        error: error.message,
        code: error.code || null,
        stdout: error.stdout,
        stderr: error.stderr,
        ms: Date.now() - opStarted,
      });
    }
  }
  await appendAudit(config, {
    type: "batch",
    clientId,
    count: operations.length,
    ok: true,
    ms: Date.now() - startedAt,
  });
  sendJson(res, 200, {
    success: true,
    results,
    exec: services.queue.stats(),
  });
  return true;
}

function createAgentPortGateway({
  legacyOrigin,
  configLoader = createDaemonConfigLoader(),
  maxBodyBytes = 50 * 1024 * 1024,
} = {}) {
  if (!legacyOrigin) throw new TypeError("legacyOrigin is required");
  const servicesFor = createServiceRegistry();

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url || "/", "http://agentport.local");
    const pathname = url.pathname;
    try {
      if (req.method === "GET" && pathname === "/healthz") {
        const [legacy, config] = await Promise.all([
          requestLegacy(legacyOrigin, {
            method: "GET",
            requestPath: req.url,
            headers: req.headers,
            timeoutMs: 10_000,
          }),
          configLoader.load(),
        ]);
        let payload;
        try {
          payload = JSON.parse(legacy.body.toString("utf8"));
        } catch {
          payload = { ok: legacy.statusCode < 500 };
        }
        let authenticated = false;
        try {
          authorizeApiContext(req, url, config);
          authenticated = true;
        } catch {}
        if (!authenticated) {
          return sendJson(res, legacy.statusCode, {
            ok: payload.ok !== false,
            time: payload.time,
            uptimeSec: payload.uptimeSec,
            gateway: { mode: "modular-exec-job-proxy", version: 3 },
          });
        }

        const services = servicesFor(config);
        return sendJson(res, legacy.statusCode, {
          ...payload,
          serverId: config.serverId,
          workspaceId: config.workspaceId,
          gateway: {
            mode: "modular-exec-job-proxy",
            version: 3,
            legacyOrigin,
          },
          exec: {
            ...(payload.exec || {}),
            modular: services.queue.stats(),
          },
          jobRuntime: services.jobs.stats(),
          capabilities: {
            ...(payload.capabilities || {}),
            fileReadRanges: true,
            fileReadBytes: true,
            fileManifest: true,
            safeGlob: true,
            safeGrep: true,
            atomicWrite: true,
            symlinkEscapeGuard: true,
            modularExec: true,
            persistentJobWorker: true,
            idempotentJobs: true,
            cursorJobLogs: true,
            restartRecoverableJobs: true,
            resourceOwnership: true,
            clientScopedIdempotency: true,
          },
        });
      }

      if (req.method === "POST" && pathname === "/update-workspace") {
        const { body, buffer } = await readJson(req, maxBodyBytes);
        const legacy = await requestLegacy(legacyOrigin, {
          method: req.method,
          requestPath: req.url,
          headers: req.headers,
          bodyBuffer: buffer,
        });
        if (
          legacy.statusCode >= 200
          && legacy.statusCode < 300
          && typeof body.new_workspace === "string"
          && body.new_workspace.trim()
        ) {
          configLoader.setWorkspaceRoot(body.new_workspace.trim());
        }
        return sendLegacyResponse(res, legacy);
      }

      if (
        pathname === "/api/config"
        && req.method !== "GET"
        && req.method !== "HEAD"
      ) {
        const buffer = await readBody(req, maxBodyBytes);
        const legacy = await requestLegacy(legacyOrigin, {
          method: req.method,
          requestPath: req.url,
          headers: req.headers,
          bodyBuffer: buffer,
        });
        if (legacy.statusCode >= 200 && legacy.statusCode < 300) {
          configLoader.clearWorkspaceRootOverride();
        }
        return sendLegacyResponse(res, legacy);
      }

      const fileType = routeType(pathname);
      const execType = execRouteType(pathname);
      const jobs = jobRoute(pathname);
      const extracted = fileType || execType || jobs || pathname === "/api/batch";
      if (!extracted) return proxyRequest(req, res, legacyOrigin);

      const config = await configLoader.load();
      const auth = authorizeApiContext(req, url, config);
      const clientId = auth.clientId;
      const services = servicesFor(config);

      if (await handleExecRoute({
        req,
        res,
        pathname,
        config,
        services,
        clientId,
        maxBodyBytes,
        startedAt,
      })) return;

      if (await handleJobRoute({
        req,
        res,
        url,
        pathname,
        config,
        services,
        auth,
        maxBodyBytes,
        startedAt,
      })) return;

      if (
        pathname === "/api/batch"
        && await handleBatch({
          req,
          res,
          config,
          services,
          clientId,
          maxBodyBytes,
          startedAt,
        })
      ) return;

      if (!fileType || !["POST", "DELETE"].includes(req.method || "")) {
        return proxyRequest(req, res, legacyOrigin);
      }
      const { body } = await readJson(req, maxBodyBytes);
      let result;

      if (fileType === "read") {
        result = await services.reader.readText(body.path, {
          startLine: body.startLine,
          endLine: body.endLine,
          maxBytes: body.maxBytes,
          maxScanBytes: body.maxScanBytes,
        });
        const ifNoneMatch = String(
          req.headers["if-none-match"] || body.ifNoneMatch || "",
        ).replace(/^"|"$/g, "").trim();
        if (ifNoneMatch && ifNoneMatch === result.etag) {
          await appendAudit(config, {
            type: "fs.read",
            clientId,
            path: body.path,
            ok: true,
            cached: true,
            ms: Date.now() - startedAt,
          });
          return sendJson(res, 304, {
            success: true,
            etag: result.etag,
            cached: true,
          });
        }
        result = { success: true, ...result };
      } else if (fileType === "readBytes") {
        result = {
          success: true,
          ...(await services.reader.readBytes(body.path, body)),
        };
      } else if (fileType === "stat") {
        const value = await services.reader.stat(body.path);
        result = {
          success: true,
          ...value,
          mtime: new Date(value.mtimeMs).toISOString(),
          isDir: value.isDirectory,
        };
      } else if (fileType === "manifest") {
        result = {
          success: true,
          ...(await services.reader.manifest(body.path || ".", body)),
        };
      } else if (fileType === "glob") {
        result = await services.search.glob(body.pattern, body);
      } else if (fileType === "grep") {
        result = await services.search.grep(body);
      } else if (fileType === "write") {
        const value = await services.writer.writeText(body.path, body.content, {
          expectedEtag: body.expectedEtag,
          createOnly: body.createOnly,
          mode: body.mode,
        });
        result = {
          message: "File written successfully",
          ...value,
        };
      } else if (fileType === "remove") {
        result = await services.writer.removeFile(
          body.path || url.searchParams.get("path"),
          { expectedEtag: body.expectedEtag },
        );
      }

      await appendAudit(config, {
        type: `fs.${fileType}`,
        clientId,
        path: body.path,
        pattern: body.pattern,
        ok: true,
        ms: Date.now() - startedAt,
      });
      sendJson(res, 200, result);
    } catch (error) {
      let config = null;
      try {
        config = await configLoader.load();
      } catch {}
      if (config) {
        const fileType = routeType(pathname);
        const dynamicJobRoute = jobRoute(pathname);
        await appendAudit(config, {
          type: `${fileType ? "fs." : "gateway."}${
            fileType
              || execRouteType(pathname)
              || dynamicJobRoute?.action
              || "request"
          }`,
          clientId: requestedClientId(req) || null,
          ok: false,
          error: error.message,
          ms: Date.now() - startedAt,
        });
      }
      const statusCode = Number(error.statusCode)
        || (error.code === "ENOENT" ? 404 : 500);
      sendJson(res, statusCode, {
        error: statusCode === 404 ? "Not found" : error.message,
        code: error.code || null,
        currentEtag: error.currentEtag || null,
        stdout: error.stdout,
        stderr: error.stderr,
        jobId: error.jobId || null,
      });
    }
  });
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function startAgentPortGateway(options = {}) {
  const configLoader = options.configLoader || createDaemonConfigLoader({
    baseDir: __dirname,
    envPath: process.env.AGENTPORT_ENV_PATH,
  });
  const config = await configLoader.load();
  const publicPort = Number(
    options.port
      || process.env.AGENTPORT_PUBLIC_PORT
      || config.values.PORT
      || 3183,
  );
  const publicHost = String(
    options.host
      || process.env.AGENTPORT_PUBLIC_HOST
      || config.values.BIND_HOST
      || "0.0.0.0",
  );
  let legacyProcess = null;
  let legacyOrigin = options.legacyOrigin
    || process.env.AGENTPORT_LEGACY_ORIGIN
    || "";

  if (!legacyOrigin) {
    legacyProcess = await startLegacyProcess({
      entryPath: process.env.AGENTPORT_LEGACY_ENTRY
        || path.join(__dirname, "..", "server", "server.js"),
      port: process.env.AGENTPORT_LEGACY_PORT,
    });
    legacyOrigin = legacyProcess.origin;
  }

  const gateway = createAgentPortGateway({ legacyOrigin, configLoader });
  await listen(gateway, publicPort, publicHost);
  console.log(`AgentPort modular gateway running on ${publicHost}:${publicPort}`);
  console.log(`legacy=${legacyOrigin}`);
  console.log(`workspace=${config.workspaceRoot}`);
  console.log(`jobs=${config.jobsDir}`);

  let stopping = false;
  const stop = async (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    await new Promise((resolve) => gateway.close(resolve));
    legacyProcess?.stop(signal);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      stop(signal).finally(() => process.exit(0));
    });
  }
  if (legacyProcess?.child) {
    legacyProcess.child.once("exit", (code, signal) => {
      if (stopping) return;
      console.error(
        `Legacy daemon exited unexpectedly: code=${code} signal=${signal || ""}`,
      );
      gateway.close(() => process.exit(code || 1));
    });
  }

  return {
    gateway,
    legacyOrigin,
    legacyProcess,
    publicHost,
    publicPort,
    stop,
  };
}

module.exports = {
  EXEC_ROUTES,
  FILE_ROUTES,
  authorizeApi,
  authorizeApiContext,
  createAgentPortGateway,
  extractToken,
  jobRoute,
  requestLegacy,
  startAgentPortGateway,
};
