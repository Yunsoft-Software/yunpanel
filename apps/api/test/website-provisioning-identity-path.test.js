import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteProvisioningHandlers,
  WebsiteProvisioningHandlerError,
} from '../src/website-provisioning-handlers.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = 'yunapp-0123456789ab';
const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;

function passengerSiteManager() {
  return {
    apply: async () => ({ satisfied: true }),
    inspect: async () => ({ satisfied: true }),
  };
}

function nginxManager() {
  return {
    stageDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64) }),
    inspectStagedDomain: async () => ({ satisfied: false, result: null }),
    inspectActiveDomain: async () => ({ satisfied: false, result: null }),
    activateDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64), active: true }),
    compensateDomain: async () => ({ satisfied: true }),
    inspectDomainCompensation: async () => ({ satisfied: true }),
  };
}

function recordingIdentityManager(calls) {
  return {
    apply: async (intent, options) => {
      calls.push(['apply', intent, options]);
      return { satisfied: true };
    },
    inspect: async (intent) => {
      calls.push(['inspect', intent]);
      return { satisfied: true };
    },
    compensate: async (intent, options) => {
      calls.push(['compensate', intent, options]);
      return { satisfied: true };
    },
    inspectCompensation: async (intent, options) => {
      calls.push(['inspectCompensation', intent, options]);
      return { satisfied: true };
    },
  };
}

function handlersFor(calls) {
  return createWebsiteProvisioningHandlers({
    identityManager: recordingIdentityManager(calls),
    passengerSiteManager: passengerSiteManager(),
    nginxManager: nginxManager(),
  });
}

test('new Website identity operations carry Website and Application scope into host runtime', async () => {
  const calls = [];
  const handlers = handlersFor(calls);
  const intent = {
    websiteId,
    applicationId,
    unixUser,
    homeDirectory,
    documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  };
  const evidence = { created: true };

  await handlers.unix_identity.apply({ intent, operationId });
  await handlers.unix_identity.inspect({ intent, operationId });
  await handlers.unix_identity.compensate({ intent, operationId, evidence });
  await handlers.unix_identity.inspectCompensation({ intent, operationId, evidence });

  const bounded = { user: unixUser, homeDirectory, websiteId, applicationId };
  assert.deepEqual(calls, [
    ['apply', bounded, { operationId }],
    ['inspect', bounded],
    ['compensate', bounded, { operationId, evidence }],
    ['inspectCompensation', bounded, { operationId, evidence }],
  ]);
});

test('legacy persisted identity operations remain compatible without inventing Application scope', async () => {
  const calls = [];
  const handlers = handlersFor(calls);
  const legacyIntent = {
    websiteId,
    unixUser,
    homeDirectory,
    documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  };

  await handlers.unix_identity.apply({ intent: legacyIntent, operationId });

  assert.deepEqual(calls, [[
    'apply',
    { user: unixUser, homeDirectory },
    { operationId },
  ]]);
});

test('path-bound identity scope rejects missing Website identity before host mutation', async () => {
  const calls = [];
  const handlers = handlersFor(calls);

  await assert.rejects(
    handlers.unix_identity.apply({
      intent: { applicationId, unixUser, homeDirectory },
      operationId,
    }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_identity_intent_invalid',
  );
  assert.deepEqual(calls, []);
});
