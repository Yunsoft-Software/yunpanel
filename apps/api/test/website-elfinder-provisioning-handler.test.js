import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteElFinderProvisioningHandler,
  WebsiteElFinderProvisioningError,
} from '../src/website-elfinder-provisioning-handler.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const intent = Object.freeze({
  adapter: 'elfinder-fpm',
  websiteId: '22345678-1234-4234-8234-123456789012',
  applicationId: '32345678-1234-4234-8234-123456789012',
  unixUser: 'yunapp-abcdef123456',
});

function fpmManager({ inspectSatisfied = true } = {}) {
  const calls = [];
  return {
    calls,
    manager: {
      async apply(input, options) {
        calls.push(['apply', input, options]);
        return {
          satisfied: true,
          adapter: 'elfinder-fpm',
          socketPath: '/run/php/yunpanel-elfinder-yunapp-abcdef123456.sock',
          unixUser: input.unixUser,
        };
      },
      async inspect(input) {
        calls.push(['inspect', input]);
        return inspectSatisfied
          ? {
              satisfied: true,
              adapter: 'elfinder-fpm',
              socketPath: '/run/php/yunpanel-elfinder-yunapp-abcdef123456.sock',
              unixUser: input.unixUser,
            }
          : { satisfied: false, reason: 'elfinder_fpm_socket_missing' };
      },
      async compensate(input, options) {
        calls.push(['compensate', input, options]);
        return { satisfied: true, restoredPrevious: false };
      },
      async inspectCompensation(input, options) {
        calls.push(['inspect-compensation', input, options]);
        return { satisfied: true, restoredPrevious: false };
      },
    },
  };
}

function umaskManager({ satisfied = true } = {}) {
  const calls = [];
  return {
    calls,
    manager: {
      async apply(service) {
        calls.push(['apply', service]);
        return satisfied ? { satisfied: true, umask: '0027' } : { satisfied: false };
      },
      async inspect(service) {
        calls.push(['inspect', service]);
        return satisfied ? { satisfied: true, umask: '0027' } : { satisfied: false, reason: 'missing' };
      },
    },
  };
}

test('Website elFinder provisioning applies exact FPM identity and verifies shared PHP umask', async () => {
  const fpm = fpmManager();
  const umask = umaskManager();
  const handler = createWebsiteElFinderProvisioningHandler({
    fpmManager: fpm.manager,
    umaskManager: umask.manager,
  });

  const result = await handler.apply({ intent, operationId });

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'elfinder-fpm');
  assert.equal(result.runtimeUmask, '0027');
  const normalized = {
    websiteId: intent.websiteId,
    applicationId: intent.applicationId,
    unixUser: intent.unixUser,
  };
  assert.deepEqual(fpm.calls, [
    ['apply', normalized, { operationId }],
    ['inspect', normalized],
  ]);
  assert.deepEqual(umask.calls, [['apply', 'php']]);
});

test('Website elFinder inspection is read-only and reports FPM or umask readiness', async () => {
  {
    const fpm = fpmManager({ inspectSatisfied: false });
    const umask = umaskManager();
    const handler = createWebsiteElFinderProvisioningHandler({
      fpmManager: fpm.manager,
      umaskManager: umask.manager,
    });
    const result = await handler.inspect({ intent });
    assert.deepEqual(result, { satisfied: false, reason: 'elfinder_fpm_socket_missing' });
    assert.deepEqual(umask.calls, [['inspect', 'php']]);
    assert.equal(fpm.calls[0][0], 'inspect');
  }

  {
    const fpm = fpmManager();
    const umask = umaskManager({ satisfied: false });
    const handler = createWebsiteElFinderProvisioningHandler({
      fpmManager: fpm.manager,
      umaskManager: umask.manager,
    });
    const result = await handler.inspect({ intent });
    assert.equal(result.satisfied, false);
    assert.equal(result.reason, 'elfinder_fpm_umask_not_ready');
    assert.equal(fpm.calls.length, 0);
  }
});

test('Website elFinder compensation delegates only operation-owned FPM state', async () => {
  const fpm = fpmManager();
  const handler = createWebsiteElFinderProvisioningHandler({
    fpmManager: fpm.manager,
    umaskManager: umaskManager().manager,
  });

  await handler.compensate({ intent, operationId });
  await handler.inspectCompensation({ intent, operationId });

  assert.deepEqual(fpm.calls, [
    ['compensate', {
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
    }, { operationId }],
    ['inspect-compensation', {
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
    }, { operationId }],
  ]);
});

test('Website elFinder handler rejects forged or expanded orchestration intent before host calls', async () => {
  const fpm = fpmManager();
  const handler = createWebsiteElFinderProvisioningHandler({
    fpmManager: fpm.manager,
    umaskManager: umaskManager().manager,
  });

  for (const invalid of [
    { ...intent, adapter: 'php-fpm' },
    { ...intent, root: '/tmp/evil' },
    { ...intent, websiteId: null },
  ]) {
    await assert.rejects(
      handler.apply({ intent: invalid, operationId }),
      (error) => error instanceof WebsiteElFinderProvisioningError
        && error.code === 'website_elfinder_intent_invalid',
    );
  }
  assert.equal(fpm.calls.length, 0);
});

test('Website elFinder apply fails closed if FPM does not survive shared service policy activation', async () => {
  const fpm = fpmManager({ inspectSatisfied: false });
  const handler = createWebsiteElFinderProvisioningHandler({
    fpmManager: fpm.manager,
    umaskManager: umaskManager().manager,
  });

  await assert.rejects(
    handler.apply({ intent, operationId }),
    (error) => error instanceof WebsiteElFinderProvisioningError
      && error.code === 'website_elfinder_fpm_restart_unverified',
  );
});
