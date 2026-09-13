import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  JobRunningDatabaseRestoreRecoveryError,
  recoverRunningDatabaseRestore,
} from '../src/job-running-database-restore-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const backupId = 'backup-0001';
const databaseName = 'app_main';
const selectedSha = 'a'.repeat(64);
const preRestoreSha = 'b'.repeat(64);

function manifest(id, sha, overrides = {}) {
  return {
    version: 1,
    backupId: id,
    databaseName,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: sha,
    dumpBytes: 4096,
    createdAt: '2026-09-13T04:00:00.000Z',
    backedUp: true,
    sideEffects: true,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    version: 1,
    transactionId: jobId,
    backupId,
    preRestoreBackupId: `pre-restore:${jobId}`,
    databaseName,
    engine: 'mariadb',
    dumpSha256: selectedSha,
    preRestoreDumpSha256: preRestoreSha,
    restored: true,
    verified: true,
    sideEffects: true,
    committedAt: '2026-09-13T04:30:00.000Z',
    ...overrides,
  };
}

function liveEvidence(overrides = {}) {
  return {
    databaseName,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: selectedSha,
    dumpBytes: 4096,
    ...overrides,
  };
}

function fixture({
  selected = manifest(backupId, selectedSha),
  preRestore = manifest(`pre-restore:${jobId}`, preRestoreSha),
  restoreReceipt = receipt(),
  live = liveEvidence(),
} = {}) {
  const calls = [];
  const runningJob = {
    id: jobId,
    serverId,
    status: 'running',
    operation: OPERATIONS.DATABASE_RESTORE,
    resourceType: 'database',
    resourceId: databaseName,
  };
  const context = {
    ...runningJob,
    payload: { databaseName, backupId, expectedBackupSha256: selectedSha },
  };
  const registry = {
    async getJob(id) { calls.push(['getJob', id]); return runningJob; },
    async beginReconciliation(value) {
      calls.push(['begin', value]);
      return { ...value, status: 'running', pending: true };
    },
    async complete(input) {
      calls.push(['complete', input]);
      return { ...runningJob, status: 'succeeded', result: input.result };
    },
    async acknowledgeReconciliation(value) {
      calls.push(['ack', value]);
      return { ...value, status: 'succeeded', acknowledged: true };
    },
  };
  return {
    calls,
    input: {
      serverId,
      jobId,
      jobRegistry: registry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: async () => context,
      readRestoreReceipt: async (id) => { calls.push(['receipt', id]); return restoreReceipt; },
      inspectBackup: async (id) => {
        calls.push(['backup', id]);
        if (id === backupId) return selected;
        if (id === `pre-restore:${jobId}`) return preRestore;
        return null;
      },
      inspectLive: async (input) => { calls.push(['live', input]); return live; },
      inspect: async () => ({ jobs: [{
        serverId,
        jobId,
        status: 'running',
        operation: OPERATIONS.DATABASE_RESTORE,
        resourceType: 'database',
        resourceId: databaseName,
      }] }),
      reconcile: async ({ job }) => { calls.push(['reconcile', job.result]); return { reconciled: true }; },
    },
  };
}

test('running database restore closes only from receipt, selected backup, pre-backup and live digest evidence', async () => {
  const fx = fixture();
  const result = await recoverRunningDatabaseRestore(fx.input);
  assert.deepEqual(result, {
    serverId,
    jobId,
    operation: OPERATIONS.DATABASE_RESTORE,
    status: 'succeeded',
    recoveryMethod: 'verified_database_restore_receipt_backups_and_live_digest',
    reconciled: true,
  });
  const completion = fx.calls.find(([name]) => name === 'complete')[1];
  assert.deepEqual(completion.result, {
    version: 1,
    transactionId: jobId,
    backupId,
    preRestoreBackupId: `pre-restore:${jobId}`,
    databaseName,
    engine: 'mariadb',
    dumpSha256: selectedSha,
    preRestoreDumpSha256: preRestoreSha,
    restored: true,
    verified: true,
    sideEffects: true,
  });
  assert.equal(Object.hasOwn(completion.result, 'committedAt'), false);
  assert.equal(Object.hasOwn(completion.result, 'dumpPath'), false);
  assert.equal(fx.calls.some(([name]) => name === 'complete'), true);
  assert.equal(fx.calls.at(-1)[0], 'ack');
});

