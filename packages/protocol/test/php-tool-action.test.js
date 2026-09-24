import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  validateOperationEnvelope,
} from '../src/index-node-passenger.js';

const payload = Object.freeze({
  websiteId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  unixUser: 'yunapp-123456789abc',
  expectedWebsiteRevision: 4,
  actorSessionId: '44444444-4444-4444-8444-444444444444',
  actorUserId: '55555555-5555-4555-8555-555555555555',
  actorRole: 'site_manager',
  actionId: 'wp.cache.flush',
  previewDigest: 'a'.repeat(64),
  confirmation: `php-tool:11111111-1111-4111-8111-111111111111:wp.cache.flush:${'a'.repeat(64)}`,
});

test('website.php.action accepts only reviewed pinned metadata', () => {
  const envelope = createOperationEnvelope({ id: 'php-action-job-01', operation: OPERATIONS.WEBSITE_PHP_ACTION, payload });
  assert.equal(envelope.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.deepEqual(envelope.payload, payload);
  assert.equal(validateOperationEnvelope(envelope).ok, true);
});

for (const patch of [
  { websiteId: 'bad' },
  { applicationId: 'bad' },
  { unixUser: 'root' },
  { expectedWebsiteRevision: 0 },
  { actorSessionId: 'bad' },
  { actorUserId: 'bad' },
  { actorRole: 'read_only' },
  { actionId: 'plugin.update-all' },
  { previewDigest: 'short' },
  { confirmation: 'wrong' },
  { extra: true },
]) {
  test(`website.php.action rejects ${Object.keys(patch)[0]}`, () => {
    const validation = validateOperationEnvelope({
      id: 'php-action-job-02',
      operation: OPERATIONS.WEBSITE_PHP_ACTION,
      payload: { ...payload, ...patch },
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    assert.equal(validation.ok, false);
  });
}
