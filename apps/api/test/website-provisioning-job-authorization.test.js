import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebsiteProvisioningJobAuthorizer,
  createWebsiteProvisioningLegacyJobGuard,
  normalizeWebsiteProvisioningJobAuthorization,
  websiteProvisioningJobAuthorization,
} from '../src/website-provisioning-job-authorization.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const actor = Object.freeze({
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'site_manager',
});

function scope(stepId = 'certificate') {
  return websiteProvisioningJobAuthorization({ operationId, websiteId, stepId });
}

function fixture({
  stepState = 'applying',
  websiteServerId = serverId,
  currentActor = actor,
  liveActor = actor,
} = {}) {
  const registry = {
    async get(id) {
      assert.equal(id, operationId);
      return {
        operationId,
        websiteId,
        terminalState: null,
        steps: [{ id: 'certificate', state: stepState }],
      };
    },
    async getActor(id) {
      assert.equal(id, operationId);
      return currentActor;
    },
  };
  const websiteRegistry = {
    async getWebsite(id) {
      assert.equal(id, websiteId);
      return { id: websiteId, serverId: websiteServerId };
    },
  };
  const calls = [];
  const authorizeActor = async (candidate, targetWebsiteId) => {
    calls.push([candidate, targetWebsiteId]);
    return liveActor;
  };
  return {
    calls,
    authorize: createWebsiteProvisioningJobAuthorizer({
      registry,
      websiteRegistry,
      authorizeActor,
      localServerId: serverId,
    }),
  };
}

test('provisioning child-job scope is stable and secret-free', () => {
  const value = scope();
  assert.deepEqual(value, {
    kind: 'website_provisioning',
    version: 1,
    operationId,
    websiteId,
    stepId: 'certificate',
  });
  assert.deepEqual(normalizeWebsiteProvisioningJobAuthorization(value), value);
  assert.equal(Object.hasOwn(value, 'sessionId'), false);
  assert.equal(Object.hasOwn(value, 'userId'), false);
});

test('worker authorizer requires live operation step, local Website and exact current session actor', async () => {
  const state = fixture();
  assert.equal(await state.authorize(scope()), true);
  assert.deepEqual(state.calls, [[actor, websiteId]]);
});

test('worker authorizer fails closed when provisioning work is no longer mutating', async () => {
  const state = fixture({ stepState: 'succeeded' });
  assert.equal(await state.authorize(scope()), false);
  assert.deepEqual(state.calls, []);
});

test('worker authorizer fails closed when Website locality or live actor drifts', async () => {
  const foreignWebsite = fixture({
    websiteServerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(await foreignWebsite.authorize(scope()), false);
  assert.deepEqual(foreignWebsite.calls, []);

  const revoked = fixture({ liveActor: null });
  assert.equal(await revoked.authorize(scope()), false);
  assert.equal(revoked.calls.length, 1);

  const rotatedElsewhere = fixture({
    liveActor: { ...actor, sessionId: '33333333-3333-4333-8333-333333333333' },
  });
  assert.equal(await rotatedElsewhere.authorize(scope()), false);
});

test('worker authorizer rejects invalid or mismatched scopes without consulting live auth', async () => {
  const state = fixture();
  assert.equal(await state.authorize({ kind: 'website_provisioning', version: 1 }), false);
  assert.deepEqual(state.calls, []);
  assert.equal(await state.authorize(scope('other_step')), false);
  assert.deepEqual(state.calls, []);
});

test('legacy guard quarantines provisioning-specific job types without trusting old queue state', async () => {
  let reads = 0;
  const guard = createWebsiteProvisioningLegacyJobGuard({
    registry: { async listInterrupted() { reads += 1; return []; } },
  });
  for (const type of [
    `website.ssl.issue:${operationId}`,
    `website.webmail.ssl.issue:${operationId}`,
    `website_mail_apply:${operationId}`,
    `website_mail_rollback:${operationId}`,
    `website_dkim_apply:${operationId}`,
    `website_dkim_cleanup:${operationId}`,
  ]) {
    assert.equal(await guard({
      operation: 'ssl.issue',
      type,
      serverId,
      resourceType: 'certificate',
      resourceId: 'certificate-1',
    }), true);
  }
  assert.equal(reads, 0);
});

test('legacy guard detects unscoped database and Roundcube jobs only against active provisioning steps', async () => {
  const active = [{
    operationId,
    websiteId,
    steps: [
      {
        id: 'database',
        kind: 'website_database',
        state: 'applying',
        intent: { serverId, databaseName: 'yp_example' },
      },
      {
        id: 'roundcube_mapping',
        kind: 'roundcube_mapping',
        state: 'compensating',
        intent: { serverId },
      },
    ],
  }];
  const guard = createWebsiteProvisioningLegacyJobGuard({
    registry: { async listInterrupted() { return active; } },
  });

  assert.equal(await guard({
    operation: 'database.create',
    type: 'database.create',
    serverId,
    resourceType: 'database',
    resourceId: 'yp_example',
  }), true);
  assert.equal(await guard({
    operation: 'database.credential.apply',
    type: 'database.credential.apply',
    serverId,
    resourceType: 'database',
    resourceId: 'yp_example',
  }), true);
  assert.equal(await guard({
    operation: 'roundcube.config.apply',
    type: 'roundcube.config.apply',
    serverId,
    resourceType: 'server',
    resourceId: serverId,
  }), true);
  assert.equal(await guard({
    operation: 'database.create',
    type: 'database.create',
    serverId,
    resourceType: 'database',
    resourceId: 'unrelated_database',
  }), false);
  assert.equal(await guard({
    operation: 'system.packages.inspect',
    type: 'system.packages.inspect',
    serverId,
    resourceType: 'system',
    resourceId: serverId,
  }), false);
});

test('legacy guard surfaces unreadable candidate provisioning state to the caller', async () => {
  const guard = createWebsiteProvisioningLegacyJobGuard({
    registry: { async listInterrupted() { throw new Error('unreadable'); } },
  });
  await assert.rejects(
    guard({
      operation: 'database.delete',
      type: 'database.delete',
      serverId,
      resourceType: 'database',
      resourceId: 'yp_example',
    }),
    /unreadable/,
  );
});
