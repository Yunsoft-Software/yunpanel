import assert from 'node:assert/strict';
import test from 'node:test';
import { provisioningClientInternals } from '../src/workspace/provisioning-client.js';
import {
  canContinueProvisioning,
  provisioningBadgeState,
  provisioningOperationLabel,
  provisioningStepLabel,
  provisioningStepStateLabel,
} from '../src/workspace/provisioning-model.js';

const operationId = '9AE512C0-A717-4611-943C-6CE2AB0ABF16';

test('provisioning client builds exact operation and step-bound confirmations', () => {
  assert.equal(
    provisioningClientInternals.continueConfirmation(operationId),
    'continue-site-provisioning:9ae512c0-a717-4611-943c-6ce2ab0abf16',
  );
  assert.equal(
    provisioningClientInternals.retryConfirmation(operationId, 'unix_identity'),
    'retry-site-provisioning:9ae512c0-a717-4611-943c-6ce2ab0abf16:unix_identity',
  );
  assert.equal(
    provisioningClientInternals.compensationConfirmation(operationId, 'nginx'),
    'compensate-site-provisioning:9ae512c0-a717-4611-943c-6ce2ab0abf16:nginx',
  );
});

test('provisioning client rejects malformed operation and step identifiers', () => {
  assert.throws(() => provisioningClientInternals.continueConfirmation('../bad'));
  assert.throws(() => provisioningClientInternals.retryConfirmation(operationId, '../runtime'));
  assert.throws(() => provisioningClientInternals.compensationConfirmation(operationId, 'Runtime'));
});

test('provisioning continuation stays fail-closed around terminal remediation states', () => {
  assert.equal(canContinueProvisioning({
    ready: false,
    steps: [{ required: true, state: 'pending' }],
  }), true);
  assert.equal(canContinueProvisioning({
    ready: false,
    steps: [{ required: true, state: 'blocked' }],
  }), true);
  assert.equal(canContinueProvisioning({
    ready: false,
    steps: [{ required: true, state: 'failed' }, { required: true, state: 'pending' }],
  }), false);
  assert.equal(canContinueProvisioning({
    ready: false,
    steps: [{ required: true, state: 'compensated' }, { required: true, state: 'pending' }],
  }), false);
  assert.equal(canContinueProvisioning({ ready: true, steps: [] }), false);
});

test('provisioning presentation maps durable states without exposing host evidence', () => {
  const step = { id: 'unix_identity', kind: 'unix_identity', state: 'blocked' };
  assert.equal(provisioningStepLabel(step), 'Site kullanıcısı');
  assert.equal(provisioningStepStateLabel(step), 'Müdahale gerekli');
  assert.equal(provisioningBadgeState(step), 'warning');
  assert.equal(provisioningOperationLabel({ ready: false, steps: [step] }), 'Bloke');
  assert.equal(provisioningOperationLabel({ ready: true, steps: [step] }), 'Hazır');
});
