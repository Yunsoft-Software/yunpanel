import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePhpRuntimeProvisioningHandler } from '../src/website-php-runtime-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = 'yunapp-4dc352e64a14';
const documentRoot = `/var/lib/yunpanel/apps/${applicationId}/current/public`;

function intent() {
  return { adapter: 'php-fpm', websiteId, applicationId, unixUser, documentRoot };
}

function umaskManager(calls = null, { satisfied = true } = {}) {
  return {
    async apply(runtime) {
      calls?.push(['umask', runtime]);
      return satisfied ? { satisfied: true, adapter: 'systemd-umask', runtime, umask: '0027' } : { satisfied: false, reason: 'service_umask_not_effective' };
    },
    async inspect(runtime) {
      calls?.push(['umask-inspect', runtime]);
      return satisfied ? { satisfied: true, adapter: 'systemd-umask', runtime, umask: '0027' } : { satisfied: false, reason: 'service_umask_not_effective' };
    },
  };
}

test('PHP runtime locks containers, activates FPM, enforces UMask=0027 and rechecks the pool', async () => {
  const calls = [];
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply(value, options) {
        calls.push(['container', value, options]);
        return { satisfied: true, adapter: 'php-container', containerOwner: 'root:root', releaseUid: 1201, releaseGid: 1201 };
      },
      async inspect() { return { satisfied: true, adapter: 'php-container', containerOwner: 'root:root', releaseUid: 1201, releaseGid: 1201 }; },
    },
    fpmManager: {
      async apply(value, options) {
        calls.push(['fpm', value, options]);
        return { satisfied: true, adapter: 'php-fpm', applicationId, unixUser, documentRoot, socketPath: `/run/php/yunpanel-${unixUser}.sock` };
      },
      async inspect() {
        calls.push(['fpm-inspect']);
        return { satisfied: true, adapter: 'php-fpm', applicationId, unixUser, documentRoot, socketPath: `/run/php/yunpanel-${unixUser}.sock` };
      },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
    umaskManager: umaskManager(calls),
  });

  const result = await handler.apply({ intent: intent(), operationId });

  assert.deepEqual(calls.map(([name]) => name), ['container', 'fpm', 'umask', 'fpm-inspect']);
  assert.equal(calls[0][1].adapter, undefined);
  assert.equal(calls[0][2].operationId, operationId);
  assert.equal(calls[1][2].operationId, operationId);
  assert.equal(calls[2][1], 'php');
  assert.equal(result.adapter, 'php-fpm');
  assert.equal(result.containerLocked, true);
  assert.equal(result.containerOwner, 'root:root');
  assert.equal(result.releaseUid, 1201);
  assert.equal(result.runtimeUmask, '0027');
});

test('PHP runtime inspect does not claim readiness when container lockdown drifted', async () => {
  let fpmInspected = false;
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { throw new Error('unused'); },
      async inspect() { return { satisfied: false, reason: 'php_site_container_control_plane_drift' }; },
    },
    fpmManager: {
      async apply() { throw new Error('unused'); },
      async inspect() { fpmInspected = true; return { satisfied: true }; },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
    umaskManager: umaskManager(),
  });

  const result = await handler.inspect({ intent: intent(), operationId });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'php_container_not_ready');
  assert.equal(fpmInspected, false);
});

test('PHP runtime inspect fails closed when the shared FPM service umask drifted', async () => {
  let fpmInspected = false;
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { return { satisfied: true, adapter: 'php-container' }; },
      async inspect() { return { satisfied: true, adapter: 'php-container', containerOwner: 'root:root' }; },
    },
    fpmManager: {
      async apply() { return { satisfied: true, adapter: 'php-fpm' }; },
      async inspect() { fpmInspected = true; return { satisfied: true }; },
      async compensate() { return { satisfied: true }; },
      async inspectCompensation() { return { satisfied: true }; },
    },
    umaskManager: umaskManager(null, { satisfied: false }),
  });

  const result = await handler.inspect({ intent: intent(), operationId });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'php_runtime_umask_not_ready');
  assert.equal(fpmInspected, false);
});

test('PHP runtime compensation removes only FPM state and preserves shared service policy', async () => {
  const calls = [];
  const handler = createWebsitePhpRuntimeProvisioningHandler({
    containerManager: {
      async apply() { return { satisfied: true, adapter: 'php-container' }; },
      async inspect() { return { satisfied: true, adapter: 'php-container' }; },
    },
    fpmManager: {
      async apply() { return { satisfied: true, adapter: 'php-fpm' }; },
      async inspect() { return { satisfied: true, adapter: 'php-fpm' }; },
      async compensate(value, options) { calls.push(['compensate', value, options]); return { satisfied: true }; },
      async inspectCompensation(value, options) { calls.push(['inspect', value, options]); return { satisfied: true }; },
    },
    umaskManager: umaskManager(calls),
  });

  await handler.compensate({ intent: intent(), operationId });
  await handler.inspectCompensation({ intent: intent(), operationId });
  assert.deepEqual(calls.map(([name]) => name), ['compensate', 'inspect']);
});
