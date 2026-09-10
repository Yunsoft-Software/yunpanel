import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningStaticRollback } from '../src/job-running-static-rollback-recovery.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const currentReleaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

function fixture({ evidence = true, applicationState = 'rolling_back' } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob() { events.push('get'); return { id: jobId, serverId, status, operation: OPERATIONS.APP_STATIC_ROLLBACK, resourceType: 'application', resourceId: applicationId }; },
    async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
    async complete(input) { events.push('complete'); status = input.status; return { id: jobId, serverId, status, operation: OPERATIONS.APP_STATIC_ROLLBACK, resourceType: 'application', resourceId: applicationId, result: input.result }; },
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
          return { id: applicationId, serverId, type: 'static', state: applicationState, activeDeploymentId: jobId, pendingRollbackReleaseId: releaseId, currentReleaseId };
        },
      },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({ jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.APP_STATIC_ROLLBACK, resourceType: 'application', resourceId: applicationId }] }),
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation: OPERATIONS.APP_STATIC_ROLLBACK, resourceType: 'application', resourceId: applicationId, payload: { applicationId, releaseId, currentReleaseId } };
      },
      inspectRollbackEvidence: async () => {
        events.push('evidence');
        return evidence ? { satisfied: true, result: { releaseId, previousReleaseId: currentReleaseId, active: true } } : { satisfied: false, result: null };
      },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true, error: null }; },
    },
  };
}

test('static rollback recovery verifies application and host state before durable completion', async () => {
  const fx = fixture();
  const result = await recoverRunningStaticRollback(fx.options);
  assert.equal(result.recoveryMethod, 'verified_static_rollback_symlink');
  assert.deepEqual(fx.events, ['get', 'context', 'application', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing rollback evidence leaves job untouched', async () => {
  const fx = fixture({ evidence: false });
  await assert.rejects(recoverRunningStaticRollback(fx.options), { code: 'job_static_rollback_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'application', 'evidence']);
});

test('application state drift prevents host evidence inspection', async () => {
  const fx = fixture({ applicationState: 'active' });
  await assert.rejects(recoverRunningStaticRollback(fx.options), { code: 'job_static_rollback_recovery_application_mismatch' });
  assert.deepEqual(fx.events, ['get', 'context', 'application']);
});
