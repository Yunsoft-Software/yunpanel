import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  validateOperationEnvelope,
} from '../src/index-extended.js';

const payload = Object.freeze({
  previewSha256: 'a'.repeat(64),
  configSha256: 'b'.repeat(64),
  fpmSha256: 'c'.repeat(64),
});

test('roundcube config apply is a known strict durable operation', () => {
  assert.equal(OPERATIONS.ROUNDCUBE_CONFIG_APPLY, 'roundcube.config.apply');
  assert.equal(isKnownOperation(OPERATIONS.ROUNDCUBE_CONFIG_APPLY), true);
  const envelope = createOperationEnvelope({
    id: 'roundcube-config-job-1',
    operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
    payload,
  });
  assert.deepEqual(envelope, {
    id: 'roundcube-config-job-1',
    operation: 'roundcube.config.apply',
    payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
});

test('roundcube config apply rejects stale shapes and invalid digests', () => {
  for (const invalidPayload of [
    { ...payload, arbitrary: true },
    { ...payload, previewSha256: 'x'.repeat(64) },
    { ...payload, configSha256: 'a'.repeat(63) },
    { ...payload, fpmSha256: null },
  ]) {
    const result = validateOperationEnvelope({
      id: 'roundcube-config-job-2',
      operation: OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
      payload: invalidPayload,
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    assert.equal(result.ok, false);
  }
});
