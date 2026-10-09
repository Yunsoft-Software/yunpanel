import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  recoverRunningCron,
  JobRunningCronRecoveryError,
  jobRunningCronRecoveryInternals,
} from '../src/job-running-cron-recovery.js';

const serverId = '11111111-1111-4111-8111-111111111111';
const jobId = 'cron-recovery-job-01';
const taskId = '22222222-2222-4222-8222-222222222222';
const websiteId = '33333333-3333-4333-8333-333333333333';
const applicationId = '44444444-4444-4444-8444-444444444444';
const unixUser = 'yunapp-123456789abc';
const desiredStateSha256 = createHash('sha256').update('0 3 * * * /usr/bin/task.sh').digest('hex');
const contentSha256 = desiredStateSha256;

function createHarness({
  operation = OPERATIONS.CRON_APPLY,
  apiActive = false,
  agentActive = false,
  hasReceipt = true,
  receiptOverrides = {},
  hostFiles = [{ taskId, contentSha256 }],
  cronTaskInRegistry = { id: taskId, websiteId, applicationId, unixUser, revision: 1 },
  jobStatus = 'running',
  contextPayload = {},
} = {}) {
  const calls = [];
  const runningJob = {
    id: jobId,
    serverId,
    status: jobStatus,
    operation,
    resourceType: 'website_cron',
    resourceId: taskId,
  };

  const candidate = {
    jobId,
    serverId,
    status: jobStatus,
    operation,
    resourceType: 'website_cron',
  };

  const receipt = hasReceipt
    ? {
        version: 1,
        serverId,
        jobId,
        operation,
        result: {
          version: 1,
          taskId,
          websiteId,
          applicationId,
          unixUser,
          revision: 1,
          desiredStateSha256,
          contentSha256: operation === OPERATIONS.CRON_APPLY ? contentSha256 : null,
          [operation === OPERATIONS.CRON_APPLY ? 'applied' : 'removed']: true,
          sideEffects: operation === OPERATIONS.CRON_APPLY,
        },
        ...receiptOverrides,
      }
    : null;

  const jobRegistry = {
    async getJob(id) {
      calls.push(['getJob', id]);
      return id === jobId ? structuredClone(runningJob) : null;
    },
    async beginReconciliation(id) {
      calls.push(['beginReconciliation', id]);
      return { jobId: id.jobId, serverId: id.serverId, status: 'running', pending: true };
    },
    async complete({ serverId: sId, jobId: jId, status, result }) {
      calls.push(['complete', { serverId: sId, jobId: jId, status, result }]);
      return { ...runningJob, status, result };
    },
    async acknowledgeReconciliation(id) {
      calls.push(['acknowledgeReconciliation', id]);
      return { acknowledged: true };
    },
  };

  const websiteCronManager = {
    async listManagedFiles() {
      calls.push(['listManagedFiles']);
      return { files: hostFiles, cronServiceActive: true };
    },
  };

  const websiteCronRegistry = {
    async getTask(id) {
      calls.push(['getTask', id]);
      return id === taskId ? cronTaskInRegistry : null;
    },
  };

  return {
    calls,
    args: {
      serverId,
      jobId,
      jobRegistry,
      websiteCronRegistry,
      websiteCronManager,
      readOperationReceipt: async () => receipt,
      serviceStatus: async () => ({ apiActive, agentActive }),
      loadJobContext: async () => ({ id: jobId, payload: { taskId, websiteId, applicationId, unixUser, expectedRevision: 1, ...contextPayload } }),
      inspect: async () => ({ jobs: [candidate] }),
    },
  };
}

test('recoverRunningCron recovers running CRON_APPLY job with verified receipt and host state', async () => {
  const h = createHarness({ operation: OPERATIONS.CRON_APPLY });
  const result = await recoverRunningCron(h.args);

  assert.equal(result.serverId, serverId);
  assert.equal(result.jobId, jobId);
  assert.equal(result.operation, OPERATIONS.CRON_APPLY);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.recoveryMethod, 'verified_cron_receipt_and_host_state');
  assert.equal(result.reconciled, true);

  const callNames = h.calls.map(([name]) => name);
  assert.ok(callNames.includes('getJob'));
  assert.ok(callNames.includes('listManagedFiles'));
  assert.ok(callNames.includes('getTask'));
  assert.ok(callNames.includes('beginReconciliation'));
  assert.ok(callNames.includes('complete'));
  assert.ok(callNames.includes('acknowledgeReconciliation'));
});

test('recoverRunningCron recovers running CRON_REMOVE job when host file and registry task are absent', async () => {
  const h = createHarness({
    operation: OPERATIONS.CRON_REMOVE,
    hostFiles: [],
    cronTaskInRegistry: null,
  });
  const result = await recoverRunningCron(h.args);

  assert.equal(result.operation, OPERATIONS.CRON_REMOVE);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.reconciled, true);
});

test('recoverRunningCron rejects if active consumers (API or agent) are running', async () => {
  const h1 = createHarness({ apiActive: true });
  await assert.rejects(
    () => recoverRunningCron(h1.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_consumers_must_be_stopped',
  );

  const h2 = createHarness({ agentActive: true });
  await assert.rejects(
    () => recoverRunningCron(h2.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_consumers_must_be_stopped',
  );
});

test('recoverRunningCron fails closed if receipt is missing', async () => {
  const h = createHarness({ hasReceipt: false });
  await assert.rejects(
    () => recoverRunningCron(h.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_receipt_missing',
  );
});

test('recoverRunningCron fails closed if host state drifts for CRON_APPLY', async () => {
  // Host file missing
  const h1 = createHarness({ operation: OPERATIONS.CRON_APPLY, hostFiles: [] });
  await assert.rejects(
    () => recoverRunningCron(h1.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_host_state_mismatch',
  );

  // Host file checksum drifted
  const h2 = createHarness({
    operation: OPERATIONS.CRON_APPLY,
    hostFiles: [{ taskId, contentSha256: 'f'.repeat(64) }],
  });
  await assert.rejects(
    () => recoverRunningCron(h2.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_host_state_mismatch',
  );
});

test('recoverRunningCron fails closed if host file remains present for CRON_REMOVE', async () => {
  const h = createHarness({
    operation: OPERATIONS.CRON_REMOVE,
    hostFiles: [{ taskId, contentSha256 }],
    cronTaskInRegistry: null,
  });
  await assert.rejects(
    () => recoverRunningCron(h.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_host_state_mismatch',
  );
});

test('recoverRunningCron fails closed if registry state is inconsistent', async () => {
  // CRON_APPLY but task missing from registry
  const h1 = createHarness({ operation: OPERATIONS.CRON_APPLY, cronTaskInRegistry: null });
  await assert.rejects(
    () => recoverRunningCron(h1.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_registry_mismatch',
  );

  // CRON_REMOVE but task still present in registry
  const h2 = createHarness({
    operation: OPERATIONS.CRON_REMOVE,
    hostFiles: [],
    cronTaskInRegistry: { id: taskId, websiteId },
  });
  await assert.rejects(
    () => recoverRunningCron(h2.args),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_registry_mismatch',
  );
});

test('recoverRunningCron validates dependencies and identities fail-closed', async () => {
  await assert.rejects(
    () => recoverRunningCron({}),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_identity_invalid',
  );

  await assert.rejects(
    () => recoverRunningCron({ serverId, jobId, jobRegistry: null }),
    (err) => err instanceof JobRunningCronRecoveryError && err.code === 'job_cron_recovery_dependencies_invalid',
  );
});
