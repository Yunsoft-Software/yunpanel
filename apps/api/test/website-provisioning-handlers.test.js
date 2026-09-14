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
const identityIntent = Object.freeze({
  websiteId,
  unixUser,
  homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
});
const passengerIntent = Object.freeze({
  adapter: 'passenger',
  applicationId,
  websiteId,
  nodeMajor: 24,
  nodeCandidates: [`/opt/yunpanel/node-runtimes/v24/bin/node`, '/usr/bin/node'],
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  startMode: 'node',
  appEnv: 'production',
  unixUser,
  healthPath: '/health',
  healthTimeoutSeconds: 30,
});
const nginxIntent = Object.freeze({
  websiteId,
  primaryDomain: 'example.com',
  aliases: ['www.example.com'],
  targetType: 'passenger',
  target: passengerIntent,
});

function identityManager() {
  return {
    apply: async () => ({ satisfied: true, uid: 1201, gid: 1201, created: true }),
    inspect: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
    compensate: async () => ({ satisfied: true, removedUser: true }),
    inspectCompensation: async () => ({ satisfied: true, removedUser: true }),
  };
}

function passengerSiteManager() {
  return {
    apply: async () => ({ satisfied: true, adapter: 'passenger' }),
    inspect: async () => ({ satisfied: true, adapter: 'passenger' }),
  };
}

function nginxManager() {
  return {
    stageDomain: async () => ({ configName: 'yunpanel-example.com.conf', checksum: 'a'.repeat(64), bytes: 500 }),
    inspectStagedDomain: async () => ({
      satisfied: true,
      result: { configName: 'yunpanel-example.com.conf', checksum: 'a'.repeat(64), bytes: 500 },
    }),
    inspectActiveDomain: async () => ({
      satisfied: true,
      result: { configName: 'yunpanel-example.com.conf', checksum: 'a'.repeat(64), active: true },
    }),
    activateDomain: async () => ({ configName: 'yunpanel-example.com.conf', checksum: 'a'.repeat(64), active: true }),
    compensateDomain: async (input) => ({ satisfied: true, ...input, restoredPrevious: false }),
    inspectDomainCompensation: async (input) => ({ satisfied: true, ...input, restoredPrevious: false }),
  };
}

function passengerOperation() {
  return {
    steps: [
      {
        id: 'runtime',
        state: 'succeeded',
        evidence: {
          satisfied: true,
          adapter: 'passenger',
          applicationId,
          releaseId: '3854e385-adfc-42bd-bccf-f655f24cd68f',
          nodeMajor: 24,
          nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
          nodeVersion: 'v24.11.1',
          appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
          documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
          startupFile: 'server.js',
          unixUser,
          passengerVersion: '6.0.27-1~noble1',
        },
      },
    ],
  };
}

test('identity handler binds durable operation and bounded identity fields to host runtime', async () => {
  const calls = [];
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: {
      apply: async (input, options) => {
        calls.push(['apply', input, options]);
        return { satisfied: true, uid: 1201, gid: 1201, created: true };
      },
      inspect: async (input) => {
        calls.push(['inspect', input]);
        return { satisfied: true, uid: 1201, gid: 1201 };
      },
      compensate: async (input, options) => {
        calls.push(['compensate', input, options]);
        return { satisfied: true, removedUser: true };
      },
      inspectCompensation: async (input, options) => {
        calls.push(['inspect-compensation', input, options]);
        return { satisfied: true, removedUser: true };
      },
    },
    passengerSiteManager: passengerSiteManager(),
    nginxManager: nginxManager(),
  });
  const evidence = { satisfied: true, uid: 1201, gid: 1201, created: true };

  const applied = await handlers.unix_identity.apply({ intent: identityIntent, operationId });
  const inspected = await handlers.unix_identity.inspect({ intent: identityIntent, operationId });
  const compensated = await handlers.unix_identity.compensate({ intent: identityIntent, operationId, evidence });
  const compensationInspection = await handlers.unix_identity.inspectCompensation({ intent: identityIntent, operationId, evidence });

  assert.equal(applied.created, true);
  assert.equal(inspected.satisfied, true);
  assert.equal(compensated.satisfied, true);
  assert.equal(compensationInspection.satisfied, true);
  const bounded = { user: identityIntent.unixUser, homeDirectory: identityIntent.homeDirectory };
  assert.deepEqual(calls, [
    ['apply', bounded, { operationId }],
    ['inspect', bounded],
    ['compensate', bounded, { operationId, evidence }],
    ['inspect-compensation', bounded, { operationId, evidence }],
  ]);
});

