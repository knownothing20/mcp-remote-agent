const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { createDevelopmentSessionService } = require('../packages/daemon-core/development-session-service.cjs');
const { assertResourceOwner, filterOwnedResources, normalizeAuthContext } = require('./auth-context.cjs');

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        const error = new Error('Request body too large'); error.statusCode = 413;
        reject(error); req.destroy(); return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readJson(req, maxBytes) {
  const buffer = await readBody(req, maxBytes);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { const error = new Error('Invalid JSON body'); error.statusCode = 400; throw error; }
}
function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}
function authHeaders(headers = {}) {
  const out = {};
  for (const key of ['authorization', 'x-mcp-token', 'x-niuma-token', 'x-mcp-client-id', 'x-niuma-client-id', 'x-client-id', 'x-agentport-trace-id', 'x-agentport-session-id', 'x-agentport-call-id']) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}
function baseRequest(baseOrigin, { method = 'GET', route = '/', headers = {}, body, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, baseOrigin);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(target, {
      method,
      headers: {
        accept: 'application/json',
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks); let data = null;
        try { data = raw.length ? JSON.parse(raw.toString('utf8')) : null; }
        catch { data = { raw: raw.toString('utf8') }; }
        resolve({ status: res.statusCode || 500, headers: res.headers, data, raw });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Base request timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function proxy(req, res, baseOrigin) {
  const target = new URL(req.url || '/', baseOrigin);
  const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: error.message });
    else res.destroy(error);
  });
  req.pipe(upstream);
}
function route(pathname) {
  if (pathname === '/api/dev/overview') return { action: 'overview' };
  if (pathname === '/api/dev/sessions') return { action: 'collection' };
  const match = pathname.match(/^\/api\/dev\/sessions\/([^/]+)(?:\/(heartbeat|run|diff|commit|rollback|merge|cleanup))?$/);
  return match ? { action: match[2] || 'item', sessionId: decodeURIComponent(match[1]) } : null;
}

