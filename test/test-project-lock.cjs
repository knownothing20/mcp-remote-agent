const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProjectLockManager } = require('../packages/daemon-core/project-lock.cjs');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
async function waitUntil(timestampMs) {
  while (Date.now() <= timestampMs) {
    await sleep(Math.min(25, Math.max(1, timestampMs - Date.now() + 1)));
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentport-project-lock-'));
  const locksDir = path.join(root, 'locks');
  const project = path.join(root, 'repo');
  const initializingProject = path.join(root, 'initializing-repo');
  const stressProject = path.join(root, 'stress-repo');
  const deadProject = path.join(root, 'dead-repo');
  await Promise.all([
    fs.mkdir(project),
    fs.mkdir(initializingProject),
    fs.mkdir(stressProject),
    fs.mkdir(deadProject),
  ]);

  try {
    const manager = createProjectLockManager({
      locksDir,
      lockTimeoutMs: 200,
      lockLeaseMs: 1000,
      lockRetryMs: 5,
    });
    const entered = deferred();
    const release = deferred();
    const first = manager.withLock(project, async () => {
      entered.resolve();
      await release.promise;
      return 'first';
    });
    await entered.promise;

    const liveLockPath = manager.lockPathFor(project);
    const liveLock = JSON.parse(await fs.readFile(liveLockPath, 'utf8'));
    const expiresAtMs = Date.parse(liveLock.expiresAt);
    assert.ok(Number.isFinite(expiresAtMs), 'lock metadata must include a valid expiresAt');
    await waitUntil(expiresAtMs + 25);

    try {
      await assert.rejects(
        () => manager.withLock(project, async () => 'stolen'),
        (error) => error?.code === 'EPROJECT_LOCKED',
      );
    } finally {
      release.resolve();
    }
    assert.equal(await first, 'first');
    assert.equal(await manager.withLock(project, async () => 'after-release'), 'after-release');

    const initializingManager = createProjectLockManager({
      locksDir,
      lockTimeoutMs: 150,
      lockInitializationGraceMs: 1000,
      lockRetryMs: 5,
    });
    const initializingLockPath = initializingManager.lockPathFor(initializingProject);
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(initializingLockPath, '');
    await assert.rejects(
      () => initializingManager.withLock(initializingProject, async () => 'must-not-enter'),
      (error) => error?.code === 'EPROJECT_LOCKED' && error?.details?.initializing === true,
    );
    assert.equal((await fs.stat(initializingLockPath)).size, 0, 'fresh empty lock must not be deleted');
    await fs.rm(initializingLockPath, { force: true });

    const stressA = createProjectLockManager({
      locksDir,
      lockTimeoutMs: 2000,
      lockInitializationGraceMs: 1000,
      lockRetryMs: 1,
    });
    const stressB = createProjectLockManager({
      locksDir,
      lockTimeoutMs: 2000,
      lockInitializationGraceMs: 1000,
      lockRetryMs: 1,
    });
    let active = 0;
    let overlapViolations = 0;
    async function critical() {
      active += 1;
      if (active > 1) overlapViolations += 1;
      await sleep(0);
      active -= 1;
    }
    for (let index = 0; index < 1000; index += 1) {
      await Promise.all([
        stressA.withLock(stressProject, critical),
        stressB.withLock(stressProject, critical),
      ]);
    }
    assert.equal(overlapViolations, 0, 'two contenders must never enter the critical section together');

    const deadManager = createProjectLockManager({ locksDir, lockTimeoutMs: 500, lockRetryMs: 5 });
    const deadLockPath = deadManager.lockPathFor(deadProject);
    await fs.writeFile(deadLockPath, JSON.stringify({
      ownerId: 'dead',
      pid: 99999999,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    assert.equal(await deadManager.withLock(deadProject, async () => 'recovered'), 'recovered');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('PASS deterministic expired-live-lock gate, atomic initialization, 1000-round contention, and dead-owner recovery');
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
