import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningHandlers } from '../src/website-provisioning-handlers.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const intent = Object.freeze({
  adapter: 'php-bootstrap',
  websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
  applicationId: '6dcb8908-3f3e-43da-9452-15fd6b51ac76',
  unixUser: 'yunapp-4dc352e64a14',
  documentRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current/public',
});

function handlers() {
  const calls = [];
  const phpSiteBootstrapManager = {
    apply: async (value, options) => { calls.push(['apply', value, options]); return { satisfied: true, adapter: 'php-bootstrap' }; },
    inspect: async (value, options) => { calls.push(['inspect', value, options]); return { satisfied: true, adapter: 'php-bootstrap' }; },
    compensate: async (value, options) => { calls.push(['compensate', value, options]); return { satisfied: true }; },
    inspectCompensation: async (value, options) => { calls.push(['inspectCompensation', value, options]); return { satisfied: true }; },
  };
  const noop = { apply: async () => ({}), inspect: async () => ({}), compensate: async () => ({}), inspectCompensation: async () => ({}) };
  const staticDeploymentManager = {
    deployStatic: async () => ({}), inspectCurrent: async () => ({}), inspectDeployment: async () => ({}),
    compensateDeployment: async () => ({}), inspectCompensation: async () => ({}),
  };
  const nginxManager = {
    stageDomain: async () => ({}), inspectStagedDomain: async () => ({}), inspectActiveDomain: async () => ({}),
    activateDomain: async () => ({}), compensateDomain: async () => ({}), inspectDomainCompensation: async () => ({}),
  };
  return {
    calls,
    value: createWebsiteProvisioningHandlers({
      identityManager: noop,
      passengerSiteManager: { apply: async () => ({}), inspect: async () => ({}) },
      phpSiteBootstrapManager,
      phpFpmSiteManager: noop,
      staticDeploymentManager,
      nginxManager,
    }),
  };
}

test('PHP bootstrap provisioning handler preserves durable operation identity', async () => {
  const fixture = handlers();
  const result = await fixture.value.php_bootstrap.apply({ intent, operationId });
  assert.equal(result.satisfied, true);
  assert.deepEqual(fixture.calls[0], [
    'apply',
    {
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
      documentRoot: intent.documentRoot,
    },
    { operationId },
  ]);
});

test('PHP bootstrap provisioning handler exposes inspect and compensation lifecycle', async () => {
  const fixture = handlers();
  await fixture.value.php_bootstrap.inspect({ intent, operationId });
  await fixture.value.php_bootstrap.compensate({ intent, operationId });
  await fixture.value.php_bootstrap.inspectCompensation({ intent, operationId });
  assert.deepEqual(fixture.calls.map(([name]) => name), ['inspect', 'compensate', 'inspectCompensation']);
  assert.deepEqual(fixture.calls.map(([, , options]) => options), [
    { operationId }, { operationId }, { operationId },
  ]);
});
