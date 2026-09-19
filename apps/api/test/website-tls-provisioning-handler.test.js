import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteTlsProvisioningHandler,
  WebsiteTlsProvisioningError,
} from '../src/website-tls-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const certificateId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const checksum = 'a'.repeat(64);
const configName = 'yunpanel-example.com.conf';

const intent = Object.freeze({
  adapter: 'managed-certificate-nginx',
  websiteId,
  primaryDomainId: domainId,
  primaryDomain: 'example.com',
  aliases: Object.freeze(['www.example.com']),
});

function operation() {
  return {
    operationId,
    websiteId,
    steps: [
      {
        id: 'nginx',
        kind: 'nginx',
        state: 'succeeded',
        intent: {
          websiteId,
          primaryDomain: 'example.com',
          aliases: ['www.example.com'],
          targetType: 'static',
          target: { root: '/var/www/yunpanel/apps/example/current', spaFallback: true },
        },
        evidence: { satisfied: true, checksum: 'b'.repeat(64), configName },
      },
      {
        id: 'certificate',
        kind: 'certificate',
        state: 'succeeded',
        intent: {},
        evidence: {
          satisfied: true,
          adapter: 'acme-certificate',
          certificateId,
          provisioningOperationId: operationId,
          attachedDomainRevision: 2,
        },
      },
      {
        id: 'tls_activation',
        kind: 'tls_activation',
        state: 'applying',
        intent,
      },
    ],
  };
}

function certificate(overrides = {}) {
  return {
    id: certificateId,
    domainId,
    serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
    provisioningOperationId: operationId,
    source: 'acme',
    state: 'active',
    staging: false,
    domains: ['example.com', 'www.example.com'],
    fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
    ...overrides,
  };
}

function attachedDomain(overrides = {}) {
  return {
    id: domainId,
    serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
    websiteId,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    httpsMode: 'managed',
    httpsRedirect: true,
    canonicalRedirect: false,
    certificateId,
    desiredRevision: 2,
    stagedRevision: 0,
    appliedRevision: 1,
    stagedChecksum: null,
    stagedConfigName: null,
    state: 'draft',
    lastError: null,
    ...overrides,
  };
}

function domainRegistryFixture(initial = attachedDomain()) {
  let domain = { ...initial };
  const calls = [];
  return {
    calls,
    registry: {
      getDomain: async () => ({ ...domain, aliases: [...domain.aliases] }),
      markStaged: async (id, input) => {
        calls.push(['stage', id, input]);
        domain = {
          ...domain,
          stagedRevision: domain.desiredRevision,
          stagedChecksum: input.checksum,
          stagedConfigName: input.configName,
          state: 'staged',
          lastError: null,
        };
        return { ...domain, aliases: [...domain.aliases] };
      },
      markApplied: async (id, input) => {
        calls.push(['apply', id, input]);
        domain = {
          ...domain,
          appliedRevision: domain.desiredRevision,
          state: 'active',
          lastError: null,
        };
        return { ...domain, aliases: [...domain.aliases] };
      },
    },
    current: () => ({ ...domain, aliases: [...domain.aliases] }),
  };
}

test('Website TLS apply activates the certificate-backed Nginx spec then reconciles Domain revision', async () => {
  const domain = domainRegistryFixture();
  const nginxCalls = [];
  const handler = createWebsiteTlsProvisioningHandler({
    certificateRegistry: { getCertificate: async () => certificate() },
    domainRegistry: domain.registry,
    nginxProvisioningHandler: {
      inspect: async (input) => {
        nginxCalls.push(['inspect', input]);
        return { satisfied: false, reason: 'website_nginx_not_active' };
      },
      apply: async (input) => {
        nginxCalls.push(['apply', input]);
        return { satisfied: true, checksum, configName, active: true };
      },
    },
  });

  const result = await handler.apply({
    operation: operation(),
    operationId,
    websiteId,
    intent,
  });

  assert.deepEqual(result, {
    satisfied: true,
    adapter: 'managed-certificate-nginx',
    certificateId,
    domainId,
    domainRevision: 2,
    nginxChecksum: checksum,
    nginxConfigName: configName,
    httpsRedirect: true,
    canonicalRedirect: false,
  });
  assert.equal(nginxCalls.length, 2);
  assert.deepEqual(nginxCalls[1][1].tls, {
    fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
  });
  assert.equal(nginxCalls[1][1].httpsRedirect, true);
  assert.deepEqual(domain.calls, [
    ['stage', domainId, { checksum, configName }],
    ['apply', domainId, { checksum }],
  ]);
});

