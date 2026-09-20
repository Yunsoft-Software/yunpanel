import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createResticRepositoryRegistry,
  ResticRepositoryRegistryError,
} from '../src/restic-repository-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const repoId = '0bb78242-03a6-429f-9d17-7725c521437c';

function mockResticManager() {
  const calls = [];
  return {
    calls,
    init: async (opts) => {
      calls.push({ method: 'init', opts });
      return { repository: opts.repository, id: 'repo-init-id', initializedAt: '2026-09-20T10:00:00.000Z' };
    },
    check: async (opts) => {
      calls.push({ method: 'check', opts });
      return { healthy: true, output: 'ok', checkedAt: '2026-09-20T10:01:00.000Z' };
    },
    unlock: async (opts) => {
      calls.push({ method: 'unlock', opts });
      return { unlocked: true, unlockedAt: '2026-09-20T10:02:00.000Z' };
    },
    createSnapshot: async (opts) => {
      calls.push({ method: 'createSnapshot', opts });
      return {
        snapshotId: 'snap12345678',
        shortId: 'snap1234',
        filesNew: 10,
        bytesAdded: 2048,
        createdAt: '2026-09-20T10:05:00.000Z',
      };
    },
    listSnapshots: async (opts) => {
      calls.push({ method: 'listSnapshots', opts });
      return [{ id: 'snap12345678', shortId: 'snap1234', paths: ['/data'] }];
    },
    forget: async (opts) => {
      calls.push({ method: 'forget', opts });
      return { keptSnapshots: ['snap12345678'], removedSnapshots: [], pruned: opts.prune };
    },
    prune: async (opts) => {
      calls.push({ method: 'prune', opts });
      return { bytesFreed: 1024, packsRemoved: 1 };
    },
    restore: async (opts) => {
      calls.push({ method: 'restore', opts });
      return { snapshotId: opts.snapshotId, targetDirectory: opts.targetDirectory };
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-restic-repo-'));
  const filePath = path.join(root, 'repositories.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const masterKey = randomBytes(32);
  const manager = mockResticManager();
  const registry = createResticRepositoryRegistry({
    filePath,
    localRepoBase: path.join(root, 'repos'),
    masterKey,
    serverExists: async (id) => id === serverId,
    resticManager: manager,
    now: () => Date.parse('2026-09-20T10:00:00.000Z'),
  });
  await registry.init();
  return { filePath, masterKey, registry, manager, root };
}

test('createRepository stores encrypted password and returns public view', async (t) => {
  const { registry } = await fixture(t);

  const repo = await registry.createRepository({
    repositoryId: repoId,
    serverId,
    name: 'primary_backup',
    backend: 'local',
    password: 'super-secret-password-123',
    retentionPolicy: {
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 12,
    },
  });

  assert.equal(repo.id, repoId);
  assert.equal(repo.serverId, serverId);
  assert.equal(repo.name, 'primary_backup');
  assert.equal(repo.backend, 'local');
  assert.ok(repo.target.includes(repoId));
  assert.equal(repo.status, 'uninitialized');
  assert.deepEqual(repo.retentionPolicy, { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 });
  assert.equal(repo.encryptedPassword, undefined); // Never exposed in public view

  // Password decryption
  const password = registry.revealPassword(repoId);
  assert.equal(password, 'super-secret-password-123');
});

test('createRepository rejects invalid inputs', async (t) => {
  const { registry } = await fixture(t);

  // Short password (< 8 chars)
  await assert.rejects(
    registry.createRepository({ serverId, name: 'repo1', password: 'short' }),
    (err) => err instanceof ResticRepositoryRegistryError && err.code === 'restic_password_invalid',
  );

  // Invalid backend
  await assert.rejects(
    registry.createRepository({ serverId, name: 'repo1', password: 'valid-password-123', backend: 's3_custom' }),
    (err) => err instanceof ResticRepositoryRegistryError && err.code === 'restic_backend_invalid',
  );

  // Invalid server
  await assert.rejects(
    registry.createRepository({ serverId: '00000000-0000-4000-8000-000000000000', name: 'repo1', password: 'valid-password-123' }),
    (err) => err instanceof ResticRepositoryRegistryError && err.code === 'server_not_found' && err.status === 404,
  );
});

test('duplicate repository name on same server is rejected', async (t) => {
  const { registry } = await fixture(t);

  await registry.createRepository({
    serverId,
    name: 'daily_repo',
    password: 'valid-password-123',
  });

  await assert.rejects(
    registry.createRepository({ serverId, name: 'daily_repo', password: 'valid-password-456' }),
    (err) => err instanceof ResticRepositoryRegistryError && err.code === 'restic_repository_name_conflict' && err.status === 409,
  );
});

test('updateRepository updates name and retention policy', async (t) => {
  const { registry } = await fixture(t);

  const repo = await registry.createRepository({
    repositoryId: repoId,
    serverId,
    name: 'initial_name',
    password: 'valid-password-123',
  });

  const updated = await registry.updateRepository(repoId, {
    name: 'renamed_repo',
    retentionPolicy: { keepDaily: 14 },
  });

  assert.equal(updated.name, 'renamed_repo');
  assert.deepEqual(updated.retentionPolicy, { keepDaily: 14 });
});

test('deleteRepository removes repository from registry', async (t) => {
  const { registry } = await fixture(t);

  await registry.createRepository({
    repositoryId: repoId,
    serverId,
    name: 'to_delete',
    password: 'valid-password-123',
  });

  const success = await registry.deleteRepository(repoId);
  assert.equal(success, true);

  const lookup = await registry.getRepository(repoId);
  assert.equal(lookup, null);
});

test('restic lifecycle wrappers delegate to resticManager with revealed password', async (t) => {
  const { registry, manager } = await fixture(t);

  await registry.createRepository({
    repositoryId: repoId,
    serverId,
    name: 'managed_repo',
    password: 'decrypted-password-999',
    retentionPolicy: { keepDaily: 7 },
  });

  // 1. init
  const initResult = await registry.initResticRepository(repoId);
  assert.equal(initResult.status, 'ready');
  assert.equal(manager.calls[0].method, 'init');
  assert.equal(manager.calls[0].opts.password, 'decrypted-password-999');

  const afterInit = await registry.getRepository(repoId);
  assert.equal(afterInit.status, 'ready');

  // 2. check
  const checkResult = await registry.checkResticRepository(repoId, { readDataSubset: '5%' });
  assert.equal(checkResult.healthy, true);
  assert.equal(manager.calls[1].method, 'check');
  assert.equal(manager.calls[1].opts.readDataSubset, '5%');

  // 3. unlock
  const unlockResult = await registry.unlockResticRepository(repoId, { removeAll: true });
  assert.equal(unlockResult.unlocked, true);
  assert.equal(manager.calls[2].method, 'unlock');

  // 4. createSnapshot
  const snapResult = await registry.createSnapshot(repoId, { paths: ['/var/www/site'] });
  assert.equal(snapResult.snapshotId, 'snap12345678');
  assert.equal(manager.calls[3].method, 'createSnapshot');
  assert.deepEqual(manager.calls[3].opts.paths, ['/var/www/site']);

  const afterSnap = await registry.getRepository(repoId);
  assert.equal(afterSnap.lastSnapshotAt, '2026-09-20T10:05:00.000Z');

  // 5. listSnapshots
  const listResult = await registry.listSnapshots(repoId);
  assert.equal(listResult.length, 1);
  assert.equal(manager.calls[4].method, 'listSnapshots');

  // 6. applyRetention
  const retResult = await registry.applyRetention(repoId, { prune: true });
  assert.equal(retResult.pruned, true);
  assert.equal(manager.calls[5].method, 'forget');
  assert.deepEqual(manager.calls[5].opts.policy, { keepDaily: 7 });

  // 7. prune
  const pruneResult = await registry.pruneResticRepository(repoId);
  assert.equal(pruneResult.bytesFreed, 1024);
  assert.equal(manager.calls[6].method, 'prune');

  // 8. restore
  const restoreResult = await registry.restoreSnapshot(repoId, {
    snapshotId: 'snap12345678',
    targetDirectory: '/tmp/restored',
  });
  assert.equal(restoreResult.snapshotId, 'snap12345678');
  assert.equal(manager.calls[7].method, 'restore');
});

test('persisted repositories and encrypted passwords survive reload', async (t) => {
  const { filePath, masterKey, registry, root } = await fixture(t);

  await registry.createRepository({
    repositoryId: repoId,
    serverId,
    name: 'persistent_repo',
    password: 'persistent-password-secret',
  });

  // Re-create registry with same file and masterKey
  const newRegistry = createResticRepositoryRegistry({
    filePath,
    localRepoBase: path.join(root, 'repos'),
    masterKey,
    serverExists: async (id) => id === serverId,
  });
  await newRegistry.init();

  const loaded = await newRegistry.getRepository(repoId);
  assert.ok(loaded);
  assert.equal(loaded.name, 'persistent_repo');

  const revealed = newRegistry.revealPassword(repoId);
  assert.equal(revealed, 'persistent-password-secret');
});
