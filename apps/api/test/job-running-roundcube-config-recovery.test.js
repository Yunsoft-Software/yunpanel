import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningRoundcubeConfig } from '../src/job-running-roundcube-config-recovery.js';

const serverId = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const jobId = '12345678-1234-4234-8234-123456789012';
const previewSha256 = 'a'.repeat(64);
const configSha256 = 'b'.repeat(64);
const fpmSha256 = 'c'.repeat(64);
const nginxSha256 = 'e'.repeat(64);
const payload = { previewSha256, configSha256, fpmSha256 };

function fixture({
  evidenceSatisfied = true,
  materializedPreview = previewSha256,
  httpHealthy = true,
  receiptNginxSha256 = nginxSha256,
  receiptHttpHealthy = true,
} = {}) {
  const calls = [];
  const job = {
    id: jobId,
    serverId,
    operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
    resourceType: 'server',
    resourceId: serverId,
    status: 'running',
    payload,
  };
  const jobRegistry = {
    async getJob() { return job; },
    async beginReconciliation(identity) { calls.push(['begin', identity]); return { ...identity, status: 'running', pending: true }; },
    async complete(input) {
      calls.push(['complete', input]);
      return { ...job, status: 'succeeded', result: input.result };
    },
    async acknowledgeReconciliation(identity) {
      calls.push(['ack', identity]);
      return { ...identity, status: 'succeeded', acknowledged: true };
    },
  };
  return {
    calls,
    input: {
      serverId,
      jobId,
      jobRegistry,
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: {},
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({ jobs: [{
        jobId, serverId, status: 'running', operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
        resourceType: 'server', resourceId: serverId,
      }] }),
      loadJobContext: async () => ({
        id: jobId, serverId, status: 'running', operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
        resourceType: 'server', resourceId: serverId, payload,
      }),
      readOperationReceipt: async () => ({
        serverId,
        jobId,
        ...payload,
        nginxSha256: receiptNginxSha256,
        databaseCreated: true,
        httpHealthy: receiptHttpHealthy,
        applied: true,
      }),
      materializeConfiguration: async (id, expected) => {
        calls.push(['materialize', id, expected]);
        return { preview: { sha256: materializedPreview, configSha256, fpmSha256, nginxSha256 } };
      },
      inspectActiveEvidence: async () => evidenceSatisfied ? ({
        satisfied: true,
        result: {
          previewSha256, configSha256, fpmSha256, nginxSha256,
          databaseHealthy: true, httpHealthy, applied: true, sideEffects: true,
        },
      }) : ({ satisfied: false, result: null }),
      reconcile: async ({ job: terminal }) => {
        calls.push(['reconcile', terminal]);
        return { reconciled: true };
      },
    },
  };
}

test('Roundcube lost acknowledgement closes only after receipt, desired state and HTTPS live evidence match', async () => {
  const fx = fixture();
  const result = await recoverRunningRoundcubeConfig(fx.input);
  assert.deepEqual(result, {
    serverId,
    jobId,
    operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
    status: 'succeeded',
    recoveryMethod: 'verified_roundcube_receipt_and_active_host_state',
    reconciled: true,
  });
  const completion = fx.calls.find(([name]) => name === 'complete')?.[1];
  assert.deepEqual(completion.result, {
    version: 1,
    previewSha256,
    configSha256,
    fpmSha256,
    nginxSha256,
    databaseCreated: true,
    httpHealthy: true,
    applied: true,
    sideEffects: true,
  });
});

test('Roundcube recovery remains unresolved when receipt, desired state, live files or HTTPS health drifted', async () => {
  await assert.rejects(
    recoverRunningRoundcubeConfig(fixture({ receiptHttpHealthy: false }).input),
    { code: 'job_roundcube_recovery_receipt_mismatch' },
  );
  await assert.rejects(
    recoverRunningRoundcubeConfig(fixture({ receiptNginxSha256: 'f'.repeat(64) }).input),
    { code: 'job_roundcube_recovery_materialization_invalid' },
  );
  await assert.rejects(
    recoverRunningRoundcubeConfig(fixture({ materializedPreview: 'd'.repeat(64) }).input),
    { code: 'job_roundcube_recovery_materialization_invalid' },
  );
  await assert.rejects(
    recoverRunningRoundcubeConfig(fixture({ evidenceSatisfied: false }).input),
    { code: 'job_roundcube_recovery_evidence_not_satisfied' },
  );
  await assert.rejects(
    recoverRunningRoundcubeConfig(fixture({ httpHealthy: false }).input),
    { code: 'job_roundcube_recovery_evidence_not_satisfied' },
  );
});
