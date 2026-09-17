import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const staticWebsiteId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
const staticApplicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const phpWebsiteId = 'c42e06d2-9bd1-4757-b320-5975ef454ee1';
const phpApplicationId = '0bb78242-03a6-429f-9d17-7725c521437c';
const nodeWebsiteId = '294dfeda-c5ba-4e2c-ab4f-e012c5c53880';
const nodeApplicationId = 'f65e987b-c69b-4a6f-96f2-7868325da65f';
const proxyWebsiteId = '4a50a2fd-bde9-40ce-8e91-2c0a27cb28f0';

function websites() {
  return new Map([
    [staticWebsiteId, {
      id: staticWebsiteId,
      serverId,
      runtimeType: 'static',
      applicationId: staticApplicationId,
      documentRoot: `/var/www/yunpanel/apps/${staticApplicationId}/current`,
      proxyTarget: null,
    }],
    [phpWebsiteId, {
      id: phpWebsiteId,
      serverId,
      runtimeType: 'php',
      applicationId: phpApplicationId,
      documentRoot: `/var/lib/yunpanel/apps/${phpApplicationId}/current/public`,
      proxyTarget: null,
    }],
    [nodeWebsiteId, {
      id: nodeWebsiteId,
      serverId,
      runtimeType: 'node',
      applicationId: nodeApplicationId,
      documentRoot: `/var/lib/yunpanel/apps/${nodeApplicationId}/current`,
      proxyTarget: null,
    }],
    [proxyWebsiteId, {
      id: proxyWebsiteId,
      serverId,
      runtimeType: 'proxy',
      applicationId: null,
      documentRoot: null,
      proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true },
    }],
  ]);
}

function registry({ requireBinding = true } = {}) {
  const byId = websites();
  return createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => byId.get(id) ?? null,
    websiteBindingRequired: () => requireBinding,
  });
}

function baseInput(extra = {}) {
  return {
    serverId,
    primaryDomain: 'shared.example.test',
    aliases: [],
    httpsMode: 'off',
    ...extra,
  };
}

test('static Domain binding rejects a root outside the selected Website', async () => {
  const domains = registry();
  await assert.rejects(
    domains.createDomain(baseInput({
      websiteId: staticWebsiteId,
      targetType: 'static',
      target: { root: '/var/www/yunpanel/apps/other/current', spaFallback: true },
    })),
    (error) => error instanceof DomainRegistryError
      && error.code === 'domain_website_target_mismatch'
      && error.status === 409,
  );
  assert.equal((await domains.listDomains()).length, 0);

  const created = await domains.createDomain(baseInput({
    websiteId: staticWebsiteId,
    targetType: 'static',
    target: { root: `/var/www/yunpanel/apps/${staticApplicationId}/current`, spaFallback: true },
  }));
  assert.equal(created.websiteId, staticWebsiteId);
});

test('PHP and Passenger Domain bindings require the Website Application identity', async () => {
  const domains = registry();
  await assert.rejects(
    domains.createDomain(baseInput({
      websiteId: phpWebsiteId,
      primaryDomain: 'php.example.test',
      targetType: 'php',
      target: { applicationId: nodeApplicationId },
    })),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_website_target_mismatch',
  );
  await assert.rejects(
    domains.createDomain(baseInput({
      websiteId: nodeWebsiteId,
      primaryDomain: 'node.example.test',
      targetType: 'passenger',
      target: { applicationId: phpApplicationId },
    })),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_website_target_mismatch',
  );

  const php = await domains.createDomain(baseInput({
    websiteId: phpWebsiteId,
    primaryDomain: 'php.example.test',
    targetType: 'php',
    target: { applicationId: phpApplicationId },
  }));
  const node = await domains.createDomain(baseInput({
    websiteId: nodeWebsiteId,
    primaryDomain: 'node.example.test',
    targetType: 'passenger',
    target: { applicationId: nodeApplicationId },
  }));
  assert.equal(php.websiteId, phpWebsiteId);
  assert.equal(node.websiteId, nodeWebsiteId);
});

test('shared-site www alias remains one Domain bound to the existing Website', async () => {
  const domains = registry();
  const created = await domains.createDomain(baseInput({
    websiteId: nodeWebsiteId,
    primaryDomain: 'shared-node.example.test',
    aliases: ['www.shared-node.example.test'],
    httpsMode: 'managed',
    targetType: 'passenger',
    target: { applicationId: nodeApplicationId },
  }));

  assert.equal(created.websiteId, nodeWebsiteId);
  assert.deepEqual(created.aliases, ['www.shared-node.example.test']);
  assert.equal(created.parentDomainId, null);
  assert.equal((await domains.listDomains()).length, 1);
});

test('proxy-backed Website binding rejects a different upstream', async () => {
  const domains = registry();
  await assert.rejects(
    domains.createDomain(baseInput({
      websiteId: proxyWebsiteId,
      primaryDomain: 'proxy.example.test',
      targetType: 'proxy',
      target: { upstreamHost: '127.0.0.1', upstreamPort: 8081, websocket: true },
    })),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_website_target_mismatch',
  );

  const created = await domains.createDomain(baseInput({
    websiteId: proxyWebsiteId,
    primaryDomain: 'proxy.example.test',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 8080, websocket: true },
  }));
  assert.equal(created.websiteId, proxyWebsiteId);
});

test('legacy direct-systemd Node proxy target remains migration-compatible', async () => {
  const domains = registry();
  const created = await domains.createDomain(baseInput({
    websiteId: nodeWebsiteId,
    primaryDomain: 'legacy-node.example.test',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3123, websocket: true },
  }));
  assert.equal(created.websiteId, nodeWebsiteId);
  assert.equal(created.targetType, 'proxy');
});

test('binding a legacy Domain to a Website rejects an incompatible target', async () => {
  const domains = registry({ requireBinding: false });
  const legacy = await domains.createDomain(baseInput({
    websiteId: null,
    primaryDomain: 'legacy.example.test',
    targetType: 'static',
    target: { root: '/srv/legacy', spaFallback: true },
  }));

  await assert.rejects(
    domains.bindWebsite(legacy.id, staticWebsiteId),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_website_target_mismatch',
  );
  assert.equal((await domains.getDomain(legacy.id)).websiteId, null);
});

test('legacy Website lookup records without runtimeType keep the base registry contract', async () => {
  const legacyWebsiteId = '11111111-1111-4111-8111-111111111111';
  const domains = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => id === legacyWebsiteId ? { id, serverId } : null,
    websiteBindingRequired: () => true,
  });
  const created = await domains.createDomain(baseInput({
    websiteId: legacyWebsiteId,
    primaryDomain: 'legacy-shape.example.test',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
  }));
  assert.equal(created.websiteId, legacyWebsiteId);
});
