import assert from 'node:assert/strict';
import test from 'node:test';
import { websiteProvisioningIsolationInternals } from '../src/website-provisioning-handlers-isolation.js';

function baseRuntime({ satisfied = true } = {}) {
  const calls = [];
  return {
    calls,
    handler: {
      async apply(context) { calls.push(['apply', context]); return { satisfied, adapter: 'passenger', unixUser: 'yunapp-test' }; },
      async inspect(context) { calls.push(['inspect', context]); return { satisfied, adapter: 'passenger', unixUser: 'yunapp-test' }; },
    },
  };
}

function umask({ satisfied = true } = {}) {
  const calls = [];
  return {
    calls,
    manager: {
      async apply(runtime) { calls.push(['apply', runtime]); return satisfied ? { satisfied: true, umask: '0027' } : { satisfied: false }; },
      async inspect(runtime) { calls.push(['inspect', runtime]); return satisfied ? { satisfied: true, umask: '0027' } : { satisfied: false, reason: 'service_umask_not_effective' }; },
    },
  };
}

test('Passenger runtime readiness includes shared Nginx UMask=0027 policy', async () => {
  const base = baseRuntime();
  const policy = umask();
  const handler = websiteProvisioningIsolationInternals.passengerRuntimeHandler(base.handler, policy.manager);
  const context = { operationId: 'operation-1', intent: { adapter: 'passenger' } };

  const applied = await handler.apply(context);
  const inspected = await handler.inspect(context);

  assert.equal(applied.satisfied, true);
  assert.equal(applied.runtimeUmask, '0027');
  assert.equal(inspected.runtimeUmask, '0027');
  assert.deepEqual(policy.calls, [['apply', 'passenger'], ['inspect', 'passenger']]);
});

test('Passenger inspect fails closed when Nginx runtime umask is not effective', async () => {
  const base = baseRuntime();
  const policy = umask({ satisfied: false });
  const handler = websiteProvisioningIsolationInternals.passengerRuntimeHandler(base.handler, policy.manager);

  const result = await handler.inspect({ intent: { adapter: 'passenger' } });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'passenger_runtime_umask_not_ready');
  assert.equal(result.umaskReason, 'service_umask_not_effective');
});

test('Passenger wrapper does not mutate shared service policy if base runtime is not ready', async () => {
  const base = baseRuntime({ satisfied: false });
  const policy = umask();
  const handler = websiteProvisioningIsolationInternals.passengerRuntimeHandler(base.handler, policy.manager);

  const result = await handler.apply({ intent: { adapter: 'passenger' } });
  assert.equal(result.satisfied, false);
  assert.deepEqual(policy.calls, []);
});

test('Static runtime isolates retained publish releases before Nginx routing can proceed', async () => {
  const calls = [];
  const base = {
    async apply(context) { calls.push(['runtime-apply', context]); return { satisfied: true, adapter: 'static', releaseId: 'release-1' }; },
    async inspect(context) { calls.push(['runtime-inspect', context]); return { satisfied: true, adapter: 'static', releaseId: 'release-1' }; },
    async compensate(context) { calls.push(['runtime-compensate', context]); return { satisfied: true }; },
    async inspectCompensation(context) { calls.push(['runtime-compensation-inspect', context]); return { satisfied: true }; },
  };
  const isolation = {
    async apply(value) { calls.push(['isolation-apply', value]); return { satisfied: true, adapter: 'static-publish-isolation', releaseCount: 3, currentRelease: '/var/www/yunpanel/apps/app/releases/release-1' }; },
    async inspect(value) { calls.push(['isolation-inspect', value]); return { satisfied: true, adapter: 'static-publish-isolation', releaseCount: 3, currentRelease: '/var/www/yunpanel/apps/app/releases/release-1' }; },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);
  const context = { intent: { websiteId: 'website-1', applicationId: 'application-1' } };

  const applied = await handler.apply(context);
  const inspected = await handler.inspect(context);

  assert.deepEqual(calls.slice(0, 4).map(([name]) => name), [
    'runtime-apply', 'isolation-apply', 'runtime-inspect', 'isolation-inspect',
  ]);
  assert.deepEqual(calls[1][1], { websiteId: 'website-1', applicationId: 'application-1' });
  assert.equal(applied.publishIsolated, true);
  assert.equal(applied.isolatedReleaseCount, 3);
  assert.equal(inspected.publishIsolated, true);
});

test('Static runtime inspect fails closed when publish ACL or ownership drifted', async () => {
  const base = {
    async apply() { return { satisfied: true, adapter: 'static' }; },
    async inspect() { return { satisfied: true, adapter: 'static' }; },
    async compensate() { return { satisfied: true }; },
    async inspectCompensation() { return { satisfied: true }; },
  };
  const isolation = {
    async apply() { return { satisfied: false, reason: 'static_publish_acl_drift' }; },
    async inspect() { return { satisfied: false, reason: 'static_publish_acl_drift' }; },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);

  const result = await handler.inspect({ intent: { websiteId: 'website-1', applicationId: 'application-1' } });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'static_publish_isolation_not_ready');
  assert.equal(result.isolationReason, 'static_publish_acl_drift');
});

test('Static compensation remains owned by the existing release rollback lifecycle', async () => {
  const calls = [];
  const base = {
    async apply() { return { satisfied: true }; },
    async inspect() { return { satisfied: true }; },
    async compensate(context) { calls.push(['compensate', context]); return { satisfied: true }; },
    async inspectCompensation(context) { calls.push(['inspect', context]); return { satisfied: true }; },
  };
  const isolation = {
    async apply() { throw new Error('unused'); },
    async inspect() { throw new Error('unused'); },
  };
  const handler = websiteProvisioningIsolationInternals.staticRuntimeHandler(base, isolation);
  const context = { operationId: 'operation-1', intent: { websiteId: 'website-1', applicationId: 'application-1' } };

  await handler.compensate(context);
  await handler.inspectCompensation(context);
  assert.deepEqual(calls.map(([name]) => name), ['compensate', 'inspect']);
});
