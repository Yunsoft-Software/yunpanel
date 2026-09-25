import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  validateOperationEnvelope,
} from '../src/index-extended.js';

const taskId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const applicationId = '32345678-1234-4234-8234-123456789012';
const unixUser = 'yunapp-0123456789ab';
const payload = Object.freeze({
  taskId,
  websiteId,
  applicationId,
  unixUser,
  expectedRevision: 2,
  desiredStateSha256: 'a'.repeat(64),
  authorizationMode: 'user',
  actorSessionId: '42345678-1234-4234-8234-123456789012',
  actorUserId: '52345678-1234-4234-8234-123456789012',
  actorRole: 'site_manager',
});

for (const operation of [OPERATIONS.CRON_APPLY, OPERATIONS.CRON_REMOVE]) {
  test(`${operation} accepts canonical pinned cron mutation metadata`, () => {
    const envelope = createOperationEnvelope({ id: 'cron-job-0001', operation, payload });
    assert.equal(envelope.protocolVersion, AGENT_PROTOCOL_VERSION);
    assert.deepEqual(envelope.payload, payload);
    assert.equal(validateOperationEnvelope(envelope).ok, true);
  });

  test(`${operation} rejects invalid identities, unixUser, revisions, digests and unsupported fields`, () => {
    for (const candidate of [
      { ...payload, taskId: 'bad' },
      { ...payload, websiteId: 'bad' },
      { ...payload, applicationId: 'bad' },
      { ...payload, unixUser: 'root' },
      { ...payload, unixUser: 'yunapp-invalid' },
      { ...payload, expectedRevision: 0 },
      { ...payload, expectedRevision: -1 },
      { ...payload, desiredStateSha256: 'short' },
      { ...payload, authorizationMode: 'invalid' },
      { ...payload, actorSessionId: 'bad' },
      { ...payload, actorUserId: 'bad' },
      { ...payload, actorRole: 'read_only' },
      { ...payload, extra: 'forbidden' },
    ]) {
      const validation = validateOperationEnvelope({
        id: 'cron-job-0002',
        operation,
        payload: candidate,
        protocolVersion: AGENT_PROTOCOL_VERSION,
      });
      assert.equal(validation.ok, false);
    }
  });
}


test('cron.remove accepts the explicit internal Website-removal authorization mode without actor fields', () => {
  const systemPayload = {
    taskId,
    websiteId,
    applicationId,
    unixUser,
    expectedRevision: 2,
    desiredStateSha256: 'a'.repeat(64),
    authorizationMode: 'system_removal',
  };
  const envelope = createOperationEnvelope({
    id: 'cron-job-system-remove',
    operation: OPERATIONS.CRON_REMOVE,
    payload: systemPayload,
  });
  assert.deepEqual(envelope.payload, systemPayload);
  assert.equal(validateOperationEnvelope(envelope).ok, true);
  assert.equal(validateOperationEnvelope({
    ...envelope,
    operation: OPERATIONS.CRON_APPLY,
  }).ok, false);
});
