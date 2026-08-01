const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWriteFile } = require('./atomic-write.cjs');
const { createWorkspacePathGuard, isWithin } = require('./path-guard.cjs');
const { pidAlive, terminateProcessTree } = require('./process-utils.cjs');
const { createProjectLockManager } = require('./project-lock.cjs');

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeId(value, label = 'id') {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[A-Za-z0-9._-]{1,120}$/.test(normalized)) {
    const error = new Error(`${label} must match [A-Za-z0-9._-] and be at most 120 characters`);
    error.code = 'EINVAL'; error.statusCode = 400; throw error;
  }
  return normalized;
}
function slug(value, fallback = 'task') {
  const out = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return out || fallback;
}
function errorWith(message, code, statusCode = 400, details = null) {
  const error = new Error(message); error.code = code; error.statusCode = statusCode; if (details) error.details = details; return error;
}
function truncate(text, maxBytes) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.length <= maxBytes) return { content: buffer.toString('utf8'), truncated: false, bytes: buffer.length };
  return { content: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true, bytes: buffer.length };
}
function normalizedCommands(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, command] of Object.entries(value)) {
    if (typeof command !== 'string' || !command.trim()) continue;
    out[slug(key, 'action')] = command.trim();
    if (Object.keys(out).length >= 32) break;
  }
  return out;
}
function normalizedRules(value) {
  const values = Array.isArray(value) ? value : ['AGENTS.md', 'AI_INSTRUCTIONS.md', 'CLAUDE.md'];
  return [...new Set(values.map((item) => String(item || '').trim()).filter((item) => item && !path.posix.isAbsolute(item) && !item.split('/').includes('..')).slice(0, 32))];
}

