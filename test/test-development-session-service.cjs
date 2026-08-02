const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDevelopmentSessionService } = require('../packages/daemon-core/development-session-service.cjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function normalizeEol(value) {
  return String(value).replace(/\r\n/g, '\n');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-session-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'AgentPort Test']);
  git(repo, ['config', 'user.email', 'agentport@example.com']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
  await fs.writeFile(path.join(repo, 'AGENTS.md'), 'rules\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);

  const service = createDevelopmentSessionService({
    workspaceRoot: root,
    sessionsDir: path.join(root, '.sessions'),
    worktreesDir: path.join(root, '.worktrees'),
    defaultLeaseMs: 60_000,
  });

  try {
    const session = await service.create({
      projectRoot: repo,
      projectName: 'demo',
      agentId: 'codex',
      task: 'edit readme',
      baseRef: 'main',
      targetBranch: 'main',
      commands: { test: 'node -e "console.log(1)"' },
      agentRules: ['AGENTS.md'],
    });
    assert.equal(session.status, 'active');
    assert.equal(session.rulesFound[0], 'AGENTS.md');
    assert.equal(session.git.branch, session.branch);
    assert.equal(git(repo, ['branch', '--show-current']), 'main');

    await fs.writeFile(path.join(session.worktreePath, 'README.md'), 'changed\n');
    // Repeated fast Git reads guard against resolving on child exit before pipes close.
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const diff = await service.diff(session.id);
      assert.match(normalizeEol(diff.diff), /changed/, `fast diff iteration ${iteration + 1} returned incomplete stdout`);
      assert.match(normalizeEol(diff.status), /README\.md/, `fast status iteration ${iteration + 1} returned incomplete stdout`);
    }

    await assert.rejects(
      () => service.rollback(session.id, { confirm: 'wrong' }),
      (error) => error?.code === 'ECONFIRM',
    );

    const committed = await service.commit(session.id, {
      message: 'change readme',
      authorName: 'AgentPort Test',
      authorEmail: 'agentport@example.com',
    });
    assert.equal(committed.committed, true);

    await fs.writeFile(path.join(repo, 'dirty.txt'), 'dirty');
    await assert.rejects(
      () => service.merge(session.id, { confirm: session.id, targetBranch: 'main' }),
      (error) => error?.code === 'EPROJECT_DIRTY',
    );
    await fs.rm(path.join(repo, 'dirty.txt'));

    const merged = await service.merge(session.id, { confirm: session.id, targetBranch: 'main' });
    assert.equal(merged.merged, true);
    assert.equal(normalizeEol(await fs.readFile(path.join(repo, 'README.md'), 'utf8')), 'changed\n');

    const cleaned = await service.cleanup(session.id, { deleteBranch: true, confirm: session.id });
    assert.equal(cleaned.cleaned, true);
    assert.equal(cleaned.branchDeleted, true);
    const closed = await service.status(session.id);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.git.exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('PASS development session Worktree, 50 fast diff/status reads, commit, merge, confirmation, and cleanup');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