function createDevelopmentFrontServer({ baseOrigin, configLoader, authorizeApi, authorizeContext, serviceFactory, maxBodyBytes = 10 * 1024 * 1024 } = {}) {
  if (!baseOrigin) throw new TypeError('baseOrigin is required');
  if (!configLoader) throw new TypeError('configLoader is required');
  if (!authorizeApi && !authorizeContext) throw new TypeError('authorizeApi or authorizeContext is required');
  const services = new Map();
  function serviceFor(config) {
    const home = config.values?.HOME || process.env.HOME || path.dirname(config.workspaceRoot);
    const sessionsDir = path.resolve(config.values?.AGENTPORT_SESSIONS_DIR || path.join(home, '.agentport', 'sessions'));
    const worktreesDir = path.resolve(config.values?.AGENTPORT_WORKTREES_DIR || path.join(config.workspaceRoot, '.agentport-worktrees'));
    const key = JSON.stringify({
      root: config.workspaceRoot,
      defaultWorkspace: config.defaultWorkspace,
      workspaceRoots: config.workspaceRoots,
      sessionsDir,
      worktreesDir,
    });
    if (!services.has(key)) {
      services.set(key, (serviceFactory || createDevelopmentSessionService)({
        workspaceRoot: config.workspaceRoot,
        workspaceScope: config.workspaceScope,
        sessionsDir,
        worktreesDir,
        defaultLeaseMs: Number(config.values?.AGENTPORT_SESSION_LEASE_MS || 1_800_000),
        lockTimeoutMs: Number(config.values?.AGENTPORT_PROJECT_LOCK_TIMEOUT_MS || 15_000),
        projectLockLeaseMs: Number(config.values?.AGENTPORT_PROJECT_LOCK_LEASE_MS || 300_000),
        maxDiffBytes: Number(config.values?.AGENTPORT_MAX_DIFF_BYTES || 2_097_152),
      }));
    }
    return services.get(key);
  }
  async function jobsFor(session, headers) {
    const rows = [];
    for (const reference of session.jobs || []) {
      try {
        const response = await baseRequest(baseOrigin, { route: `/api/jobs/${encodeURIComponent(reference.jobId)}`, headers: authHeaders(headers), timeoutMs: 10_000 });
        rows.push({ ...reference, status: response.data?.job?.status || response.data?.status || 'unknown' });
      } catch (error) {
        rows.push({ ...reference, status: 'unknown', error: error.message });
      }
    }
    return rows;
  }
  async function ensureIdle(session, headers, force = false) {
    if (force) return;
    const jobs = await jobsFor(session, headers);
    const active = jobs.filter((item) => ['queued', 'running', 'cancelling'].includes(item.status));
    if (active.length) {
      const error = new Error('Session has active jobs');
      error.code = 'ESESSION_JOBS_ACTIVE'; error.statusCode = 409; error.details = { jobs: active };
      throw error;
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://agentport.local');
    const pathname = url.pathname;
    const developmentRoute = route(pathname);
    try {
      if (req.method === 'GET' && pathname === '/healthz') {
        const base = await baseRequest(baseOrigin, { route: req.url, headers: authHeaders(req.headers), timeoutMs: 10_000 });
        const config = await configLoader.load();
        let authenticated = false;
        try {
          normalizeAuthContext(authorizeContext ? authorizeContext(req, url, config) : authorizeApi(req, url, config));
          authenticated = true;
        } catch {}
        if (!authenticated) {
          return sendJson(res, base.status, {
            ok: base.data?.ok !== false,
            time: base.data?.time,
            uptimeSec: base.data?.uptimeSec,
            gateway: { mode: base.data?.gateway?.mode, developmentSessions: true, version: 5 },
          });
        }

        const service = serviceFor(config);
        return sendJson(res, base.status, {
          ...(base.data || {}),
          gateway: { ...(base.data?.gateway || {}), developmentSessions: true, version: 5 },
          capabilities: {
            ...(base.data?.capabilities || {}),
            developmentSessions: true,
            gitWorktrees: true,
            sessionLocks: true,
            sessionDiff: true,
            sessionCommit: true,
            sessionMerge: true,
          },
          development: await service.stats(),
        });
      }
      if (!developmentRoute) return proxy(req, res, baseOrigin);

      const config = await configLoader.load();
      const auth = normalizeAuthContext(authorizeContext ? authorizeContext(req, url, config) : authorizeApi(req, url, config));
      const clientId = auth.clientId;
      const service = serviceFor(config);
      const headers = authHeaders(req.headers);

      if (developmentRoute.action === 'overview' && req.method === 'GET') {
        const [allSessions, jobs] = await Promise.all([
          service.list({ limit: 500 }),
          baseRequest(baseOrigin, { route: '/api/jobs?limit=100', headers, timeoutMs: 10_000 }).catch((error) => ({ status: 502, data: { error: error.message, jobs: [] } })),
        ]);
        const sessions = filterOwnedResources(allSessions, auth).slice(0, Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500));
        return sendJson(res, 200, {
          success: true,
          serverId: config.serverId,
          workspaceId: config.workspaceId,
          sessions,
          jobs: jobs.data?.jobs || [],
          sessionRuntime: await service.stats(),
          jobRuntime: jobs.data?.jobRuntime || null,
        });
      }
      if (developmentRoute.action === 'collection' && req.method === 'GET') {
        const requestedLimit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
        const sessions = filterOwnedResources(await service.list({ limit: 500, status: url.searchParams.get('status'), projectName: url.searchParams.get('projectName') }), auth).slice(0, requestedLimit);
        return sendJson(res, 200, { success: true, sessions, runtime: await service.stats() });
      }
      if (developmentRoute.action === 'collection' && req.method === 'POST') {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(res, 200, { success: true, session: await service.create({ ...body, clientId }) });
      }

      const session = assertResourceOwner(await service.status(developmentRoute.sessionId), auth, "Session");
      if (developmentRoute.action === 'item' && req.method === 'GET') {
        return sendJson(res, 200, { success: true, session: { ...session, jobs: await jobsFor(session, headers) } });
      }
      if (developmentRoute.action === 'heartbeat' && req.method === 'POST') {
        return sendJson(res, 200, { success: true, session: await service.heartbeat(developmentRoute.sessionId, await readJson(req, maxBodyBytes)) });
      }
      if (developmentRoute.action === 'diff' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await readJson(req, maxBodyBytes) : {};
        return sendJson(res, 200, { success: true, ...(await service.diff(developmentRoute.sessionId, { maxBytes: body.maxBytes || url.searchParams.get('maxBytes') })) });
      }
      if (developmentRoute.action === 'run' && req.method === 'POST') {
        const body = await readJson(req, maxBodyBytes);
        if (session.status !== 'active') {
          const error = new Error(`Session is ${session.status}`); error.code = 'ESESSION_STATE'; error.statusCode = 409; throw error;
        }
        const action = String(body.action || '').trim();
        const command = String(body.command || session.commands?.[action] || '').trim();
        if (!command) {
          const error = new Error('command or configured action is required'); error.code = 'EINVAL'; error.statusCode = 400; throw error;
        }
        const key = String(req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || body.idempotencyKey || body.key || `session:${developmentRoute.sessionId}:${crypto.randomUUID()}`);
        const started = await baseRequest(baseOrigin, {
          method: 'POST', route: '/api/exec/async',
          headers: { ...headers, 'idempotency-key': key },
          body: { command, cwd: session.worktreePath, timeoutMs: body.timeoutMs, queueTimeoutMs: body.queueTimeoutMs, resourceClass: body.resourceClass, idempotencyKey: key },
          timeoutMs: 30_000,
        });
        if (started.status < 200 || started.status >= 300) {
          const error = new Error(started.data?.error || 'Job start failed');
          error.statusCode = started.status; error.code = started.data?.code; error.details = started.data; throw error;
        }
        const jobId = started.data?.jobId || started.data?.taskId;
        await service.attachJob(developmentRoute.sessionId, { jobId, action, command });
        return sendJson(res, started.status, { ...started.data, success: true, sessionId: developmentRoute.sessionId, action: action || null, idempotencyKey: key });
      }
      if (developmentRoute.action === 'commit' && req.method === 'POST') {
        return sendJson(res, 200, { success: true, ...(await service.commit(developmentRoute.sessionId, await readJson(req, maxBodyBytes))) });
      }
      if (developmentRoute.action === 'rollback' && req.method === 'POST') {
        return sendJson(res, 200, { success: true, ...(await service.rollback(developmentRoute.sessionId, await readJson(req, maxBodyBytes))) });
      }
      if (developmentRoute.action === 'merge' && req.method === 'POST') {
        const body = await readJson(req, maxBodyBytes);
        await ensureIdle(session, headers, Boolean(body.force));
        return sendJson(res, 200, { success: true, ...(await service.merge(developmentRoute.sessionId, body)) });
      }
      if (developmentRoute.action === 'cleanup' && req.method === 'POST') {
        const body = await readJson(req, maxBodyBytes);
        await ensureIdle(session, headers, Boolean(body.force));
        return sendJson(res, 200, { success: true, ...(await service.cleanup(developmentRoute.sessionId, body)) });
      }
      return sendJson(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      return sendJson(res, Number(error.statusCode) || (error.code === 'ENOENT' ? 404 : 500), { error: error.message, code: error.code || null, details: error.details || null });
    }
  });
}

