import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningNodeProcess } from '../src/job-running-node-process-recovery.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const runtime = {
  nodeMajor: 24,
  packageManager: 'npm',
  installMode: 'ci',
  buildScript: null,
  mode: 'production',
  documentRoot: '.',
  start: { mode: 'node', entryFile: 'server.js', script: null },
  port: 3100,
  healthPath: '/health',
  healthTimeoutSeconds: 30,
  restartPolicy: 'on-failure',
};

function liveState(action, overrides = {}) {
  const active = action === 'start' || action === 'disable';
  const enabled = action !== 'disable';
  return {
    releaseId,
    serviceName: 'yunpanel-node-0123456789abcdef.service',
    action,
    port: runtime.port,
    healthPath: runtime.healthPath,
    loadState: 'loaded',
    activeState: active ? 'active' : 'inactive',
    subState: active ? 'running' : 'dead',
    unitFileState: enabled ? 'enabled' : 'disabled',
    mainPid: active ? 42 : 0,
    enabled,
    active,
    healthy: active,
    ...overrides,
  };
}

function fixture(action, { state = liveState(action), activeRuntime = runtime, consumersActive = false } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob() { events.push('get'); return { id: jobId, serverId, status, operation: OPERATIONS.APP_NODE_PROCESS, resourceType: 'application', resourceId: applicationId }; },
    async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
    async complete(input) { events.push('complete'); status = input.status; return { id: jobId, serverId, status, operation: OPERATIONS.APP_NODE_PROCESS, resourceType: 'application', resourceId: applicationId, result: input.result }; },
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
          return { id: applicationId, serverId, type: 'node', state: 'active', activeDeploymentId: null, currentReleaseId: releaseId, activeRuntime };
        },
      },
      serviceStatus: async () => ({ apiActive: consumersActive, agentActive: false }),
      inspect: async () => ({ jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.APP_NODE_PROCESS, resourceType: 'application', resourceId: applicationId }] }),
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation: OPERATIONS.APP_NODE_PROCESS, resourceType: 'application', resourceId: applicationId, payload: { applicationId, releaseId, runtime, action } };
      },
      inspectNodeProcess: async () => { events.push('process'); return state; },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true, error: null }; },
    },
  };
}

test('Node process recovery accepts only the requested idempotent final state', async () => {
  for (const action of ['enable', 'disable', 'start', 'stop']) {
    const fx = fixture(action);
    const result = await recoverRunningNodeProcess(fx.options);
    assert.equal(result.action, action);
    assert.equal(result.recoveryMethod, 'verified_node_process_state');
    assert.deepEqual(fx.events, ['get', 'context', 'application', 'process', 'begin', 'complete', 'reconcile', 'ack']);
  }
});

test('Node process recovery leaves an unproven final state unresolved', async () => {
  const fx = fixture('start', { state: liveState('start', { healthy: false }) });
  await assert.rejects(recoverRunningNodeProcess(fx.options), { code: 'job_node_process_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'application', 'process']);

  const failedStop = fixture('stop', { state: liveState('stop', { activeState: 'failed' }) });
  await assert.rejects(recoverRunningNodeProcess(failedStop.options), { code: 'job_node_process_recovery_evidence_not_satisfied' });
});

test('Node process recovery rejects desired/active runtime drift and active job consumers', async () => {
  const drift = fixture('stop', { activeRuntime: { ...runtime, mode: 'development' } });
  await assert.rejects(recoverRunningNodeProcess(drift.options), { code: 'job_node_process_recovery_application_mismatch' });
  assert.deepEqual(drift.events, ['get', 'context', 'application']);

  const active = fixture('stop', { consumersActive: true });
  await assert.rejects(recoverRunningNodeProcess(active.options), { code: 'job_node_process_recovery_consumers_must_be_stopped' });
  assert.deepEqual(active.events, []);
});
