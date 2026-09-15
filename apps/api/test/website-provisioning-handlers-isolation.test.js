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
