import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabaseRestoreManager } from '../src/database-restore-manager.js';

const selectedContent = 'selected canonical dump\n';
const rollbackContent = 'pre-restore canonical dump\n';
const selectedSha = createHash('sha256').update(selectedContent).digest('hex');
const rollbackSha = createHash('sha256').update(rollbackContent).digest('hex');
const request = Object.freeze({
  transactionId: 'restore-progress-0001',
  backupId: 'backup-progress-0001',
  databaseName: 'app_main',
  expectedBackupSha256: selectedSha,
});

async function fixture(t, { failSelected = false } = {}) {
  const transactionRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-restore-progress-'));
  t.after(() => rm(transactionRoot, { recursive: true, force: true }));
  let liveContent = rollbackContent;
  let databasePresent = true;
  const selected = {
    backupId: request.backupId,
    databaseName: request.databaseName,
    engine: 'mariadb',
    dumpSha256: selectedSha,
    dumpPath: '/private/selected.sql',
  };
  const rollback = {
    backupId: `pre-restore:${request.transactionId}`,
    databaseName: request.databaseName,
    engine: 'mariadb',
    dumpSha256: rollbackSha,
    dumpPath: '/private/pre-restore.sql',
  };
  const manager = createDatabaseRestoreManager({
    transactionRoot,
    databaseManager: {
      async inspect() {
        return {
          engine: 'mariadb',
          version: '10.11.13-MariaDB',
          databases: databasePresent ? [{ name: request.databaseName, sizeBytes: 1 }] : [],
        };
      },
      async dropDatabase() { databasePresent = false; return { deleted: true }; },
    },
    backupManager: {
      async materializeBackup(id) { return id === request.backupId ? selected : rollback; },
      async backup() {
        return {
          ...rollback,
          dumpPath: undefined,
          dumpBytes: Buffer.byteLength(rollbackContent),
        };
      },
    },
    receiptStore: { async write(value) { return value; } },
    restoreFromFile: async ({ dumpPath }) => {
      if (dumpPath === selected.dumpPath && failSelected) throw new Error('selected restore failed');
      databasePresent = true;
      liveContent = dumpPath === selected.dumpPath ? selectedContent : rollbackContent;
    },
    dumpToFile: async ({ outputPath }) => writeFile(outputPath, liveContent, { mode: 0o600 }),
  });
  return manager;
}

test('successful database restore emits a bounded monotonic checkpoint sequence', async (t) => {
  const manager = await fixture(t);
  const progress = [];
  await manager.restore(request, {
    recordProgress: async (entry) => progress.push(structuredClone(entry)),
  });
  assert.deepEqual(progress, [
    { stage: 'source', percent: 10 },
    { stage: 'pre_backup', percent: 30 },
    { stage: 'apply', percent: 40 },
    { stage: 'verify', percent: 80 },
    { stage: 'receipt', percent: 90 },
    { stage: 'done', percent: 100 },
  ]);
  assert.ok(progress.length <= 8);
});

test('failed database restore exposes rollback checkpoints without leaking host details', async (t) => {
  const manager = await fixture(t, { failSelected: true });
  const progress = [];
  await assert.rejects(
    manager.restore(request, { recordProgress: async (entry) => progress.push(structuredClone(entry)) }),
    { code: 'database_restore_failed' },
  );
  assert.deepEqual(progress, [
    { stage: 'source', percent: 10 },
    { stage: 'pre_backup', percent: 30 },
    { stage: 'apply', percent: 40 },
    { stage: 'rollback', percent: 95 },
    { stage: 'rollback_verified', percent: 100 },
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /private|dump\.sql|CREATE TABLE|socket|password/i);
});

test('progress sink failure cannot change restore transaction semantics', async (t) => {
  const manager = await fixture(t);
  const result = await manager.restore(request, {
    recordProgress: async () => { throw new Error('log store unavailable'); },
  });
  assert.equal(result.restored, true);
  assert.equal(result.verified, true);
});