test('Website TLS inspect reconciles control-plane state from exact active host evidence without replaying host apply', async () => {
  const domain = domainRegistryFixture();
  let hostMutations = 0;
  const handler = createWebsiteTlsProvisioningHandler({
    certificateRegistry: { getCertificate: async () => certificate() },
    domainRegistry: domain.registry,
    nginxProvisioningHandler: {
      inspect: async () => ({ satisfied: true, checksum, configName, active: true }),
      apply: async () => {
        hostMutations += 1;
        return { satisfied: true, checksum, configName, active: true };
      },
    },
  });

  const result = await handler.inspect({
    operation: operation(),
    operationId,
    websiteId,
    intent,
  });

  assert.equal(result.satisfied, true);
  assert.equal(result.domainRevision, 2);
  assert.equal(hostMutations, 0);
  assert.deepEqual(domain.calls, [
    ['stage', domainId, { checksum, configName }],
    ['apply', domainId, { checksum }],
  ]);
});

test('Website TLS inspect is idempotent when Domain and host already match the certificate revision', async () => {
  const domain = domainRegistryFixture(attachedDomain({
    stagedRevision: 2,
    appliedRevision: 2,
    stagedChecksum: checksum,
    stagedConfigName: configName,
    state: 'active',
  }));
  const handler = createWebsiteTlsProvisioningHandler({
    certificateRegistry: { getCertificate: async () => certificate() },
    domainRegistry: domain.registry,
    nginxProvisioningHandler: {
      inspect: async () => ({ satisfied: true, checksum, configName, active: true }),
      apply: async () => assert.fail('host apply must not run'),
    },
  });

  const result = await handler.inspect({
    operation: operation(),
    operationId,
    websiteId,
    intent,
  });
  assert.equal(result.satisfied, true);
  assert.deepEqual(domain.calls, []);
});

test('Website TLS activation rejects certificate ownership drift before touching Nginx', async () => {
  const domain = domainRegistryFixture();
  let nginxCalls = 0;
  const handler = createWebsiteTlsProvisioningHandler({
    certificateRegistry: {
      getCertificate: async () => certificate({
        provisioningOperationId: '9cc27ea5-f7db-4772-a02b-9fa0fa7737fb',
      }),
    },
    domainRegistry: domain.registry,
    nginxProvisioningHandler: {
      inspect: async () => { nginxCalls += 1; return {}; },
      apply: async () => { nginxCalls += 1; return {}; },
    },
  });

  await assert.rejects(
    handler.apply({ operation: operation(), operationId, websiteId, intent }),
    (error) => error instanceof WebsiteTlsProvisioningError
      && error.code === 'website_tls_certificate_drift',
  );
  assert.equal(nginxCalls, 0);
  assert.deepEqual(domain.calls, []);
});

test('Website TLS compensation rolls back Nginx to HTTP-only and reconciles Domain', async () => {
  const domain = domainRegistryFixture();
  const nginxCalls = [];
  const handler = createWebsiteTlsProvisioningHandler({
    certificateRegistry: { getCertificate: async () => certificate() },
    domainRegistry: domain.registry,
    nginxProvisioningHandler: {
      inspect: async (input) => {
        nginxCalls.push(['inspect', input]);
        return { satisfied: false };
      },
      apply: async (input) => {
        nginxCalls.push(['apply', input]);
        return { satisfied: true, checksum: 'rollback-checksum', configName: 'rollback.conf', active: true };
      },
    },
  });

  const inspected = await handler.inspectCompensation({
    operation: operation(),
    operationId,
    websiteId,
    intent,
  });
  assert.equal(inspected.satisfied, false);
  assert.equal(inspected.reason, 'website_tls_rollback_required');

  const compensated = await handler.compensate({
    operation: operation(),
    operationId,
    websiteId,
    intent,
  });
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.rolledBack, true);
  assert.equal(compensated.nginxChecksum, 'rollback-checksum');
  assert.equal(compensated.nginxConfigName, 'rollback.conf');
  assert.deepEqual(nginxCalls.at(-1)[1].tls, null);
  assert.equal(nginxCalls.at(-1)[1].httpsRedirect, false);
});
