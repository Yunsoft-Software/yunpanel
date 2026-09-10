import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningNodeRollback } from '../src/job-running-node-rollback-recovery.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const currentReleaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const serviceName = 'yunpanel-node-0123456789abcdef.service';
const runtime = { port: 3100, healthPath: '/health', healthTimeoutSeconds: 10 };

function fixture({ receipt = true, healthy = true, applicationDrift = false } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob() { events.push('get'); return { id: jobId, serverId, status, operation: OPERATIONS.APP_NODE_ROLLBACK, resourceType: 'application', resourceId: applicationId }; },
    async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
    async complete(input) { events.push('complete'); status = input.status; return { id: jobId, serverId, status, operation: OPERATIONS.APP_NODE_ROLLBACK, resourceType: 'application', resourceId: applicationId, result: input.result }; },
    async acknowledgeReconciliation() { events.push('ack'); return { serverId, jobId, status: 'succeeded', acknowledged: true }; },
  };
  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry,
      applicationRegistry: {
        async getApplication() {
          events.push('application');
          return {
            id: applicationId,
            serverId,
            type: 'node',
            state: applicationDrift ? 'active' : 'rolling_back',
            activeDeploymentId: applicationDrift ? null : jobId,
            pendingRollbackReleaseId: applicationDrift ? null : releaseId,
            currentReleaseId,
            runtime,
          };
        },
      },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({ jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.APP_NODE_ROLLBACK, resourceType: 'application', resourceId: applicationId }] }),
      loadJobContext: async () => {
        events.push('context');
        return {
          id: jobId,
          serverId,
          status: 'running',
          operation: OPERATIONS.APP_NODE_ROLLBACK,
          resourceType: 'application',
          resourceId: applicationId,
          payload: { applicationId, releaseId, currentReleaseId, runtime },
        };
      },
      readRollbackReceipt: async () => {
        events.push('receipt');
        return receipt
          ? { serverId, jobId, applicationId, releaseId, previousReleaseId: currentReleaseId, serviceName, port: runtime.port, healthPath: runtime.healthPath }
          : null;
      },
      inspectNodeStatus: async () => {
        events.push('status');
        return {
          releaseId,
          serviceName,
          port: runtime.port,
          healthPath: runtime.healthPath,
          loadState: 'loaded',
          activeState: 'active',
          subState: 'running',
          restartCount: 1,
          mainPid: 42,
          healthy,
          inspectionError: false,
        };
      },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true, error: null }; },
    },
  };
}

test('Node rollback recovery verifies control-plane intent, receipt and live status before completion', async () => {
  const fx = fixture();
  const result = await recoverRunningNodeRollback(fx.options);
  assert.equal(result.recoveryMethod, 'verified_node_rollback_receipt_and_status');
  assert.deepEqual(fx.events, ['get', 'context', 'application', 'receipt', 'status', 'begin', 'complete', 'reconcile', 'ack']);
});

test('application rollback drift prevents receipt and host evidence from being consumed', async () => {
  const fx = fixture({ applicationDrift: true });
  await assert.rejects(recoverRunningNodeRollback(fx.options), { code: 'job_node_rollback_recovery_application_mismatch' });
  assert.deepEqual(fx.events, ['get', 'context', 'application']);
});

test('missing rollback receipt prevents live status from proving the historical rollback', async () => {
  const fx = fixture({ receipt: false });
  await assert.rejects(recoverRunningNodeRollback(fx.options), { code: 'job_node_rollback_recovery_receipt_missing' });
  assert.deepEqual(fx.events, ['get', 'context', 'application', 'receipt']);
});

test('unhealthy target Node process leaves rollback unresolved', async () => {
  const fx = fixture({ healthy: false });
  await assert.rejects(recoverRunningNodeRollback(fx.options), { code: 'job_node_rollback_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'application', 'receipt', 'status']);
});
