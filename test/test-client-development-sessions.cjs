const assert = require('node:assert/strict');
const http = require('node:http');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

async function main() {
  let runAttempts = 0;
  let receivedKey = null;
  const daemon = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      res.setHeader('content-type', 'application/json');
      if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, serverId: 'server-main', workspaceId: 'workspace-main' }));
      if (req.url === '/api/dev/sessions' && req.method === 'POST') {
        assert.equal(body.projectRoot, '/srv/projects/demo');
        assert.equal(body.commands.build, 'npm run build');
        return res.end(JSON.stringify({ success: true, session: { id: 'session-1', worktreePath: '/srv/worktrees/session-1' } }));
      }
      if (req.url === '/api/dev/sessions/session-1/run') {
        runAttempts += 1;
        receivedKey = req.headers['idempotency-key'];
        if (runAttempts === 1) { req.socket.destroy(); return; }
        return res.end(JSON.stringify({ success: true, jobId: 'job-1', idempotencyKey: receivedKey }));
      }
      if (req.url === '/api/dev/sessions/session-1/diff') return res.end(JSON.stringify({ success: true, diff: 'patch' }));
      if (req.url === '/api/dev/sessions/session-1') return res.end(JSON.stringify({ success: true, session: { id: 'session-1', status: 'active' } }));
      return res.end(JSON.stringify({ success: true, sessions: [] }));
    });
  });
  const port = await listen(daemon);
  try {
    const { createDevelopmentSessionClient } = await import('../packages/client-core/development-sessions.js');
    const server = {
      id: 'server-main', workspaceId: 'workspace-main',
      endpoints: [{ id: 'daemon-lan', type: 'daemon', scope: 'lan', url: `http://127.0.0.1:${port}`, priority: 1, clientId: 'client-a', authToken: 'secret' }],
    };
    const runtime = {
      selectedServerId: 'server-main', selectedEndpointId: null,
      registry: { resolveTarget() { return { server, endpoint: null }; } },
      async probeServer() { return { server, healthByEndpoint: { 'daemon-lan': { ok: true, serverId: 'server-main', workspaceId: 'workspace-main', latencyMs: 1 } } }; },
      projects: new Map([['demo', { name: 'demo', server: 'server-main', root: '/srv/projects/demo', defaultBranch: 'main', commands: { build: 'npm run build' }, agentRules: ['AGENTS.md'] }]]),
    };
    const sessions = createDevelopmentSessionClient(runtime, { sessionId: 'mcp-test' });
    try {
      const created = await sessions.create('demo', { agentId: 'codex', task: 'build' });
      assert.equal(created.data.session.id, 'session-1');
      const run = await sessions.run('session-1', 'build', { idempotencyKey: 'session-1:build:abc' });
      assert.equal(run.data.jobId, 'job-1');
      assert.equal(run.meta.attempts, 2);
      assert.equal(receivedKey, 'session-1:build:abc');
      const status = await sessions.status('session-1');
      assert.equal(status.data.session.status, 'active');
      const diff = await sessions.diff('session-1');
      assert.equal(diff.data.diff, 'patch');
    } finally {
      sessions.close();
    }
  } finally {
    await close(daemon);
  }
  console.log('PASS client development sessions, project profile, daemon selection, and idempotent retry');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
