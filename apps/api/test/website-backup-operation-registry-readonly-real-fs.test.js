import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, chmodSync, linkSync, renameSync, symlinkSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, link, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { createWebsiteBackupOperationRegistry } from '../src/website-backup-operation-registry.js';
import { createWebsiteBackupOperationService } from '../src/website-backup-operation-service.js';
import { createJobRegistry } from '../src/job-registry.js';

async function ownDirectory(action) {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'yunpanel-backup-readonly-real-fs-'));
  await chmod(directory, 0o700);
  let passed = false;
  try {
    const result = await action(directory);
    passed = true;
    return result;
  } finally {
    // Preserve the actual failed store. Only successful, exact owned temporary trees are removed.
    if (passed) {
      const metadata = await lstat(directory);
      assert.equal(path.dirname(directory), parent);
      assert.ok(path.basename(directory).startsWith('yunpanel-backup-readonly-real-fs-'));
      assert.equal(await realpath(directory), directory);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.uid, process.getuid());
      assert.equal(metadata.mode & 0o777, 0o700);
      await rm(directory, { recursive: true });
    }
  }
}

async function fixture(directory, populated = false) {
  const filePath = path.join(directory, 'website-backup-operations.json');
  const registry = createWebsiteBackupOperationRegistry({ filePath });
  let operation = null;
  if (populated) operation = await registry.createOperation({ websiteId: randomUUID(), serverId: randomUUID(), repositoryId: randomUUID(), kind: 'check' });
  else assert.deepEqual(await registry.listOperations(), []);
  return { registry, service: createWebsiteBackupOperationService({ registry }), filePath, operation };
}

async function unchangedStore(filePath, action) {
  // Hold the old inode open so an atomic replacement cannot hide behind inode reuse.
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const bytesBefore = await handle.readFile();
    assert.equal(before.isFile(), true);
    assert.equal(before.nlink, 1);
    assert.equal(before.mode & 0o777, 0o600);
    const result = await action();
    const after = await lstat(filePath);
    assert.equal(after.isFile(), true);
    assert.equal(after.isSymbolicLink(), false);
    assert.equal(after.nlink, 1);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.deepEqual(await readFile(filePath), bytesBefore, 'read must preserve actual persisted bytes');
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino, 'read must preserve actual persisted inode');
    assert.equal((await handle.stat()).nlink, 1);
    return result;
  } finally { await handle.close(); }
}

async function readCase(action, populated = false) {
  return ownDirectory(async directory => {
    const f = await fixture(directory, populated);
    await unchangedStore(f.filePath, () => action(f));
  });
}

test('real FS empty operation list does not replace an existing store', () => readCase(async ({ registry }) => {
  assert.deepEqual(await registry.listOperations(), []);
}));
test('real FS missing public operation get does not replace an existing store', () => readCase(async ({ registry }) => {
  assert.equal(await registry.getOperation(randomUUID()), null);
}));
test('real FS missing worker execution get does not replace an existing store', () => readCase(async ({ registry }) => {
  assert.equal(await registry.getExecutionOperation(randomUUID()), null);
}));
test('real service list does not replace an existing operation store', () => readCase(async ({ service }) => {
  assert.deepEqual(await service.listOperations(), []);
}));
test('real service missing operation get returns404 without replacing the store', () => readCase(async ({ service }) => {
  await assert.rejects(() => service.getOperation(randomUUID()), error => error.code === 'website_backup_operation_not_found' && error.status === 404);
}));
test('real empty reconciliation does not replace the operation store', () => readCase(async ({ service }) => {
  assert.deepEqual(await service.reconcile(), []);
}));
test('real queued check list preserves persisted record and inode', () => readCase(async ({ registry, operation }) => {
  const rows = await registry.listOperations({ websiteId: operation.websiteId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, operation.id);
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].result, null);
}, true));
test('real queued check get preserves persisted record and inode', () => readCase(async ({ registry, operation }) => {
  const row = await registry.getOperation(operation.id);
  assert.equal(row.id, operation.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.result, null);
}, true));