async function startDevelopmentGateway(options = {}) {
  const modular = require('./modular-gateway.cjs');
  const { createDaemonConfigLoader } = require('./config-loader.cjs');
  const configLoader = options.configLoader || createDaemonConfigLoader({ baseDir: __dirname, envPath: process.env.AGENTPORT_ENV_PATH });
  const config = await configLoader.load();
  const internalPort = await freePort();
  const base = await modular.startAgentPortGateway({ port: internalPort, host: '127.0.0.1', configLoader });
  const publicPort = Number(options.port ?? process.env.AGENTPORT_PUBLIC_PORT ?? config.values.PORT ?? 3183);
  const publicHost = String(options.host ?? process.env.AGENTPORT_PUBLIC_HOST ?? config.values.BIND_HOST ?? '0.0.0.0');
  const server = createDevelopmentFrontServer({ baseOrigin: `http://127.0.0.1:${internalPort}`, configLoader, authorizeApi: modular.authorizeApi, authorizeContext: modular.authorizeApiContext });
  await listen(server, publicPort, publicHost);
  console.log(`AgentPort development gateway running on ${publicHost}:${publicPort}`);
  console.log(`modular=http://127.0.0.1:${internalPort}`);
  let stopping = false;
  const stop = async (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    await new Promise((resolve) => server.close(resolve));
    await base.stop(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => stop(signal).finally(() => process.exit(0)));
  }
  return { server, base, publicHost, publicPort, internalPort, stop };
}

module.exports = { baseRequest, createDevelopmentFrontServer, freePort, route, startDevelopmentGateway };
