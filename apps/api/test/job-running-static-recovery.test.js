import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningStaticDeployment } from '../src/job-running-static-recovery.js';

const serverId = 'server-1';
const jobId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const result = Object.freeze({
  deploymentId: jobId,
  releaseId: jobId,
  commitSha: 'a'.repeat(40),
  previousReleaseId: null,
  artifactFiles: 3,
  artifactBytes: 1024,
});

function fixture({ operation = OPERATIONS.APP_STATIC_DEPLOY, evidence = { satisfied: true, result } } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob() {
      events.push('get');
      return { id: jobId, serverId, status, operation, resourceType: 'application', resourceId: applicationId };
    },
    async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
    async complete(input) {
      events.push('complete');
      status = input.status;
      return { id: jobId, serverId, status, operation, resourceType: 'application', resourceId: applicationId, result: input.result };
    },
    async acknowledgeReconciliation() { events.push('ack'); return { serverId, jobId, status: 'succeeded', acknowledged: true }; },
  };
  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry,
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: {},
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation, resourceType: 'application', resourceId: applicationId }],
      }),
      loadJobContext: async () => {
        events.push('context');
        return {
          id: jobId,
          serverId,
          status: 'running',
          operation,
          resourceType: 'application',
          resourceId: applicationId,
          payload: { applicationId, deploymentId: jobId },
        };
      },
      inspectDeploymentEvidence: async (identity) => {
        events.push('evidence');
        assert.deepEqual(identity, { applicationId, deploymentId: jobId });
        return evidence;
      },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true, error: null }; },
    },
  };
}

test('static recovery proves private queued payload before host evidence and journal', async () => {
  const fx = fixture();
  const recovered = await recoverRunningStaticDeployment(fx.options);
  assert.equal(recovered.recoveryMethod, 'verified_static_deployment_receipt');
  assert.deepEqual(fx.events, ['get', 'context', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing static deployment evidence leaves running state untouched', async () => {
  const fx = fixture({ evidence: { satisfied: false, result: null } });
  await assert.rejects(recoverRunningStaticDeployment(fx.options), { code: 'job_static_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'evidence']);
});

test('static rollback and Node deployment cannot enter static deploy recovery', async () => {
  for (const operation of [OPERATIONS.APP_STATIC_ROLLBACK, OPERATIONS.APP_NODE_DEPLOY]) {
    const fx = fixture({ operation });
    await assert.rejects(recoverRunningStaticDeployment(fx.options), { code: 'job_static_recovery_job_mismatch' });
    assert.deepEqual(fx.events, []);
  }
});

test('private static recovery context mismatch is rejected before evidence inspection', async () => {
  const fx = fixture();
  fx.options.loadJobContext = async () => ({
    id: jobId,
    serverId,
    status: 'running',
    operation: OPERATIONS.APP_STATIC_DEPLOY,
    resourceType: 'application',
    resourceId: applicationId,
    payload: { applicationId: 'different-application', deploymentId: jobId },
  });
  await assert.rejects(recoverRunningStaticDeployment(fx.options), { code: 'job_static_recovery_context_mismatch' });
  assert.deepEqual(fx.events, ['get']);
});

test('reconciliation failure keeps terminal receipt-backed work unacknowledged', async () => {
  const fx = fixture();
  fx.options.reconcile = async () => { fx.events.push('reconcile'); throw new Error('hidden'); };
  await assert.rejects(recoverRunningStaticDeployment(fx.options), { code: 'job_static_recovery_reconciliation_failed' });
  assert.deepEqual(fx.events, ['get', 'context', 'evidence', 'begin', 'complete', 'reconcile']);
});