test('missing operation store is still materialized with the real canonical empty state', () => ownDirectory(async directory => {
  const filePath = path.join(directory, 'website-backup-operations.json');
  const registry = createWebsiteBackupOperationRegistry({ filePath });
  await assert.rejects(() => lstat(filePath), { code: 'ENOENT' });
  assert.deepEqual(await registry.listOperations(), []);
  assert.equal(await readFile(filePath, 'utf8'), JSON.stringify({ version: 1, operations: [] }, null, 2));
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
}));

test('real create still persists its queued record and replaces the changed store', () => ownDirectory(async directory => {
  const f = await fixture(directory);
  const handle = await open(f.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const operation = await f.registry.createOperation({ websiteId: randomUUID(), repositoryId: randomUUID(), kind: 'check' });
    const stored = JSON.parse(await readFile(f.filePath, 'utf8'));
    assert.equal(stored.operations.length, 1);
    assert.equal(stored.operations[0].id, operation.id);
    assert.equal(stored.operations[0].status, 'queued');
    assert.equal(stored.operations[0].result, null);
    assert.notEqual((await stat(f.filePath)).ino, before.ino);
  } finally { await handle.close(); }
}));

test('existing serialization normalization still persists, then later byte-identical reads stop writing', () => ownDirectory(async directory => {
  const f = await fixture(directory, true);
  const original = JSON.parse(await readFile(f.filePath, 'utf8'));
  // Re-encode only this actual registry-created record; no synthetic operation or success state.
  await writeFile(f.filePath, JSON.stringify(original), { mode: 0o600 });
  const handle = await open(f.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const read = await f.registry.getOperation(f.operation.id);
    assert.equal(read.id, f.operation.id);
    assert.equal(await readFile(f.filePath, 'utf8'), JSON.stringify(original, null, 2));
    assert.notEqual((await stat(f.filePath)).ino, before.ino);
  } finally { await handle.close(); }
  await unchangedStore(f.filePath, () => f.registry.getOperation(f.operation.id));
}));

test('byte equality does not confuse lossy UTF8 decoding with unchanged persisted bytes', () => ownDirectory(async directory => {
  const f = await fixture(directory, true);
  const encoded = await readFile(f.filePath);
  const prefix = Buffer.from('"confirmation": "');
  const position = encoded.indexOf(prefix) + prefix.length;
  assert.ok(position >= prefix.length);
  assert.equal(encoded[position], 'c'.charCodeAt(0));
  // Corrupt only an actual queued record's string encoding in this owned local input.
  encoded[position] = 0xff;
  await writeFile(f.filePath, encoded);
  const expected = Buffer.from(JSON.stringify(JSON.parse(encoded.toString('utf8')), null, 2));
  assert.equal(encoded.equals(expected), false);
  const operation = await f.registry.getOperation(f.operation.id);
  assert.equal(operation.id, f.operation.id);
  assert.equal(operation.status, 'queued');
  assert.deepEqual(await readFile(f.filePath), expected, 'the existing serializer normalization must still persist different bytes');
  await unchangedStore(f.filePath, () => f.registry.getOperation(f.operation.id));
}));

async function linkedQueuedJob(directory) {
  const f = await fixture(directory, true);
  const jobRegistry = createJobRegistry({ filePath: path.join(directory, 'jobs.json') });
  const job = await jobRegistry.enqueue({ serverId: f.operation.serverId, type: 'website.backup.check', operation: OPERATIONS.WEBSITE_BACKUP_ACTION,
    payload: { operationId: f.operation.id, websiteId: f.operation.websiteId, actorSessionId: randomUUID(), actorUserId: randomUUID(), actorRole: 'owner' }, resourceType: 'backup', resourceId: f.operation.id });
  assert.equal(job.status, 'queued');
  await f.registry.updateOperation(f.operation.id, { jobId: job.id });
  return { ...f, jobRegistry, job };
}

test('real queued durable job reconciliation is a no-op and preserves operation inode', () => ownDirectory(async directory => {
  const f = await linkedQueuedJob(directory);
  await unchangedStore(f.filePath, async () => {
    assert.deepEqual(await f.registry.reconcileInterruptedOperations({ jobRegistry: f.jobRegistry }), []);
  });
  assert.equal((await f.jobRegistry.getJob(f.job.id)).status, 'queued');
}));