async function run(command, args, { cwd, timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024, allowCodes = [0], env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let settled = false; let timer = null;
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      return next.length > maxBytes ? next.subarray(0, maxBytes) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (cause) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer);
      reject(errorWith(`${command} failed to start: ${cause.message}`, cause.code || 'ESPAWN', 500));
    });
    child.once('close', (code, signal) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer);
      const result = { code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
      if (!allowCodes.includes(code)) {
        const error = errorWith(`${command} exited with code ${code}: ${result.stderr.trim() || result.stdout.trim()}`, 'EPROCESS', 409, result);
        Object.assign(error, result); reject(error); return;
      }
      resolve(result);
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        terminateProcessTree(child.pid, { forceAfterMs: 1000 }).catch(() => {});
        if (!settled) {
          settled = true;
          reject(errorWith(`${command} timed out after ${timeoutMs}ms`, 'ETIMEDOUT', 504));
        }
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function createDevelopmentSessionService({
  workspaceRoot,
  workspaceScope,
  sessionsDir,
  worktreesDir,
  defaultLeaseMs = 30 * 60 * 1000,
  lockTimeoutMs = 15_000,
  projectLockLeaseMs = 5 * 60_000,
  gitTimeoutMs = 60_000,
  maxDiffBytes = 2 * 1024 * 1024,
} = {}) {
  if (!workspaceRoot) throw new TypeError('workspaceRoot is required');
  const pathGuard = createWorkspacePathGuard(workspaceScope || { workspaceRoot });
  const root = pathGuard.defaultRoot;
  const sessionRoot = path.resolve(sessionsDir || path.join(root, '.agentport-sessions'));
  const worktreeRoot = path.resolve(worktreesDir || path.join(root, '.agentport-worktrees'));
  const locksDir = path.join(sessionRoot, '.locks');

  async function init() {
    await fs.mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(locksDir, { recursive: true, mode: 0o700 });
  }
  function sessionPath(id) { return path.join(sessionRoot, `${safeId(id, 'sessionId')}.json`); }
  async function writeMeta(meta) {
    meta.updatedAt = nowIso();
    await atomicWriteFile(sessionPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return meta;
  }
  async function readMeta(id) {
    try { return JSON.parse(await fs.readFile(sessionPath(id), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') throw errorWith(`Session '${id}' not found`, 'ENOENT', 404); throw error; }
  }
  const projectLocks = createProjectLockManager({ locksDir, lockTimeoutMs, lockLeaseMs: projectLockLeaseMs });
  async function withProjectLock(projectRoot, fn) {
    await init();
    return projectLocks.withLock(projectRoot, fn);
  }
  async function git(cwd, args, options = {}) { return run('git', args, { cwd, timeoutMs: options.timeoutMs || gitTimeoutMs, maxBytes: options.maxBytes || 4 * 1024 * 1024, allowCodes: options.allowCodes || [0], env: options.env }); }
  async function resolveRepository(projectRoot) {
    const resolved = await pathGuard.resolve(projectRoot, { mustExist: true });
    const top = (await git(resolved.realPath, ['rev-parse', '--show-toplevel'])).stdout.trim();
    const repoReal = await fs.realpath(top);
    const rootReal = await fs.realpath(root);
    if (!pathGuard.isWithin(repoReal, rootReal)) throw errorWith(`Git repository '${repoReal}' is outside workspace roots`, 'EWORKSPACE', 403);
    return repoReal;
  }
  async function rulePaths(worktreePath, rules) {
    const found = [];
    for (const rule of rules) {
      const candidate = path.resolve(worktreePath, rule);
      if (!isWithin(candidate, worktreePath)) continue;
      try { if ((await fs.stat(candidate)).isFile()) found.push(path.relative(worktreePath, candidate).replace(/\\/g, '/')); } catch {}
    }
    return found;
  }
  async function gitState(meta) {
    try {
      const [branch, head, status] = await Promise.all([
        git(meta.worktreePath, ['branch', '--show-current']),
        git(meta.worktreePath, ['rev-parse', '--short', 'HEAD']),
        git(meta.worktreePath, ['status', '--porcelain=v1', '--branch']),
      ]);
      const lines = status.stdout.split(/\r?\n/).filter(Boolean);
      return { exists: true, branch: branch.stdout.trim(), head: head.stdout.trim(), dirtyCount: lines.filter((line) => !line.startsWith('##')).length, status: status.stdout.trim() };
    } catch (error) {
      return { exists: false, branch: null, head: null, dirtyCount: null, status: '', error: error.message };
    }
  }
  async function create(input = {}) {
    await init();
    const projectRoot = String(input.projectRoot || '').trim();
    if (!projectRoot) throw errorWith('projectRoot is required', 'EINVAL', 400);
    const repoRoot = await resolveRepository(projectRoot);
    return withProjectLock(repoRoot, async () => {
      const id = input.sessionId ? safeId(input.sessionId, 'sessionId') : `ses-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      try { await fs.access(sessionPath(id)); throw errorWith(`Session '${id}' already exists`, 'ESESSION_EXISTS', 409); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const baseRef = String(input.baseRef || input.targetBranch || 'HEAD').trim();
      const baseCommit = (await git(repoRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`])).stdout.trim();
      const branch = String(input.branchName || `agentport/${slug(input.projectName || path.basename(repoRoot), 'project')}/${slug(input.agentId || 'agent', 'agent')}-${id.slice(-8)}`).trim();
      if (!/^[A-Za-z0-9._/-]{1,180}$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.startsWith('/')) throw errorWith('Invalid branchName', 'EINVAL', 400);
      const worktreePath = path.join(worktreeRoot, id);
      await fs.rm(worktreePath, { recursive: true, force: true });
      await git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseCommit]);
      const rules = normalizedRules(input.agentRules);
      const meta = {
        version: 1, id,
        projectName: String(input.projectName || path.basename(repoRoot)),
        projectRoot: repoRoot, repoRoot, worktreePath,
        baseRef, targetBranch: String(input.targetBranch || baseRef), baseCommit, branch,
        agentId: String(input.agentId || 'agent'), clientId: input.clientId || null,
        task: String(input.task || ''), status: 'active',
        commands: normalizedCommands(input.commands), agentRules: rules,
        rulesFound: await rulePaths(worktreePath, rules), jobs: [],
        createdAt: nowIso(), updatedAt: nowIso(), heartbeatAt: nowIso(),
        leaseExpiresAt: new Date(Date.now() + Math.max(Number(input.leaseMs || defaultLeaseMs), 60_000)).toISOString(),
      };
      try { await writeMeta(meta); return await status(id); }
      catch (error) {
        try { await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]); } catch {}
        try { await git(repoRoot, ['branch', '-D', branch]); } catch {}
        throw error;
      }
    });
  }
  async function status(id) {
    const meta = await readMeta(id);
    const gitInfo = await gitState(meta);
    return { ...meta, leaseActive: Date.parse(meta.leaseExpiresAt || 0) > Date.now(), leaseExpired: Date.parse(meta.leaseExpiresAt || 0) <= Date.now(), git: gitInfo };
  }
  async function list(options = {}) {
    await init();
    const names = (await fs.readdir(sessionRoot)).filter((name) => name.endsWith('.json'));
    const rows = [];
    for (const name of names) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(sessionRoot, name), 'utf8'));
        if (options.projectName && meta.projectName !== options.projectName) continue;
        if (options.status && meta.status !== options.status) continue;
        rows.push({ ...meta, leaseActive: Date.parse(meta.leaseExpiresAt || 0) > Date.now() });
      } catch {}
    }
    rows.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    return rows.slice(0, Math.min(Math.max(Number(options.limit || 100), 1), 500));
  }
  async function heartbeat(id, input = {}) {
    const meta = await readMeta(id);
    if (input.agentId && meta.agentId && input.agentId !== meta.agentId) throw errorWith('agentId does not own this session', 'ESESSION_OWNER', 403);
    meta.heartbeatAt = nowIso();
    meta.leaseExpiresAt = new Date(Date.now() + Math.max(Number(input.leaseMs || defaultLeaseMs), 60_000)).toISOString();
    await writeMeta(meta); return status(id);
  }
  async function attachJob(id, job) {
    const meta = await readMeta(id);
    meta.jobs ||= [];
    if (!meta.jobs.some((item) => item.jobId === job.jobId)) meta.jobs.push({ jobId: job.jobId, action: job.action || null, commandPreview: String(job.command || '').slice(0, 300), createdAt: nowIso() });
    await writeMeta(meta); return meta;
  }
  async function diff(id, options = {}) {
    const meta = await readMeta(id); const maxBytes = Math.min(Math.max(Number(options.maxBytes || maxDiffBytes), 1024), 20 * 1024 * 1024);
    const [statusOut, statOut, workOut, stagedOut] = await Promise.all([
      git(meta.worktreePath, ['status', '--short', '--branch'], { maxBytes }),
      git(meta.worktreePath, ['diff', '--stat', '--no-ext-diff'], { maxBytes }),
      git(meta.worktreePath, ['diff', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'], { maxBytes }),
      git(meta.worktreePath, ['diff', '--cached', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'], { maxBytes }),
    ]);
    const combined = truncate(workOut.stdout, maxBytes);
    const staged = truncate(stagedOut.stdout, maxBytes);
    return { sessionId: id, branch: meta.branch, status: statusOut.stdout, stat: statOut.stdout, diff: combined.content, stagedDiff: staged.content, truncated: combined.truncated || staged.truncated, totalBytes: combined.bytes + staged.bytes };
  }
  async function commit(id, input = {}) {
    const meta = await readMeta(id); const message = String(input.message || '').trim();
    if (!message || message.length > 500) throw errorWith('commit message is required and must be <= 500 characters', 'EINVAL', 400);
    const dirty = (await git(meta.worktreePath, ['status', '--porcelain'])).stdout.trim();
    if (!dirty) return { sessionId: id, noChanges: true, branch: meta.branch, head: (await git(meta.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() };
    if (input.addAll !== false) await git(meta.worktreePath, ['add', '-A']);
    const env = {};
    if (input.authorName) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = String(input.authorName);
    if (input.authorEmail) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = String(input.authorEmail);
    await git(meta.worktreePath, ['commit', '-m', message], { env, timeoutMs: 120_000 });
    meta.lastCommit = (await git(meta.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim(); meta.lastCommitAt = nowIso();
    await writeMeta(meta); return { sessionId: id, committed: true, commit: meta.lastCommit, branch: meta.branch };
  }
  async function rollback(id, input = {}) {
    const meta = await readMeta(id);
    if (String(input.confirm || '') !== id) throw errorWith(`rollback requires confirm='${id}'`, 'ECONFIRM', 409);
    const mode = String(input.mode || 'working-tree');
    const target = mode === 'base' ? meta.baseCommit : 'HEAD';
    await git(meta.worktreePath, ['reset', '--hard', target]);
    await git(meta.worktreePath, ['clean', '-fd']);
    meta.lastRollbackAt = nowIso(); meta.lastRollbackMode = mode; await writeMeta(meta);
    return { sessionId: id, rolledBack: true, mode, target, git: await gitState(meta) };
  }
  async function merge(id, input = {}) {
    const meta = await readMeta(id);
    if (String(input.confirm || '') !== id) throw errorWith(`merge requires confirm='${id}'`, 'ECONFIRM', 409);
    const sessionDirty = (await git(meta.worktreePath, ['status', '--porcelain'])).stdout.trim();
    if (sessionDirty) throw errorWith('Session worktree has uncommitted changes', 'ESESSION_DIRTY', 409);
    const targetBranch = String(input.targetBranch || meta.targetBranch || meta.baseRef).trim();
    return withProjectLock(meta.repoRoot, async () => {
      const mainDirty = (await git(meta.repoRoot, ['status', '--porcelain'])).stdout.trim();
      if (mainDirty) throw errorWith('Primary project worktree is dirty', 'EPROJECT_DIRTY', 409);
      const current = (await git(meta.repoRoot, ['branch', '--show-current'])).stdout.trim();
      if (current !== targetBranch) throw errorWith(`Primary project worktree must be on '${targetBranch}', currently '${current || '(detached)'}'`, 'ETARGET_BRANCH', 409);
      const strategy = String(input.strategy || 'no-ff');
      const args = strategy === 'ff-only'
        ? ['merge', '--ff-only', meta.branch]
        : ['merge', '--no-ff', meta.branch, '-m', String(input.message || `Merge ${meta.branch}`)];
      try { await git(meta.repoRoot, args, { timeoutMs: 180_000 }); }
      catch (error) { try { await git(meta.repoRoot, ['merge', '--abort']); } catch {} throw error; }
      meta.status = 'merged'; meta.mergedAt = nowIso(); meta.mergedInto = targetBranch; meta.mergeCommit = (await git(meta.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
      await writeMeta(meta); return { sessionId: id, merged: true, targetBranch, commit: meta.mergeCommit, strategy };
    });
  }
  async function cleanup(id, input = {}) {
    const meta = await readMeta(id); const force = Boolean(input.force); const deleteBranch = Boolean(input.deleteBranch);
    if ((force || deleteBranch) && String(input.confirm || '') !== id) throw errorWith(`cleanup requires confirm='${id}' when force or deleteBranch is used`, 'ECONFIRM', 409);
    return withProjectLock(meta.repoRoot, async () => {
      const args = ['worktree', 'remove']; if (force) args.push('--force'); args.push(meta.worktreePath);
      try { await git(meta.repoRoot, args); }
      catch (error) { if (!force) throw error; await fs.rm(meta.worktreePath, { recursive: true, force: true }); }
      try { await git(meta.repoRoot, ['worktree', 'prune']); } catch {}
      let branchDeleted = false;
      if (deleteBranch) {
        await git(meta.repoRoot, ['branch', force ? '-D' : '-d', meta.branch]); branchDeleted = true;
      }
      meta.status = 'closed'; meta.closedAt = nowIso(); meta.branchDeleted = branchDeleted; await writeMeta(meta);
      return { sessionId: id, cleaned: true, worktreePath: meta.worktreePath, branch: meta.branch, branchDeleted };
    });
  }
  async function stats() {
    const sessions = await list({ limit: 500 });
    return { total: sessions.length, active: sessions.filter((item) => item.status === 'active').length, merged: sessions.filter((item) => item.status === 'merged').length, closed: sessions.filter((item) => item.status === 'closed').length, leaseActive: sessions.filter((item) => item.leaseActive).length, sessionsDir: sessionRoot, worktreesDir: worktreeRoot, projectLockLeaseMs: projectLocks.leaseMs };
  }

  return Object.freeze({ init, create, status, list, heartbeat, attachJob, diff, commit, rollback, merge, cleanup, stats });
}

module.exports = { createDevelopmentSessionService };
