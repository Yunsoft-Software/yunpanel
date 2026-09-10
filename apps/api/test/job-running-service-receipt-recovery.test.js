import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningServiceReceiptMutation } from '../src/job-running-service-receipt-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

function activeState() {
  return {
    id: 'nginx',
    installed: true,
    active: true,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled',
      inspectionError: false,
    }],
  };
}

function fixture({ operation = OPERATIONS.SYSTEM_SERVICE_INSTALL, action = null, receipt = undefined, snapshot = undefined } = {}) {
  const events = [];
  let status = 'running';
  const serviceId = 'nginx';
  const defaultReceipt = operation === OPERATIONS.SYSTEM_SERVICE_INSTALL
    ? { serverId, jobId, operation, serviceId, action: null, changed: true }
    : { serverId, jobId, operation, serviceId, action: 'restart', changed: null };
  const payload = operation === OPERATIONS.SYSTEM_SERVICE_INSTALL
    ? { serviceId }
    : { serviceId, action };
  const jobRegistry = {
    async getJob() {
      events.push('get');
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
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation, resourceType: 'system', resourceId: serverId, payload };
      },
      readMutationReceipt: async () => {
        events.push('receipt');
        return receipt === undefined ? defaultReceipt : receipt;
      },
      inspectServiceState: async () => {
        events.push('evidence');
        return snapshot === undefined ? activeState() : snapshot;
      },
      reconcile: async () => {
        events.push('reconcile');
        return { reconciled: true, error: null };
      },
    },
  };
}

for (const input of [
  { operation: OPERATIONS.SYSTEM_SERVICE_INSTALL, action: null },
  { operation: OPERATIONS.SYSTEM_SERVICE_CONTROL, action: 'restart' },
]) {
  test(`receipt-backed recovery completes ${input.operation}${input.action ? `:${input.action}` : ''}`, async () => {
    const fx = fixture(input);
    const result = await recoverRunningServiceReceiptMutation(fx.options);
    assert.equal(result.recoveryMethod, 'verified_managed_service_receipt_and_state');
    assert.equal(result.action, input.action);
    assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
  });
}

test('missing receipt leaves service mutation unresolved before host inspection', async () => {
  const fx = fixture({ receipt: null });
  await assert.rejects(recoverRunningServiceReceiptMutation(fx.options), { code: 'job_service_receipt_recovery_receipt_missing' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt']);
});

test('receipt cannot override current unhealthy or inactive service state', async () => {
  const state = activeState();
  state.active = false;
  state.units[0] = { ...state.units[0], activeState: 'inactive', subState: 'dead' };
  const fx = fixture({ snapshot: state });
  await assert.rejects(recoverRunningServiceReceiptMutation(fx.options), { code: 'job_service_receipt_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'evidence']);
});

test('start and stop controls cannot use receipt-backed restart recovery', async () => {
  for (const action of ['start', 'stop']) {
    const fx = fixture({ operation: OPERATIONS.SYSTEM_SERVICE_CONTROL, action });
    await assert.rejects(recoverRunningServiceReceiptMutation(fx.options), { code: 'job_service_receipt_recovery_operation_unsupported' });
    assert.deepEqual(fx.events, ['get', 'context']);
  }
});