test('real cancelled durable job still causes the service to persist its failed operation', () => ownDirectory(async directory => {
  const f = await linkedQueuedJob(directory);
  const cancelled = await f.jobRegistry.cancel(f.job.id);
  assert.equal(cancelled.status, 'cancelled');
  const service = createWebsiteBackupOperationService({ registry: f.registry, jobRegistry: f.jobRegistry });
  const handle = await open(f.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const operation = await service.getOperation(f.operation.id);
    assert.equal(operation.status, 'failed');
    assert.equal(operation.error.code, 'website_backup_job_cancelled');
    assert.equal(operation.jobId, f.job.id);
    const stored = JSON.parse(await readFile(f.filePath, 'utf8')).operations[0];
    assert.equal(stored.status, 'failed');
    assert.equal(stored.error.code, 'website_backup_job_cancelled');
    assert.notEqual((await stat(f.filePath)).ino, before.ino);
  } finally { await handle.close(); }
}));

test('two actual registry instances serialize writes and reload external changes under their default process lock', () => ownDirectory(async directory => {
  const f = await fixture(directory);
  const other = createWebsiteBackupOperationRegistry({ filePath: f.filePath });
  const created = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? f.registry : other).createOperation({
    websiteId: randomUUID(), repositoryId: randomUUID(), kind: 'check',
  })));
  const ids = new Set(created.map(operation => operation.id));
  assert.equal(ids.size, 8);
  for (const registry of [f.registry, other]) {
    const rows = await registry.listOperations();
    assert.equal(rows.length, 8);
    assert.deepEqual(new Set(rows.map(operation => operation.id)), ids);
    assert.ok(rows.every(operation => operation.status === 'queued' && operation.result === null));
  }
  assert.equal(JSON.parse(await readFile(f.filePath, 'utf8')).operations.length, 8);
  await assert.rejects(() => lstat(f.filePath + '.lock'), { code: 'ENOENT' });
}));

test('a previously initialized instance still recreates missing store without retaining deleted local records', () => ownDirectory(async directory => {
  const f = await fixture(directory, true);
  await unlink(f.filePath);
  assert.deepEqual(await f.registry.listOperations(), []);
  assert.deepEqual(JSON.parse(await readFile(f.filePath, 'utf8')), { version: 1, operations: [] });
}));

test('actual malformed local store still fails closed without overwriting the invalid bytes', () => ownDirectory(async directory => {
  const f = await fixture(directory);
  await writeFile(f.filePath, '{', { mode: 0o600 });
  const handle = await open(f.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    await assert.rejects(() => f.registry.listOperations(), error => error.code === 'website_backup_operation_store_invalid' && error.status === 500);
    assert.equal(await readFile(f.filePath, 'utf8'), '{');
    assert.equal((await stat(f.filePath)).ino, before.ino);
  } finally { await handle.close(); }
}));


async function assertPrivateSingleLinkStore(filePath, expectedOperationId, registry, filter = {}) {
  const rows = await registry.listOperations(filter);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, expectedOperationId);
  const after = await lstat(filePath);
  assert.equal(after.isFile(), true, 'the target must end as the original regular-file write result');
  assert.equal(after.isSymbolicLink(), false, 'a symlink cannot receive no-op authority');
  assert.equal(after.mode & 0o7777, 0o600, 'private store mode must be retained or repaired');
  assert.equal(after.nlink, 1, 'the target must end as a single-link file');
  assert.equal(after.uid, process.getuid());
}

