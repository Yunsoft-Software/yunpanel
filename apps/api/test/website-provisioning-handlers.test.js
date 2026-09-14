import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteProvisioningHandlers,
  WebsiteProvisioningHandlerError,
} from '../src/website-provisioning-handlers.js';

const intent = Object.freeze({
  websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
  unixUser: 'yunapp-0123456789ab',
  homeDirectory: '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76',
  documentRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current',
});

test('identity handler passes only bounded identity fields to host runtime', async () => {
  const calls = [];
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: {
      apply: async (input) => {
        calls.push(['apply', input]);
        return { satisfied: true, uid: 1201, gid: 1201 };
      },
      inspect: async (input) => {
        calls.push(['inspect', input]);
        return { satisfied: true, uid: 1201, gid: 1201 };
      },
    },
  });

  const applied = await handlers.unix_identity.apply({ intent });
  const inspected = await handlers.unix_identity.inspect({ intent });

  assert.deepEqual(applied, { satisfied: true, uid: 1201, gid: 1201 });
  assert.deepEqual(inspected, { satisfied: true, uid: 1201, gid: 1201 });
  assert.deepEqual(calls, [
    ['apply', { user: intent.unixUser, homeDirectory: intent.homeDirectory }],
    ['inspect', { user: intent.unixUser, homeDirectory: intent.homeDirectory }],
  ]);
});

test('identity handler rejects incomplete orchestration intent before host mutation', async () => {
  let calls = 0;
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: {
      apply: async () => { calls += 1; return {}; },
      inspect: async () => { calls += 1; return {}; },
    },
  });

  await assert.rejects(
    handlers.unix_identity.apply({ intent: { unixUser: intent.unixUser } }),
    (error) => error instanceof WebsiteProvisioningHandlerError && error.code === 'website_identity_intent_invalid',
  );
  assert.equal(calls, 0);
});

test('handler factory fails closed when identity manager contract is incomplete', () => {
  assert.throws(
    () => createWebsiteProvisioningHandlers({ identityManager: { apply: async () => ({}) } }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_provisioning_handler_dependencies_invalid',
  );
});
