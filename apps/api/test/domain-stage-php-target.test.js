import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { DomainRegistryError } from '../src/domain-registry.js';
import { createDomainStageTargetJobRegistry } from '../src/domain-stage-target-job-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = 'yunapp-4dc352e64a14';
const root = `/var/lib/yunpanel/apps/${applicationId}/current/public`;
const socketPath = `/run/php/yunpanel-${unixUser}.sock`;

function operation({ runtimeState = 'succeeded', routeState = 'succeeded' } = {}) {
  return {
    websiteId,
    steps: [
      {
        id: 'php_bootstrap',
        state: 'succeeded',
        evidence: { satisfied: true, adapter: 'php-bootstrap', websiteId, applicationId, unixUser, documentRoot: root },
      },
      {
        id: 'php_runtime',
        state: runtimeState,
        evidence: runtimeState === 'succeeded'
          ? { satisfied: true, adapter: 'php-fpm', websiteId, applicationId, unixUser, documentRoot: root, socketPath }
          : null,
      },
      { id: 'nginx', state: routeState, evidence: routeState === 'succeeded' ? { satisfied: true } : null },
      { id: 'domain_activation', state: routeState, evidence: routeState === 'succeeded' ? { satisfied: true } : null },
    ],
  };
}

function fixture({ latest = operation() } = {}) {
  const calls = [];
  const domain = {
    id: 'domain-php-1',
    serverId,
    websiteId,
    desiredRevision: 2,
    targetType: 'php',
    target: { applicationId },
    nginxSettings: {
      clientMaxBodySizeMb: 64,
      headers: [{ name: 'X-App', value: 'yunpanel', always: true }],
    },
  };
  const website = {
    id: websiteId,
    serverId,
    revision: 1,
    applicationId,
    dockerWorkloadId: null,
    managedComposeBinding: null,
    runtimeType: 'php',
    documentRoot: root,
    unixUser,
    proxyTarget: null,
  };
  const application = {
    id: applicationId,
    serverId,
    type: 'php',
    webRoot: root,
  };
  const registry = {
    async enqueue(value) { calls.push(value); return { id: 'job-php-1', ...value }; },
    async listJobs() { return []; },
  };
  const decorated = createDomainStageTargetJobRegistry({
    registry,
    domainRegistry: { async getDomain(id) { return id === domain.id ? domain : null; } },
    websiteRegistry: { async getWebsite(id) { return id === website.id ? website : null; } },
    dockerComposeProjectRegistry: { async getProject() { return null; } },
    applicationRegistry: { async getApplication(id) { return id === application.id ? application : null; } },
    runtimeBindingRegistry: { async getBinding() { return null; } },
    websiteProvisioningRegistry: { async getLatestForWebsite(id) { return id === website.id ? latest : null; } },
  });
  return { calls, decorated, domain };
}

function input() {
  return {
    serverId,
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'php.example.test',
      aliases: [],
      targetType: 'php',
      target: { applicationId },
      nginxSettings: { clientMaxBodySizeMb: 64, headers: [{ name: 'X-App', value: 'yunpanel', always: true }] },
      canonicalRedirect: false,
      httpsRedirect: false,
    },
    resourceType: 'domain',
    resourceId: 'domain-php-1',
  };
}

test('PHP Domain restage replaces logical Application target with proven FPM socket and root', async () => {
  const fx = fixture();
  const request = input();
  await fx.decorated.enqueue(request);

  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].payload.targetType, 'php');
  assert.deepEqual(fx.calls[0].payload.target, { root, socketPath });
  assert.deepEqual(fx.calls[0].payload.nginxSettings, request.payload.nginxSettings);
  assert.deepEqual(request, input());
});

test('PHP Domain restage fails closed until initial PHP runtime and route evidence are active', async () => {
  for (const latest of [null, operation({ runtimeState: 'failed' }), operation({ routeState: 'pending' })]) {
    const fx = fixture({ latest });
    await assert.rejects(
      fx.decorated.enqueue(input()),
      (error) => error instanceof DomainRegistryError
        && error.code === 'php_runtime_binding_required'
        && error.status === 409,
    );
    assert.equal(fx.calls.length, 0);
  }
});
