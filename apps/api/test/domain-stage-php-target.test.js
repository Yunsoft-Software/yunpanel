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

function fixture({ runtime = null, umask = null } = {}) {
  const calls = [];
  const inspectCalls = [];
  const umaskCalls = [];
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
  const healthyRuntime = {
    satisfied: true,
    adapter: 'php-fpm',
    websiteId,
    applicationId,
    unixUser,
    documentRoot: root,
    socketPath,
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
    phpFpmSiteManager: {
      async inspect(value) {
        inspectCalls.push(value);
        return runtime ?? healthyRuntime;
      },
    },
    serviceUmaskManager: {
      async inspect(target) {
        umaskCalls.push(target);
        return umask ?? { satisfied: true, adapter: 'systemd-umask', runtime: 'php', umask: '0027' };
      },
    },
  });
  return { calls, inspectCalls, umaskCalls, decorated, domain };
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

test('PHP Domain restage replaces logical Application target with live FPM socket and root', async () => {
  const fx = fixture();
  const request = input();
  await fx.decorated.enqueue(request);

  assert.equal(fx.calls.length, 1);
  assert.equal(fx.inspectCalls.length, 1);
  assert.deepEqual(fx.inspectCalls[0], { websiteId, applicationId, unixUser, documentRoot: root });
  assert.deepEqual(fx.umaskCalls, ['php']);
  assert.equal(fx.calls[0].payload.targetType, 'php');
  assert.deepEqual(fx.calls[0].payload.target, { root, socketPath });
  assert.deepEqual(fx.calls[0].payload.nginxSettings, request.payload.nginxSettings);
  assert.deepEqual(request, input());
});

test('PHP Domain restage fails closed while managed PHP-FPM runtime is not healthy', async () => {
  const fx = fixture({ runtime: { satisfied: false, reason: 'php_fpm_socket_missing', adapter: 'php-fpm' } });
  await assert.rejects(
    fx.decorated.enqueue(input()),
    (error) => error instanceof DomainRegistryError
      && error.code === 'php_runtime_binding_required'
      && error.status === 409,
  );
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(fx.umaskCalls, []);
});

test('PHP Domain restage fails closed while service UMask=0027 is not effective', async () => {
  const fx = fixture({ umask: { satisfied: false, reason: 'service_umask_not_effective' } });
  await assert.rejects(
    fx.decorated.enqueue(input()),
    (error) => error instanceof DomainRegistryError
      && error.code === 'php_runtime_binding_required'
      && error.status === 409,
  );
  assert.equal(fx.calls.length, 0);
  assert.deepEqual(fx.umaskCalls, ['php']);
});

test('PHP Domain restage rejects runtime identity or socket drift before enqueue', async () => {
  for (const runtime of [
    { satisfied: true, adapter: 'php-fpm', websiteId, applicationId, unixUser, documentRoot: '/tmp/wrong', socketPath },
    { satisfied: true, adapter: 'php-fpm', websiteId, applicationId, unixUser, documentRoot: root, socketPath: '/tmp/php.sock' },
    { satisfied: true, adapter: 'php-fpm', websiteId, applicationId, unixUser: 'yunapp-aaaaaaaaaaaa', documentRoot: root, socketPath },
  ]) {
    const fx = fixture({ runtime });
    await assert.rejects(
      fx.decorated.enqueue(input()),
      (error) => error instanceof DomainRegistryError
        && error.code === 'php_runtime_binding_drift'
        && error.status === 409,
    );
    assert.equal(fx.calls.length, 0);
  }
});
