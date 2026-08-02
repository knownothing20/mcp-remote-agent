const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDevelopmentFrontServer } = require('../daemon/development-gateway.cjs');
const { authorizeContext } = require('../daemon/auth-context.cjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function request(port, method, requestPath, body, headers = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: requestPath,
      headers: {
        authorization: 'Bearer secret-a',
        'x-mcp-client-id': 'client-a',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-dev-gateway-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'AgentPort Test']);
  git(repo, ['config', 'user.email', 'agentport@example.com']);
  await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);

  let jobCounter = 0;
  const base = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, serverId: 'server-main', workspaceId: 'workspace-main' }));
      if (req.url === '/api/exec/async') {
        jobCounter += 1;
        return res.end(JSON.stringify({ success: true, jobId: `job-${jobCounter}`, status: 'running' }));
      }
      if (req.url === '/api/jobs/job-1') return res.end(JSON.stringify({ success: true, job: { id: 'job-1', status: 'completed' } }));
      if (req.url.startsWith('/api/jobs')) return res.end(JSON.stringify({ success: true, jobs: [] }));
      return res.end(JSON.stringify({ proxied: true, path: req.url }));
    });
  });
  const basePort = await listen(base);
  const configLoader = {
    async load() {
      return {
        workspaceRoot: root,
        serverId: 'server-main',
        workspaceId: 'workspace-main',
        values: { HOME: root },
        tokenClientMap: new Map([['secret-a', 'client-a'], ['secret-b', 'client-b']]),
        adminTokens: new Set(['admin-secret']),
      };
    },
  };
  const front = createDevelopmentFrontServer({ baseOrigin: `http://127.0.0.1:${basePort}`, configLoader, authorizeContext });
  const port = await listen(front);

  try {
    const publicHealth = await request(port, 'GET', '/healthz', undefined, { authorization: '', 'x-mcp-client-id': '' });
    assert.equal(publicHealth.data.development, undefined);
    assert.equal(publicHealth.data.serverId, undefined);

    const health = await request(port, 'GET', '/healthz');
    assert.equal(health.data.capabilities.gitWorktrees, true);

    const created = await request(port, 'POST', '/api/dev/sessions', {
      projectRoot: repo,
      projectName: 'demo',
      baseRef: 'main',
      targetBranch: 'main',
      commands: { test: 'echo ok' },
    });
    assert.equal(created.status, 200);
    const session = created.data.session;
    assert.ok(
      session.worktreePath.startsWith(`${path.join(root, '.agentport-worktrees')}${path.sep}`),
      `unexpected default worktree path: ${session.worktreePath}`,
    );

    const clientBHeaders = { authorization: 'Bearer secret-b', 'x-mcp-client-id': 'client-b' };
    const adminHeaders = { authorization: 'Bearer admin-secret' };
    const hiddenList = await request(port, 'GET', '/api/dev/sessions', undefined, clientBHeaders);
    assert.equal(hiddenList.data.sessions.length, 0);
    for (const [method, suffix, payload] of [
      ['GET', '', undefined], ['GET', '/diff', undefined], ['POST', '/run', { command: 'echo denied' }],
      ['POST', '/commit', { message: 'denied' }], ['POST', '/rollback', { confirm: session.id }],
      ['POST', '/merge', { confirm: session.id }], ['POST', '/cleanup', { confirm: session.id, force: true }],
    ]) {
      const denied = await request(port, method, `/api/dev/sessions/${session.id}${suffix}`, payload, clientBHeaders);
      assert.equal(denied.status, 403);
      assert.equal(denied.data.code, 'EOWNER');
    }
    const adminVisible = await request(port, 'GET', `/api/dev/sessions/${session.id}`, undefined, adminHeaders);
    assert.equal(adminVisible.status, 200);

    await fs.writeFile(path.join(session.worktreePath, 'README.md'), 'changed\n');

    const diff = await request(port, 'GET', `/api/dev/sessions/${session.id}/diff`);
    assert.match(diff.data.diff, /changed/);

    const committed = await request(port, 'POST', `/api/dev/sessions/${session.id}/commit`, {
      message: 'change', authorName: 'AgentPort Test', authorEmail: 'agentport@example.com',
    });
    assert.equal(committed.data.committed, true);

    const started = await request(port, 'POST', `/api/dev/sessions/${session.id}/run`, {
      action: 'test', idempotencyKey: 'demo:test:1',
    }, { 'idempotency-key': 'demo:test:1' });
    assert.equal(started.data.jobId, 'job-1');
    assert.equal(started.data.idempotencyKey, 'demo:test:1');

    const merged = await request(port, 'POST', `/api/dev/sessions/${session.id}/merge`, {
      confirm: session.id, targetBranch: 'main',
    });
    assert.equal(merged.data.merged, true);

    const cleaned = await request(port, 'POST', `/api/dev/sessions/${session.id}/cleanup`, {
      confirm: session.id, deleteBranch: true,
    });
    assert.equal(cleaned.data.cleaned, true);

    const overview = await request(port, 'GET', '/api/dev/overview');
    assert.equal(overview.data.sessions.length, 1);
  } finally {
    await close(front);
    await close(base);
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('PASS development gateway routes, Job attachment, merge, cleanup, and overview');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
