import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseRestoreManager,
  DatabaseRestoreError,
} from '../src/database-restore-manager.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const selectedContent = 'selected canonical dump\n';
const rollbackContent = 'pre-restore canonical dump\n';
const selectedSha = digest(selectedContent);
const rollbackSha = digest(rollbackContent);
const request = Object.freeze({
  transactionId: 'restore-0001',
  backupId: 'backup-0001',
  databaseName: 'app_main',
  expectedBackupSha256: selectedSha,
});

async function fixture(t, {
  failSelected = false,
  corruptSelected = false,
  failRollback = false,
  failReceipt = false,
} = {}) {
  const transactionRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-restore-'));
  t.after(() => rm(transactionRoot, { recursive: true, force: true }));
  const calls = [];
  let databasePresent = true;
  let liveContent = rollbackContent;
  const selected = Object.freeze({
    version: 1,
    backupId: 'backup-0001',
    databaseName: 'app_main',
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: selectedSha,
    dumpBytes: Buffer.byteLength(selectedContent),
    createdAt: '2026-09-13T03:30:00.000Z',
    backedUp: true,
    sideEffects: true,
    dumpPath: '/private/backup-0001/dump.sql',
  });
  const rollback = Object.freeze({
    version: 1,
    backupId: 'pre-restore:restore-0001',
    databaseName: 'app_main',
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: rollbackSha,
    dumpBytes: Buffer.byteLength(rollbackContent),
    createdAt: '2026-09-13T03:31:00.000Z',
    backedUp: true,
    sideEffects: true,
    dumpPath: '/private/pre-restore/dump.sql',
  });
  const backupManager = {
    async materializeBackup(id) {
      calls.push(['materialize', id]);
      if (id === selected.backupId) return selected;
      if (id === rollback.backupId) return rollback;
      throw new Error('unexpected backup');
    },
    async backup(input) {
      calls.push(['backup', input]);
      assert.deepEqual(input, { backupId: rollback.backupId, databaseName: 'app_main' });
      return { ...rollback, dumpPath: undefined };
    },
  };
  const databaseManager = {
    async inspect() {
      calls.push(['inspect']);
      return {
        engine: 'mariadb',
        version: '10.11.13-MariaDB',
        databases: databasePresent ? [{ name: 'app_main', sizeBytes: 1 }] : [],
      };
    },
    async dropDatabase(name) {
      calls.push(['drop', name]);
      databasePresent = false;
      return { deleted: true };
    },
  };
  const restoreFromFile = async ({ dumpPath, engine, programs }) => {
    calls.push(['restore', dumpPath, engine, programs]);
    if (dumpPath === selected.dumpPath) {
      databasePresent = true;
      liveContent = corruptSelected ? 'different restored state\n' : selectedContent;
      if (failSelected) throw new Error('selected restore failed');
      return '/usr/bin/mariadb';
    }
    if (dumpPath === rollback.dumpPath) {
      if (failRollback) throw new Error('rollback restore failed');
      databasePresent = true;
      liveContent = rollbackContent;
      return '/usr/bin/mariadb';
    }
    throw new Error('unexpected restore source');
  };
  const dumpToFile = async ({ outputPath, databaseName, engine, programs }) => {
    calls.push(['verify-dump', databaseName, engine, programs]);
    assert.equal(databasePresent, true);
    await writeFile(outputPath, liveContent, { mode: 0o600 });
  };
  const receiptStore = {
    async write(value) {
      calls.push(['receipt', structuredClone(value)]);
      if (failReceipt) throw new Error('receipt write failed');
      return { ...value, committedAt: '2026-09-13T04:30:00.000Z' };
    },
  };
  return {
    calls,
    state: () => ({ databasePresent, liveContent }),
    manager: createDatabaseRestoreManager({
      transactionRoot,
      databaseManager,
      backupManager,
      receiptStore,
      restoreFromFile,
      dumpToFile,
    }),
  };
}

test('restore takes a pre-restore backup, replaces the schema, verifies digest and commits receipt', async (t) => {
  const fx = await fixture(t);
  const result = await fx.manager.restore(request);
  assert.deepEqual(result, {
    version: 1,
    transactionId: 'restore-0001',
    backupId: 'backup-0001',
    preRestoreBackupId: 'pre-restore:restore-0001',
    databaseName: 'app_main',
    engine: 'mariadb',
    dumpSha256: selectedSha,
    preRestoreDumpSha256: rollbackSha,
    restored: true,
    verified: true,
    sideEffects: true,
  });
  assert.equal(fx.state().liveContent, selectedContent);
  assert.equal(fx.calls.filter(([name]) => name === 'backup').length, 1);
  assert.equal(fx.calls.filter(([name]) => name === 'receipt').length, 1);
  assert.ok(fx.calls.some(([name, value]) => name === 'drop' && value === 'app_main'));
  assert.ok(fx.calls.some(([name, value]) => name === 'restore' && value === '/private/backup-0001/dump.sql'));
});

test('stale selected backup digest fails before target inspection, pre-backup or mutation', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.manager.restore({ ...request, expectedBackupSha256: 'c'.repeat(64) }),
    (error) => error instanceof DatabaseRestoreError && error.code === 'database_restore_backup_stale',
  );
  assert.deepEqual(fx.calls, [['materialize', 'backup-0001']]);
});

test('restore failure replays and verifies the pre-restore backup before surfacing failure', async (t) => {
  const fx = await fixture(t, { failSelected: true });
  await assert.rejects(
    fx.manager.restore(request),
    (error) => error instanceof DatabaseRestoreError && error.code === 'database_restore_failed',
  );
  assert.equal(fx.state().databasePresent, true);
  assert.equal(fx.state().liveContent, rollbackContent);
  assert.ok(fx.calls.some(([name, value]) => name === 'restore' && value === '/private/pre-restore/dump.sql'));
  assert.equal(fx.calls.filter(([name]) => name === 'verify-dump').length, 1);
  assert.equal(fx.calls.filter(([name]) => name === 'receipt').length, 0);
});

test('digest mismatch triggers rollback and preserves the verification failure code', async (t) => {
  const fx = await fixture(t, { corruptSelected: true });
  await assert.rejects(
    fx.manager.restore(request),
    (error) => error instanceof DatabaseRestoreError && error.code === 'database_restore_verification_failed',
  );
  assert.equal(fx.state().liveContent, rollbackContent);
  assert.equal(fx.calls.filter(([name]) => name === 'verify-dump').length, 2);
  assert.equal(fx.calls.filter(([name]) => name === 'receipt').length, 0);
});

test('receipt commit failure rolls back and never reports restore success', async (t) => {
  const fx = await fixture(t, { failReceipt: true });
  await assert.rejects(
    fx.manager.restore(request),
    (error) => error instanceof DatabaseRestoreError && error.code === 'database_restore_receipt_failed',
  );
  assert.equal(fx.state().databasePresent, true);
  assert.equal(fx.state().liveContent, rollbackContent);
  assert.equal(fx.calls.filter(([name]) => name === 'receipt').length, 1);
  assert.ok(fx.calls.some(([name, value]) => name === 'restore' && value === '/private/pre-restore/dump.sql'));
  assert.equal(fx.calls.filter(([name]) => name === 'verify-dump').length, 2);
});

test('rollback failure is explicit and never reports a restored database', async (t) => {
  const fx = await fixture(t, { failSelected: true, failRollback: true });
  await assert.rejects(
    fx.manager.restore(request),
    (error) => error instanceof DatabaseRestoreError && error.code === 'database_restore_rollback_failed',
  );
});
