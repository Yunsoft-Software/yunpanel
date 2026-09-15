import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteProvisioningHandlers,
  WebsiteProvisioningHandlerError,
} from '../src/website-provisioning-handlers.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-4dc352e64a14';
const documentRoot = `/var/lib/yunpanel/apps/${applicationId}/current/public`;
const socketPath = `/run/php/yunpanel-${unixUser}.sock`;

function phpIntent(overrides = {}) {
  return {
    adapter: 'php-fpm',
    websiteId,
    applicationId,
    unixUser,
    documentRoot,
    ...overrides,
  };
}

function dependencies({ phpFpmSiteManager, nginxManager } = {}) {
  return {
    identityManager: {
      apply: async () => ({}),
      inspect: async () => ({}),
      compensate: async () => ({}),
      inspectCompensation: async () => ({}),
    },
    passengerSiteManager: {
      apply: async () => ({}),
      inspect: async () => ({}),
    },
    phpFpmSiteManager: phpFpmSiteManager ?? {
      apply: async () => ({}),
      inspect: async () => ({}),
      compensate: async () => ({}),
      inspectCompensation: async () => ({}),
    },
    staticDeploymentManager: {
      deployStatic: async () => ({}),
      inspectCurrent: async () => ({}),
      inspectDeployment: async () => ({}),
      compensateDeployment: async () => ({}),
      inspectCompensation: async () => ({}),
    },
    nginxManager: nginxManager ?? {
      stageDomain: async () => ({}),
      inspectStagedDomain: async () => ({}),
      inspectActiveDomain: async () => ({}),
      activateDomain: async () => ({}),
      compensateDomain: async () => ({}),
      inspectDomainCompensation: async () => ({}),
    },
  };
}

test('PHP runtime handler strips adapter metadata and delegates durable operation id', async () => {
  const calls = [];
  const handlers = createWebsiteProvisioningHandlers(dependencies({
    phpFpmSiteManager: {
      apply: async (intent, options) => {
        calls.push(['apply', intent, options]);
        return { satisfied: true, adapter: 'php-fpm', ...intent, socketPath };
      },
      inspect: async (intent) => {
        calls.push(['inspect', intent]);
        return { satisfied: true, adapter: 'php-fpm', ...intent, socketPath };
      },
      compensate: async (intent, options) => {
        calls.push(['compensate', intent, options]);
        return { satisfied: true };
      },
      inspectCompensation: async (intent, options) => {
        calls.push(['inspectCompensation', intent, options]);
        return { satisfied: true };
      },
    },
  }));

  const expectedIntent = { websiteId, applicationId, unixUser, documentRoot };
  const applied = await handlers.php_runtime.apply({ intent: phpIntent(), operationId });
  const inspected = await handlers.php_runtime.inspect({ intent: phpIntent() });
  await handlers.php_runtime.compensate({ intent: phpIntent(), operationId });
  await handlers.php_runtime.inspectCompensation({ intent: phpIntent(), operationId });

  assert.equal(applied.satisfied, true);
  assert.equal(inspected.satisfied, true);
  assert.deepEqual(calls, [
    ['apply', expectedIntent, { operationId }],
    ['inspect', expectedIntent],
    ['compensate', expectedIntent, { operationId }],
    ['inspectCompensation', expectedIntent, { operationId }],
  ]);
});

test('PHP Nginx provisioning trusts verified PHP runtime evidence instead of raw socket input', async () => {
  const stages = [];
  const handlers = createWebsiteProvisioningHandlers(dependencies({
    nginxManager: {
      stageDomain: async (spec) => {
        stages.push(spec);
        return { configName: 'yunpanel-example.com.conf', checksum: 'a'.repeat(64), bytes: 512 };
      },
      inspectStagedDomain: async () => ({ satisfied: true, result: { checksum: 'a'.repeat(64) } }),
      inspectActiveDomain: async () => ({ satisfied: true }),
      activateDomain: async () => ({
        active: true,
        configName: 'yunpanel-example.com.conf',
        checksum: 'a'.repeat(64),
      }),
      compensateDomain: async () => ({ satisfied: true }),
      inspectDomainCompensation: async () => ({ satisfied: true }),
    },
  }));

  const operation = {
    steps: [{
      id: 'php_runtime',
      state: 'succeeded',
      evidence: {
        satisfied: true,
        adapter: 'php-fpm',
        websiteId,
        applicationId,
        unixUser,
        documentRoot,
        socketPath,
      },
    }],
  };
  const result = await handlers.nginx.apply({
    operation,
    intent: {
      primaryDomain: 'example.com',
      aliases: ['www.example.com'],
      targetType: 'php',
      target: { root: '/tmp/attacker', socketPath: '/tmp/attacker.sock' },
    },
  });

  assert.equal(result.satisfied, true);
  assert.equal(stages.length, 1);
  assert.deepEqual(stages[0].target, { root: documentRoot, socketPath });
  assert.equal(stages[0].targetType, 'php');
  assert.equal(stages[0].primaryDomain, 'example.com');
  assert.deepEqual(stages[0].aliases, ['www.example.com']);
});

test('PHP Nginx provisioning fails closed until PHP runtime evidence is successful', async () => {
  const handlers = createWebsiteProvisioningHandlers(dependencies());

  await assert.rejects(
    handlers.nginx.apply({
      operation: { steps: [{ id: 'php_runtime', state: 'pending', evidence: null }] },
      intent: {
        primaryDomain: 'example.com',
        aliases: [],
        targetType: 'php',
        target: { root: documentRoot, socketPath },
      },
    }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_php_runtime_evidence_missing'
      && error.status === 409,
  );
});

test('PHP runtime provisioning rejects extra or malformed intent fields', async () => {
  const handlers = createWebsiteProvisioningHandlers(dependencies());

  await assert.rejects(
    handlers.php_runtime.apply({
      intent: phpIntent({ socketPath: '/tmp/unsafe.sock' }),
      operationId,
    }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_php_runtime_intent_invalid'
      && error.status === 400,
  );
});
