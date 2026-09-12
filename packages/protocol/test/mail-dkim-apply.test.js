import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  isReadOnlyOperation,
  validateOperationEnvelope,
} from '../src/index-extended.js';

const mailDomainId = '85f4ca20-56df-4ecb-a335-384e67fd3ca0';
const payload = Object.freeze({
  mailDomainId,
  expectedKeyRevision: 1,
  previewDigest: 'a'.repeat(64),
  configurationSha256: 'b'.repeat(64),
});

test('mail.dkim.apply is a known mutation with an exact bounded payload', () => {
  assert.equal(OPERATIONS.MAIL_DKIM_APPLY, 'mail.dkim.apply');
  assert.equal(isKnownOperation(OPERATIONS.MAIL_DKIM_APPLY), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.MAIL_DKIM_APPLY), false);
  const envelope = createOperationEnvelope({
    id: 'mail-dkim-job-001',
    operation: OPERATIONS.MAIL_DKIM_APPLY,
    payload,
  });
  assert.deepEqual(envelope, {
    id: 'mail-dkim-job-001',
    operation: 'mail.dkim.apply',
    payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
});

test('DKIM operation rejects secret fields, stale-shaped revisions and malformed digests', () => {
  for (const invalid of [
    { ...payload, privateKey: 'secret' },
    { ...payload, expectedKeyRevision: 0 },
    { ...payload, previewDigest: 'bad' },
    { ...payload, configurationSha256: 'bad' },
    { ...payload, mailDomainId: mailDomainId.toUpperCase() },
  ]) {
    const result = validateOperationEnvelope({
      id: 'mail-dkim-job-002',
      operation: OPERATIONS.MAIL_DKIM_APPLY,
      payload: invalid,
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

test('existing protocol operations still delegate to the baseline v8 validator', () => {
  const envelope = createOperationEnvelope({
    id: 'database-inspect-001',
    operation: OPERATIONS.DATABASE_INSPECT,
    payload: {},
  });
  assert.equal(envelope.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
});
