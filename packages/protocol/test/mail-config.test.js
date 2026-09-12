import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  isReadOnlyOperation,
  validateOperationEnvelope,
} from '../src/index.js';

const MAIL_DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function envelope(payload) {
  return {
    id: 'mail-job-0001',
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  };
}

test('managed mail apply is an explicit mutating operation with a secret-free payload', () => {
  assert.equal(OPERATIONS.MAIL_CONFIG_APPLY, 'mail.config.apply');
  assert.equal(isKnownOperation(OPERATIONS.MAIL_CONFIG_APPLY), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.MAIL_CONFIG_APPLY), false);

  const created = createOperationEnvelope({
    id: 'mail-job-0001',
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    payload: {
      mailDomainId: MAIL_DOMAIN_ID,
      expectedRevision: 2,
      desiredStatus: 'enabled',
      previewDigest: DIGEST_A,
      configurationSha256: DIGEST_B,
    },
  });
  assert.deepEqual(validateOperationEnvelope(created), { ok: true, errors: [] });
  assert.equal(JSON.stringify(created).includes('password'), false);
  assert.equal(JSON.stringify(created).includes('argon2'), false);
});

test('managed mail apply rejects unsupported fields and malformed transition identity', () => {
  for (const payload of [
    {
      mailDomainId: 'not-a-uuid', expectedRevision: 2, desiredStatus: 'enabled',
      previewDigest: DIGEST_A, configurationSha256: DIGEST_B,
    },
    {
      mailDomainId: MAIL_DOMAIN_ID, expectedRevision: 0, desiredStatus: 'enabled',
      previewDigest: DIGEST_A, configurationSha256: DIGEST_B,
    },
    {
      mailDomainId: MAIL_DOMAIN_ID, expectedRevision: 2, desiredStatus: 'ready',
      previewDigest: DIGEST_A, configurationSha256: DIGEST_B,
    },
    {
      mailDomainId: MAIL_DOMAIN_ID, expectedRevision: 2, desiredStatus: 'disabled',
      previewDigest: 'short', configurationSha256: DIGEST_B,
    },
    {
      mailDomainId: MAIL_DOMAIN_ID, expectedRevision: 2, desiredStatus: 'enabled',
      previewDigest: DIGEST_A, configurationSha256: DIGEST_B, passwordHash: 'forbidden',
    },
  ]) {
    assert.equal(validateOperationEnvelope(envelope(payload)).ok, false);
  }
});
