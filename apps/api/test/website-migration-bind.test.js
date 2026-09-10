import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry } from '../src/domain-registry.js';
import { bindLegacyDomainToWebsite, WebsiteMigrationBindError } from '../src/website-migration-bind.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const wrongWebsiteId = 'da25db71-1a5d-414e-af9f-f1e7f9a9baf7';

function app(overrides = {}) {
  return { id: applicationId, serverId, type: 'node', proxyTarget: { host: '127.0.0.1', port: 4301 }, ...overrides };
}
function website(id = websiteId) {
  return { id, serverId, applicationId, runtimeType: 'node' };
}

async function fixture({ websites = [website()], applications = [app()] } = {}) {
  const websiteMap = new Map(websites.map((item) => [item.id, item]));
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websiteMap.get(id) ?? null,
  });
  const domain = await domainRegistry.createDomain({
    serverId,
    primaryDomain: 'api.example.com',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
  });
  return {
    domain,
    domainRegistry,
    websiteRegistry: { async listWebsites() { return websites.map((item) => ({ ...item })); } },
    applicationRegistry: { async listApplications() { return applications.map((item) => ({ ...item })); } },
  };
}

const code = (expected) => (error) => error instanceof WebsiteMigrationBindError && error.code === expected;

test('exact ready preview binds legacy Domain to an existing Website once', async () => {
  const f = await fixture();
  const before = await f.domainRegistry.getDomain(f.domain.id);
  const result = await bindLegacyDomainToWebsite({
    domainId: f.domain.id,
    websiteId,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
  });
  assert.equal(result.migrated, true);
  assert.equal(result.domain.websiteId, websiteId);
  assert.equal(result.domain.desiredRevision, before.desiredRevision);
  assert.deepEqual(result.domain.target, before.target);

  const retry = await bindLegacyDomainToWebsite({
    domainId: f.domain.id,
    websiteId,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
  });
  assert.equal(retry.migrated, false);
  assert.equal(retry.domain.websiteId, websiteId);
});

test('wrong Website ID is not authorized by the current migration preview', async () => {
  const f = await fixture({ websites: [website(), website(wrongWebsiteId)] });
  await assert.rejects(bindLegacyDomainToWebsite({
    domainId: f.domain.id,
    websiteId: wrongWebsiteId,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
  }), code('website_migration_binding_not_ready'));
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
});

test('create-Website and ambiguous preview states cannot enter existing-Website bind', async () => {
  const noWebsite = await fixture({ websites: [] });
  await assert.rejects(bindLegacyDomainToWebsite({
    domainId: noWebsite.domain.id,
    websiteId,
    domainRegistry: noWebsite.domainRegistry,
    websiteRegistry: noWebsite.websiteRegistry,
    applicationRegistry: noWebsite.applicationRegistry,
  }), code('website_migration_binding_not_ready'));
  assert.equal((await noWebsite.domainRegistry.getDomain(noWebsite.domain.id)).websiteId, null);

  const secondAppId = '55eb283e-b1a4-471a-89fe-74959f83d482';
  const ambiguous = await fixture({
    websites: [website()],
    applications: [app(), { ...app(), id: secondAppId }],
  });
  await assert.rejects(bindLegacyDomainToWebsite({
    domainId: ambiguous.domain.id,
    websiteId,
    domainRegistry: ambiguous.domainRegistry,
    websiteRegistry: ambiguous.websiteRegistry,
    applicationRegistry: ambiguous.applicationRegistry,
  }), code('website_migration_binding_not_ready'));
  assert.equal((await ambiguous.domainRegistry.getDomain(ambiguous.domain.id)).websiteId, null);
});

test('retry against a different Website refuses existing binding conflict', async () => {
  const f = await fixture({ websites: [website(), website(wrongWebsiteId)] });
  await bindLegacyDomainToWebsite({
    domainId: f.domain.id,
    websiteId,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
  });
  await assert.rejects(bindLegacyDomainToWebsite({
    domainId: f.domain.id,
    websiteId: wrongWebsiteId,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
  }), code('website_migration_binding_conflict'));
});
