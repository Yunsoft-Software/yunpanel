import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  JobRunningDatabaseBackupRecoveryError,
  recoverRunningDatabaseBackup,
} from '../src/job-running-database-backup-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const digest = 'a'.repeat(64);

function evidence(overrides = {}) {
  return {
    version: 1,
    backupId: jobId,
    databaseName,
    engine: 'mariadb',
    databaseVersion: '10.11.13-MariaDB',
    dumpSha256: digest,
    dumpBytes: 4096,
    createdAt: '2026-09-13T04:00:00.000Z',
    backedUp: true,
    sideEffects: true,
    ...overrides,
  };
}

function fixture({ backupEvidence = evidence() } = {}) {
  const calls = [];
  const runningJob = {
    id: jobId,
    serverId,
    status: 'running',
    operation: OPERATIONS.DATABASE_BACKUP,
    resourceType: 'database',
    resourceId: databaseName,
    payload: { databaseName },
  };
  const registry = {
    async getJob(id) { calls.push(['getJob', id]); return runningJob; },
    async beginReconciliation(identity) {
      calls.push(['begin', identity]);
      return { ...identity, status: 'running', pending: true };
    },
    async complete(input) {
      calls.push(['complete', input]);
      return { ...runningJob, status: 'succeeded', result: input.result };
    },
    async acknowledgeReconciliation(identity) {
      calls.push(['ack', identity]);
      return { ...identity, status: 'succeeded', acknowledged: true };
    },
  };
  return {
    calls,
    registry,
    input: {
      serverId,
      jobId,
      jobRegistry: registry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: async () => ({ ...runningJob }),
      inspectBackup: async (id) => { calls.push(['evidence', id]); return backupEvidence; },
      inspect: async () => ({ jobs: [{
        serverId,
        jobId,
        status: 'running',
        operation: OPERATIONS.DATABASE_BACKUP,
        resourceType: 'database',
        resourceId: databaseName,
      }] }),
      reconcile: async ({ job }) => { calls.push(['reconcile', job.result]); return { reconciled: true }; },
    },
  };
}

test('running database backup closes only from verified private backup artifact evidence', async () => {
  const fx = fixture();
  const result = await recoverRunningDatabaseBackup(fx.input);
  assert.deepEqual(result, {
    serverId,
    jobId,
    operation: OPERATIONS.DATABASE_BACKUP,
    status: 'succeeded',
    recoveryMethod: 'verified_private_database_backup_artifact',
    reconciled: true,
  });
  const completion = fx.calls.find(([name]) => name === 'complete')[1];
  assert.deepEqual(completion.result, evidence());
  assert.equal(Object.hasOwn(completion.result, 'dumpPath'), false);
  assert.deepEqual(fx.calls.map(([name]) => name), ['getJob', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing backup artifact leaves the running job unresolved', async () => {
  const fx = fixture({ backupEvidence: null });
  await assert.rejects(
    recoverRunningDatabaseBackup(fx.input),
    (error) => error instanceof JobRunningDatabaseBackupRecoveryError
      && error.code === 'job_database_backup_recovery_evidence_missing',
  );
  assert.equal(fx.calls.some(([name]) => name === 'complete'), false);
});

test('mismatched or private backup evidence is rejected before durable completion', async () => {
  for (const backupEvidence of [
    evidence({ backupId: '22345678-1234-4234-8234-123456789012' }),
    evidence({ databaseName: 'other_db' }),
    evidence({ dumpSha256: 'bad' }),
    { ...evidence(), dumpPath: '/private/dump.sql' },
  ]) {
    const fx = fixture({ backupEvidence });
    await assert.rejects(
      recoverRunningDatabaseBackup(fx.input),
      (error) => error instanceof JobRunningDatabaseBackupRecoveryError
        && error.code === 'job_database_backup_recovery_evidence_invalid',
    );
    assert.equal(fx.calls.some(([name]) => name === 'complete'), false);
  }
});

test('recovery refuses to run while API or legacy agent can still consume the job', async () => {
  const fx = fixture();
  fx.input.serviceStatus = async () => ({ apiActive: true, agentActive: false });
  await assert.rejects(
    recoverRunningDatabaseBackup(fx.input),
    (error) => error instanceof JobRunningDatabaseBackupRecoveryError
      && error.code === 'job_database_backup_recovery_consumers_must_be_stopped',
  );
  assert.equal(fx.calls.length, 0);
});
