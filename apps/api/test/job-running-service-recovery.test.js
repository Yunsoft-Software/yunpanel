import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  JobRunningServiceRecoveryError,
  recoverRunningServiceControl,
} from '../src/job-running-service-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

function serviceState({ active }) {
  return {
    id: 'nginx',
    label: 'Nginx',
    category: 'web',
    installed: true,
    active,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: active ? 'active' : 'inactive',
      subState: active ? 'running' : 'dead',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
  };
}

function fixture({ action = 'start', operation = OPERATIONS.SYSTEM_SERVICE_CONTROL, snapshot = null } = {}) {
  const events = [];
  let status = 'running';
  const effectiveSnapshot = snapshot ?? serviceState({ active: action === 'start' });
  const jobRegistry = {
    async getJob(id) {
      events.push('get');
      assert.equal(id, jobId);
      return { id: jobId, serverId, status, operation, resourceType: 'system', resourceId: serverId };
    },
    async beginReconciliation(identity) {
      events.push('begin');
      return { ...identity, status: 'running', pending: true };
    },
    async complete(input) {
      events.push('complete');
      status = input.status;
      return { id: jobId, serverId, status, operation, resourceType: 'system', resourceId: serverId, result: input.result };
    },
    async acknowledgeReconciliation(identity) {
      events.push('ack');
      return { ...identity, status: 'succeeded', acknowledged: true };
    },
  };

  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation, resourceType: 'system', resourceId: serverId }],
      }),
      loadJobContext: async (id) => {
        events.push('context');
        return {
          id,
          serverId,
          status: 'running',
          operation,
          resourceType: 'system',
          resourceId: serverId,
          payload: { serviceId: 'nginx', action },
        };
      },
      inspectServiceState: async (serviceId) => {
        events.push('evidence');
        assert.equal(serviceId, 'nginx');
        return effectiveSnapshot;
      },
      reconcile: async () => {
        events.push('reconcile');
        return { reconciled: true, error: null };
      },
    },
  };
}

for (const action of ['start', 'stop']) {
  test(`managed service ${action} recovery verifies host state before journaling`, async () => {
    const fx = fixture({ action });
    const result = await recoverRunningServiceControl(fx.options);
    assert.equal(result.action, action);
    assert.equal(result.recoveryMethod, 'verified_managed_service_state');
    assert.deepEqual(fx.events, ['get', 'context', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
  });
}

test('wrong final service state leaves the running job untouched', async () => {
  const fx = fixture({ action: 'stop', snapshot: serviceState({ active: true }) });
  await assert.rejects(
    recoverRunningServiceControl(fx.options),
    (error) => error instanceof JobRunningServiceRecoveryError
      && error.code === 'job_service_recovery_evidence_not_satisfied',
  );
  assert.deepEqual(fx.events, ['get', 'context', 'evidence']);
});

test('restart and install cannot enter final-state service control recovery', async () => {
  const restart = fixture({ action: 'restart' });
  await assert.rejects(recoverRunningServiceControl(restart.options), { code: 'job_service_recovery_context_mismatch' });
  assert.deepEqual(restart.events, ['get', 'context']);

  const install = fixture({ operation: OPERATIONS.SYSTEM_SERVICE_INSTALL });
  await assert.rejects(recoverRunningServiceControl(install.options), { code: 'job_service_recovery_job_mismatch' });
  assert.deepEqual(install.events, []);
});

test('ambiguous or failed unit inspection does not expose raw host errors', async () => {
  const snapshot = serviceState({ active: false });
  snapshot.units[0] = { ...snapshot.units[0], inspectionError: true, rawOutput: '/private/systemd TOKEN=hidden' };
  const fx = fixture({ action: 'stop', snapshot });
  await assert.rejects(
    recoverRunningServiceControl(fx.options),
    (error) => error instanceof JobRunningServiceRecoveryError
      && error.code === 'job_service_recovery_evidence_invalid'
      && !error.message.includes('/private')
      && !error.message.includes('hidden'),
  );
  assert.deepEqual(fx.events, ['get', 'context', 'evidence']);
});
