import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  validateOperationEnvelope,
} from '../src/index-extended.js';

const credentialId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const payload = Object.freeze({
  databaseCredentialId: credentialId,
  databaseBindingId: bindingId,
  expectedCredentialRevision: 3,
  expectedBindingRevision: 1,
  desiredStateSha256: 'a'.repeat(64),
});

for (const operation of [OPERATIONS.DATABASE_CREDENTIAL_APPLY, OPERATIONS.DATABASE_CREDENTIAL_DELETE]) {
  test(`${operation} accepts only pinned secret-free desired-state metadata`, () => {
    const envelope = createOperationEnvelope({ id: 'database-credential-job-0001', operation, payload });
    assert.equal(envelope.protocolVersion, AGENT_PROTOCOL_VERSION);
    assert.deepEqual(envelope.payload, payload);
    assert.equal(validateOperationEnvelope(envelope).ok, true);
    assert.doesNotMatch(JSON.stringify(envelope), /password|ciphertext|privileges|siteUnixUser/);
  });

  test(`${operation} rejects stale identities, revisions, digests and extra secret fields`, () => {
    for (const candidate of [
      { ...payload, databaseCredentialId: 'bad' },
      { ...payload, expectedCredentialRevision: 0 },
      { ...payload, expectedBindingRevision: 0 },
      { ...payload, desiredStateSha256: 'bad' },
      { ...payload, password: 'forbidden' },
    ]) {
      const validation = validateOperationEnvelope({
        id: 'database-credential-job-0002',
        operation,
        payload: candidate,
        protocolVersion: AGENT_PROTOCOL_VERSION,
      });
      assert.equal(validation.ok, false);
    }
  });
}
