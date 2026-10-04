import assert from 'node:assert/strict';
import test from 'node:test';
import { createProvisioningRecovery } from '../src/workspace/provisioning-recovery.js';

test('optional compensation can succeed while required provisioning remains ready', async () => {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const required = { id: 'nginx', kind: 'nginx', state: 'succeeded', required: true, canRetry: false,
    canCompensate: false, compensation: { state: 'not_required' } };
  const optional = { id: 'extra', kind: 'runtime', state: 'succeeded', required: false, canRetry: false,
    canCompensate: true, compensation: { state: 'pending' } };
  const initial = { operationId, websiteId, ready: true, steps: [required, optional] };
  const operation = { ...initial, steps: [required, { ...optional, state: 'compensated', canCompensate: false, compensation: { state: 'succeeded' } }] };
  const flow = createProvisioningRecovery({ websiteId, canManage: () => true, read: async () => initial,
    execute: async () => ({ operationId, stepId: 'extra', outcome: 'compensated', operation }),
  });
  await flow.load();
  const approval = flow.prepare('compensate', 'extra');
  const state = await flow.perform(approval, approval.confirmation);
  assert.equal(state.status, 'ready'); assert.equal(state.error, null);
  assert.equal(state.operation.ready, true); assert.match(state.notice, /geri alındı/);
  assert.deepEqual(state.operation.progress, { required: 1, completed: 1, remaining: 0 });
});

test('optional compensation failure preserves required provisioning readiness but exposes error notice', async () => {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const required = { id: 'nginx', kind: 'nginx', state: 'succeeded', required: true, canRetry: false,
    canCompensate: false, compensation: { state: 'not_required' } };
  const optional = { id: 'extra', kind: 'runtime', state: 'succeeded', required: false, canRetry: false,
    canCompensate: true, compensation: { state: 'pending' } };
  const initial = { operationId, websiteId, ready: true, steps: [required, optional] };
  const failedCompOperation = { ...initial, steps: [required, { ...optional, compensation: { state: 'failed', error: 'cleanup_failed' } }] };
  const flow = createProvisioningRecovery({ websiteId, canManage: () => true, read: async () => initial,
    execute: async () => ({ operationId, stepId: 'extra', outcome: 'compensation_failed', operation: failedCompOperation }),
  });
  await flow.load();
  const approval = flow.prepare('compensate', 'extra');
  const state = await flow.perform(approval, approval.confirmation);
  assert.equal(state.status, 'ready');
  assert.match(state.error, /Kurulum tamamlanmadı/);
  assert.equal(state.notice, null);
  assert.equal(state.operation.ready, true);
  assert.deepEqual(state.operation.progress, { required: 1, completed: 1, remaining: 0 });
});

test('optional step without compensation capability rejects prepare call', async () => {
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const required = { id: 'nginx', kind: 'nginx', state: 'succeeded', required: true, canRetry: false,
    canCompensate: false, compensation: { state: 'not_required' } };
  const optional = { id: 'extra', kind: 'runtime', state: 'succeeded', required: false, canRetry: false,
    canCompensate: false, compensation: { state: 'not_required' } };
  const initial = { operationId, websiteId, ready: true, steps: [required, optional] };
  const flow = createProvisioningRecovery({ websiteId, canManage: () => true, read: async () => initial, execute: async () => ({}) });
  await flow.load();
  const approval = flow.prepare('compensate', 'extra');
  assert.equal(approval, null);
});