test('missing restore receipt leaves the running mutation unresolved', async () => {
  const fx = fixture({ restoreReceipt: null });
  await assert.rejects(
    recoverRunningDatabaseRestore(fx.input),
    (error) => error instanceof JobRunningDatabaseRestoreRecoveryError
      && error.code === 'job_database_restore_recovery_receipt_missing',
  );
  assert.equal(fx.calls.some(([name]) => name === 'backup' || name === 'live' || name === 'complete'), false);
});

test('restore recovery rejects receipt identity or selected digest drift before completion', async () => {
  for (const restoreReceipt of [
    receipt({ transactionId: '22345678-1234-4234-8234-123456789012' }),
    receipt({ backupId: 'other-backup' }),
    receipt({ dumpSha256: 'c'.repeat(64) }),
    receipt({ preRestoreBackupId: 'pre-restore:other-job' }),
  ]) {
    const fx = fixture({ restoreReceipt });
    await assert.rejects(
      recoverRunningDatabaseRestore(fx.input),
      (error) => error instanceof JobRunningDatabaseRestoreRecoveryError
        && error.code === 'job_database_restore_recovery_receipt_mismatch',
    );
    assert.equal(fx.calls.some(([name]) => name === 'complete'), false);
  }
});

test('restore recovery rejects tampered selected or pre-restore backup evidence', async () => {
  for (const options of [
    { selected: manifest(backupId, 'c'.repeat(64)) },
    { selected: { ...manifest(backupId, selectedSha), dumpPath: '/private/selected.sql' } },
    { preRestore: manifest(`pre-restore:${jobId}`, 'c'.repeat(64)) },
    { preRestore: { ...manifest(`pre-restore:${jobId}`, preRestoreSha), dumpPath: '/private/pre.sql' } },
  ]) {
    const fx = fixture(options);
    await assert.rejects(
      recoverRunningDatabaseRestore(fx.input),
      (error) => error instanceof JobRunningDatabaseRestoreRecoveryError
        && ['job_database_restore_recovery_selected_backup_mismatch', 'job_database_restore_recovery_pre_restore_backup_mismatch'].includes(error.code),
    );
    assert.equal(fx.calls.some(([name]) => name === 'complete'), false);
  }
});

test('restore recovery rejects live engine, digest or byte drift and never re-runs restore', async () => {
  for (const live of [
    liveEvidence({ engine: 'mysql' }),
    liveEvidence({ dumpSha256: 'c'.repeat(64) }),
    liveEvidence({ dumpBytes: 4097 }),
    { ...liveEvidence(), dumpPath: '/private/live.sql' },
  ]) {
    const fx = fixture({ live });
    await assert.rejects(
      recoverRunningDatabaseRestore(fx.input),
      (error) => error instanceof JobRunningDatabaseRestoreRecoveryError
        && error.code === 'job_database_restore_recovery_live_state_mismatch',
    );
    assert.equal(fx.calls.some(([name]) => name === 'complete'), false);
    assert.equal(fx.calls.some(([name]) => name === 'restore'), false);
  }
});

test('database restore recovery refuses to run while API or legacy agent can still consume jobs', async () => {
  const fx = fixture();
  fx.input.serviceStatus = async () => ({ apiActive: true, agentActive: false });
  await assert.rejects(
    recoverRunningDatabaseRestore(fx.input),
    (error) => error instanceof JobRunningDatabaseRestoreRecoveryError
      && error.code === 'job_database_restore_recovery_consumers_must_be_stopped',
  );
  assert.equal(fx.calls.length, 0);
});
