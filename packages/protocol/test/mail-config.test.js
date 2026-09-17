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

function rollbackPayload(overrides = {}) {
  return {
    mailDomainId: MAIL_DOMAIN_ID,
    sourceApplyJobId: 'mail-job-0001',
    previousRevision: 2,
    expectedCurrentRevision: 3,
    currentStatus: 'enabled',
    targetStatus: 'disabled',
    currentConfigurationSha256: DIGEST_A,
    sourcePlanSha256: DIGEST_B,
    backupSha256: 'c'.repeat(64),
    previewDigest: 'd'.repeat(64),
    ...overrides,
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

test('managed mail rollback is bound to one source apply, backup and current state', () => {
  assert.equal(OPERATIONS.MAIL_CONFIG_ROLLBACK, 'mail.config.rollback');
  assert.equal(isKnownOperation(OPERATIONS.MAIL_CONFIG_ROLLBACK), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.MAIL_CONFIG_ROLLBACK), false);
  const created = createOperationEnvelope({
    id: 'mail-rollback-0001',
    operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
    payload: rollbackPayload(),
  });
  assert.deepEqual(validateOperationEnvelope(created), { ok: true, errors: [] });
  assert.doesNotMatch(JSON.stringify(created), /password|argon2|content|path/i);
});

test('managed mail rollback rejects stale revision math, malformed digests and expanded payloads', () => {
  for (const payload of [
    rollbackPayload({ sourceApplyJobId: 'short' }),
    rollbackPayload({ expectedCurrentRevision: 2 }),
    rollbackPayload({ currentStatus: 'ready' }),
    rollbackPayload({ backupSha256: 'short' }),
    rollbackPayload({ backupPath: '/forbidden' }),
  ]) {
    assert.equal(validateOperationEnvelope({
      id: 'mail-rollback-0001',
      operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
      payload,
      protocolVersion: AGENT_PROTOCOL_VERSION,
    }).ok, false);
  }

  const reconfigure = rollbackPayload({
    previousRevision: 4,
    expectedCurrentRevision: 4,
    currentStatus: 'enabled',
    targetStatus: 'enabled',
  });
  assert.equal(validateOperationEnvelope({
    id: 'mail-rollback-0002',
    operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
    payload: reconfigure,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  }).ok, true);
});