test('identity handler rejects incomplete orchestration intent before host mutation', async () => {
  let calls = 0;
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: {
      apply: async () => { calls += 1; return {}; },
      inspect: async () => { calls += 1; return {}; },
      compensate: async () => { calls += 1; return {}; },
      inspectCompensation: async () => { calls += 1; return {}; },
    },
    passengerSiteManager: passengerSiteManager(),
    nginxManager: nginxManager(),
  });

  await assert.rejects(
    handlers.unix_identity.apply({ intent: { unixUser: identityIntent.unixUser }, operationId }),
    (error) => error instanceof WebsiteProvisioningHandlerError && error.code === 'website_identity_intent_invalid',
  );
  assert.equal(calls, 0);
});

test('Passenger runtime handler delegates exact orchestration intent to host runtime', async () => {
  const calls = [];
  const passenger = {
    apply: async (input) => { calls.push(['apply', input]); return { satisfied: true, adapter: 'passenger', nodeBinary: input.nodeCandidates[0] }; },
    inspect: async (input) => { calls.push(['inspect', input]); return { satisfied: true, adapter: 'passenger', nodeBinary: input.nodeCandidates[0] }; },
  };
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passenger,
    nginxManager: nginxManager(),
  });

  await handlers.runtime.apply({ intent: passengerIntent });
  await handlers.runtime.inspect({ intent: passengerIntent });
  assert.deepEqual(calls, [
    ['apply', passengerIntent],
    ['inspect', passengerIntent],
  ]);
});

test('static runtime remains explicitly blocked instead of being declared ready', async () => {
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    nginxManager: nginxManager(),
  });
  const result = await handlers.runtime.apply({
    intent: { adapter: 'static', applicationId, websiteId },
  });
  assert.deepEqual(result, {
    satisfied: false,
    reason: 'static_runtime_provisioning_pending',
    adapter: 'static',
    applicationId,
  });
});

test('Passenger Nginx handler activates only with succeeded runtime evidence', async () => {
  const calls = [];
  const manager = nginxManager();
  manager.stageDomain = async (spec) => {
    calls.push(['stage', spec]);
    return { configName: 'yunpanel-example.com.conf', checksum: 'b'.repeat(64), bytes: 640 };
  };
  manager.activateDomain = async (input) => {
    calls.push(['activate', input]);
    return { configName: 'yunpanel-example.com.conf', checksum: 'b'.repeat(64), active: true };
  };
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    nginxManager: manager,
  });

  const result = await handlers.nginx.apply({ operation: passengerOperation(), intent: nginxIntent });
  assert.equal(result.satisfied, true);
  assert.equal(result.checksum, 'b'.repeat(64));
  assert.equal(calls[0][1].target.nodeBinary, '/opt/yunpanel/node-runtimes/v24/bin/node');
  assert.equal(calls[0][1].target.user, unixUser);
  assert.equal(calls[0][1].target.group, unixUser);
  assert.deepEqual(calls[1], ['activate', { primaryDomain: 'example.com', checksum: 'b'.repeat(64) }]);
});

test('Passenger Nginx handler refuses activation without runtime evidence', async () => {
  let stageCalls = 0;
  const manager = nginxManager();
  manager.stageDomain = async () => { stageCalls += 1; return {}; };
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    nginxManager: manager,
  });

  await assert.rejects(
    handlers.nginx.apply({
      operation: { steps: [{ id: 'runtime', state: 'pending', evidence: null }] },
      intent: { websiteId, primaryDomain: 'example.com', aliases: [], targetType: 'passenger', target: passengerIntent },
    }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_passenger_runtime_evidence_missing',
  );
  assert.equal(stageCalls, 0);
});

