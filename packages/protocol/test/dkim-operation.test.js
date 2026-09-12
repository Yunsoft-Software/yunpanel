import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  isReadOnlyOperation,
  validateOperationEnvelope,
} from '../src/index-extended.js';

const payload = Object.freeze({
  mailDomainId: randomUUID(),
  expectedKeyRevision: 1,
  previewDigest: 'a'.repeat(64),
  configurationSha256: 'b'.repeat(64),
});

test('managed DKIM apply is a known mutation with exact validated payload', () => {
  assert.equal(OPERATIONS.MAIL_DKIM_APPLY, 'mail.dkim.apply');
  assert.equal(isKnownOperation(OPERATIONS.MAIL_DKIM_APPLY), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.MAIL_DKIM_APPLY), false);
  const envelope = createOperationEnvelope({
    id: 'mail-dkim-job-0001',
    operation: OPERATIONS.MAIL_DKIM_APPLY,
    payload,
  });
  assert.deepEqual(envelope, {
    id: 'mail-dkim-job-0001',
    operation: 'mail.dkim.apply',
    payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
});

test('managed DKIM apply rejects hidden fields, stale shapes and bad digests', () => {
  for (const invalid of [
    { ...payload, privateKey: 'no' },
    { ...payload, expectedKeyRevision: 0 },
    { ...payload, mailDomainId: 'not-a-uuid' },
    { ...payload, previewDigest: 'short' },
    { ...payload, configurationSha256: 'z'.repeat(64) },
  ]) {
    const result = validateOperationEnvelope({
      id: 'mail-dkim-job-0002',
      operation: OPERATIONS.MAIL_DKIM_APPLY,
      payload: invalid,
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

test('existing protocol operations continue to delegate to the baseline validator', () => {
  const result = validateOperationEnvelope({
    id: 'server-inspect-001',
    operation: OPERATIONS.SERVER_INSPECT,
    payload: {},
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(result.ok, true);
});
