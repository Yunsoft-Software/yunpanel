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

const selectivePayload = {
  ...payload,
  actionId: 'wp.toolkit',
  confirmation: `php-tool:${payload.websiteId}:wp.toolkit:${payload.previewDigest}`,
  targetApplicationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  targetWebsiteRevision: 2,
  secretRef: null,
  options: {
    action: 'selective_transfer', targetWebsiteId: 'bbbbbbbb-1111-4111-8111-111111111111',
    fileScopes: ['mu-plugins', 'plugins', 'themes'],
  },
};

function checkSelectivePayload(value) {
  return validateOperationEnvelope({
    id: 'wordpress-transfer', operation: OPERATIONS.WEBSITE_PHP_ACTION,
    protocolVersion: AGENT_PROTOCOL_VERSION, payload: value,
  }).ok;
}

test('selective WordPress transfer accepts a canonical envelope and nonempty scope subsets', () => {
  const envelope = createOperationEnvelope({
    id: 'wordpress-transfer', operation: OPERATIONS.WEBSITE_PHP_ACTION, payload: selectivePayload,
  });
  assert.deepEqual(envelope.payload, selectivePayload);
  assert.equal(checkSelectivePayload(envelope.payload), true);
  assert.equal(checkSelectivePayload({ ...selectivePayload, options: { ...selectivePayload.options, fileScopes: ['plugins'] } }), true);
});

test('selective WordPress transfer rejects unapproved file scopes, identities and extra data', () => {
  for (const fileScopes of [[], ['themes', 'plugins'], ['plugins', 'plugins'], ['uploads'], ['custom'], ['sql'], Array(1)]) {
    assert.equal(checkSelectivePayload({ ...selectivePayload, options: { ...selectivePayload.options, fileScopes } }), false);
  }
  for (const options of [
    { ...selectivePayload.options, includeUploads: false },
    { ...selectivePayload.options, targetWebsiteId: payload.websiteId },
    { ...selectivePayload.options, targetWebsiteId: selectivePayload.options.targetWebsiteId.toUpperCase() },
  ]) assert.equal(checkSelectivePayload({ ...selectivePayload, options }), false);
  for (const patch of [
    { targetWebsiteRevision: 0 }, { targetWebsiteRevision: 1.5 }, { targetApplicationId: payload.applicationId },
    { targetApplicationId: selectivePayload.targetApplicationId.toUpperCase() },
    { selectivePlanSha256: 'b'.repeat(64) }, { secretRef: payload.actorSessionId },
  ]) assert.equal(checkSelectivePayload({ ...selectivePayload, ...patch }), false);
  const { targetWebsiteRevision, targetApplicationId, ...withoutTarget } = selectivePayload;
  assert.equal(checkSelectivePayload({ ...withoutTarget, targetApplicationId }), false);
  assert.equal(checkSelectivePayload({ ...withoutTarget, targetWebsiteRevision }), false);
  assert.equal(checkSelectivePayload({ ...withoutTarget, options: { action: 'core.update' } }), true);
  assert.equal(checkSelectivePayload({ ...selectivePayload, options: { action: 'core.update' } }), false);
});