test('Nginx inspection is read-only and requires staged plus active matching checksum', async () => {
  const calls = [];
  const manager = nginxManager();
  manager.stageDomain = async () => { calls.push('stage'); return {}; };
  manager.inspectStagedDomain = async (spec) => {
    calls.push(['inspect-stage', spec.primaryDomain]);
    return { satisfied: true, result: { configName: 'yunpanel-example.com.conf', checksum: 'c'.repeat(64), bytes: 400 } };
  };
  manager.inspectActiveDomain = async (input) => {
    calls.push(['inspect-active', input]);
    return { satisfied: true, result: { ...input, active: true } };
  };
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    nginxManager: manager,
  });

  const result = await handlers.nginx.inspect({
    operation: passengerOperation(),
    intent: nginxIntent,
  });
  assert.equal(result.satisfied, true);
  assert.equal(calls.some((entry) => entry === 'stage'), false);
  assert.deepEqual(calls[1], ['inspect-active', { primaryDomain: 'example.com', checksum: 'c'.repeat(64) }]);
});

test('Nginx compensation uses persisted step checksum without restaging or reapplying', async () => {
  const calls = [];
  const manager = nginxManager();
  manager.stageDomain = async () => { calls.push('stage'); return {}; };
  manager.inspectStagedDomain = async () => { calls.push('inspect-stage'); throw new Error('persisted evidence should avoid staging lookup'); };
  manager.compensateDomain = async (input) => {
    calls.push(['compensate', input]);
    return { satisfied: true, ...input, restoredPrevious: true };
  };
  manager.inspectDomainCompensation = async (input) => {
    calls.push(['inspect-compensation', input]);
    return { satisfied: true, ...input, restoredPrevious: true };
  };
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    nginxManager: manager,
  });
  const evidence = { satisfied: true, configName: 'yunpanel-example.com.conf', checksum: 'd'.repeat(64), active: true };

  const compensated = await handlers.nginx.compensate({
    operation: passengerOperation(),
    intent: nginxIntent,
    evidence,
  });
  const inspected = await handlers.nginx.inspectCompensation({
    operation: passengerOperation(),
    intent: nginxIntent,
    evidence,
  });
  assert.equal(compensated.satisfied, true);
  assert.equal(inspected.satisfied, true);
  assert.deepEqual(calls, [
    ['compensate', { primaryDomain: 'example.com', checksum: 'd'.repeat(64) }],
    ['inspect-compensation', { primaryDomain: 'example.com', checksum: 'd'.repeat(64) }],
  ]);
});

test('failed Nginx step can derive compensation target from deterministic staged evidence', async () => {
  const calls = [];
  const manager = nginxManager();
  manager.stageDomain = async () => { calls.push('stage'); return {}; };
  manager.inspectStagedDomain = async (spec) => {
    calls.push(['inspect-stage', spec.primaryDomain]);
    return { satisfied: true, result: { configName: 'yunpanel-example.com.conf', checksum: 'e'.repeat(64), bytes: 400 } };
  };
  manager.compensateDomain = async (input) => {
    calls.push(['compensate', input]);
    return { satisfied: true, ...input, restoredPrevious: false };
  };
  const handlers = createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    nginxManager: manager,
  });

  const result = await handlers.nginx.compensate({
    operation: passengerOperation(),
    intent: nginxIntent,
    evidence: null,
  });
  assert.equal(result.satisfied, true);
  assert.equal(calls.some((entry) => entry === 'stage'), false);
  assert.deepEqual(calls, [
    ['inspect-stage', 'example.com'],
    ['compensate', { primaryDomain: 'example.com', checksum: 'e'.repeat(64) }],
  ]);
});

test('handler factory fails closed when required manager contracts are incomplete', () => {
  assert.throws(
    () => createWebsiteProvisioningHandlers({
      identityManager: { apply: async () => ({}) },
      passengerSiteManager: passengerSiteManager(),
      nginxManager: nginxManager(),
    }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_provisioning_handler_dependencies_invalid',
  );
});