for (const condition of ['mode0644', 'symlink', 'hardlink']) {
  test('real existing ' + condition + ' metadata still uses the original private atomic replacement', () => ownDirectory(async directory => {
    const f = await fixture(directory, true);
    const originalBytes = await readFile(f.filePath);
    let target = f.filePath;
    if (condition === 'mode0644') await chmod(f.filePath, 0o644);
    if (condition === 'symlink') {
      target = path.join(directory, 'actual-store-target.json');
      await rename(f.filePath, target);
      await symlink(path.basename(target), f.filePath);
    }
    if (condition === 'hardlink') await link(f.filePath, path.join(directory, 'actual-store-alias.json'));
    const held = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await held.stat();
      await assertPrivateSingleLinkStore(f.filePath, f.operation.id, f.registry);
      assert.deepEqual(await readFile(f.filePath), originalBytes);
      assert.notEqual((await stat(f.filePath)).ino, before.ino, 'unsafe metadata must not silently skip atomic replacement');
    } finally { await held.close(); }
    await unchangedStore(f.filePath, () => f.registry.getOperation(f.operation.id));
  }));
}

for (const condition of ['mode0644', 'symlink', 'hardlink']) {
  test('real ' + condition + ' drift after load is rechecked before granting no-op authority', () => ownDirectory(async directory => {
    const f = await fixture(directory, true);
    const bytes = await readFile(f.filePath);
    const held = await open(f.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let called = false;
    const filter = {
      websiteId: {
        // The real registry evaluates this filter after loading and before save.
        // Use actual owned FS effects here; no fs method, stat result or HTTP is replaced.
        toLowerCase() {
          assert.equal(called, false);
          called = true;
          if (condition === 'mode0644') chmodSync(f.filePath, 0o644);
          if (condition === 'symlink') {
            const target = path.join(directory, 'actual-drift-target.json');
            renameSync(f.filePath, target);
            symlinkSync(path.basename(target), f.filePath);
          }
          if (condition === 'hardlink') linkSync(f.filePath, path.join(directory, 'actual-drift-alias.json'));
          return f.operation.websiteId;
        },
      },
    };
    try {
      const before = await held.stat();
      await assertPrivateSingleLinkStore(f.filePath, f.operation.id, f.registry, filter);
      assert.equal(called, true);
      assert.deepEqual(await readFile(f.filePath), bytes);
      assert.notEqual((await stat(f.filePath)).ino, before.ino, 'fresh path/FD drift cannot silently skip the original write');
    } finally { await held.close(); }
    await unchangedStore(f.filePath, () => f.registry.getOperation(f.operation.id));
  }));
}

test('real repeated safe reads close every loaded store descriptor', () => ownDirectory(async directory => {
  const f = await fixture(directory, true);
  const fdDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  for (let index = 0; index < 4; index += 1) await f.registry.getOperation(f.operation.id);
  const before = (await readdir(fdDirectory)).length;
  await unchangedStore(f.filePath, async () => {
    for (let index = 0; index < 64; index += 1) assert.equal((await f.registry.getOperation(f.operation.id)).id, f.operation.id);
  });
  const after = (await readdir(fdDirectory)).length;
  assert.ok(after <= before, 'loaded-FD lifetime must not leak across successful transactions');
}));


test('real malformed load errors close the descriptor on every rejected read', () => ownDirectory(async directory => {
  const f = await fixture(directory);
  await writeFile(f.filePath, '{', { mode: 0o600 });
  const fdDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const before = (await readdir(fdDirectory)).length;
  for (let index = 0; index < 16; index += 1) {
    await assert.rejects(() => f.registry.listOperations(), error => error.code === 'website_backup_operation_store_invalid' && error.status === 500);
  }
  assert.ok((await readdir(fdDirectory)).length <= before, 'failed load must close the actual opened descriptor');
  assert.equal(await readFile(f.filePath, 'utf8'), '{');
}));

test('real active-operation conflicts close the loaded descriptor without replacing the store', () => ownDirectory(async directory => {
  const f = await fixture(directory, true);
  const fdDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const before = (await readdir(fdDirectory)).length;
  await unchangedStore(f.filePath, async () => {
    for (let index = 0; index < 16; index += 1) {
      await assert.rejects(() => f.registry.createOperation({ websiteId: f.operation.websiteId, repositoryId: f.operation.repositoryId, kind: 'check' }),
        error => error.code === 'website_backup_operation_conflict' && error.status === 409);
    }
  });
  assert.ok((await readdir(fdDirectory)).length <= before, 'rejected action must close the actual loaded descriptor');
}));
