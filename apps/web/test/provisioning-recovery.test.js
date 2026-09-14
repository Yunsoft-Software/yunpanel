import assert from 'node:assert/strict';
import test from 'node:test';
import { provisioningClientInternals } from '../src/workspace/provisioning-client.js';
import {
  canContinueProvisioning,
  provisioningBadgeState,
  provisioningOperationLabel,
  provisioningRemediation,
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

test('provisioning remediation is handler-specific and fail-closed', () => {
  assert.equal(provisioningRemediation({ kind: 'unix_identity', state: 'pending' }), null);
  assert.match(
    provisioningRemediation({ kind: 'unix_identity', state: 'failed', error: 'website_identity_partial_state' }),
    /UID\/GID ownership/,
  );
  assert.match(
    provisioningRemediation({ kind: 'runtime', state: 'blocked', error: 'static_runtime_provisioning_pending' }),
    /Static runtime provisioning/,
  );
  assert.match(
    provisioningRemediation({ kind: 'nginx', state: 'compensating' }),
    /vhost\/checksum/,
  );
  assert.match(
    provisioningRemediation({ kind: 'future_adapter', state: 'failed' }),
    /körlemesine tekrar etmeyin/,
  );
});
