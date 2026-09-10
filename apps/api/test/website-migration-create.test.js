import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteForMigration, WebsiteMigrationCreateError } from '../src/website-migration-create.js';
import { previewWebsiteMigration } from '../src/website-migration-preview.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domainId = '0ef7e00b-1b85-4938-b726-247c94679c66';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const otherApplicationId = '55eb283e-b1a4-471a-89fe-74959f83d482';

function application(id = applicationId, port = 4301) {
  return { id, serverId, type: 'node', proxyTarget: { host: '127.0.0.1', port } };
}
function domain(port = 4301) {
  return { id: domainId, serverId, primaryDomain: 'api.example.com', websiteId: null, targetType: 'proxy', target: { upstreamPort: port } };
}

async function fixture({ applications = [application()], domains = [domain()] } = {}) {
  const apps = new Map(applications.map((item) => [item.id, item]));
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => apps.get(id) ?? null,
  });
  const domainRegistry = { async listDomains() { return domains.map((item) => ({ ...item, target: { ...item.target } })); } };
  const applicationRegistry = { async listApplications() { return applications.map((item) => ({ ...item, proxyTarget: item.proxyTarget ? { ...item.proxyTarget } : null })); } };
  const current = previewWebsiteMigration({ domains, websites: [], applications });
  return { websiteRegistry, domainRegistry, applicationRegistry, previewDigest: current.digest };
}

const code = (expected) => (error) => error instanceof WebsiteMigrationCreateError && error.code === expected;

test('exact create_website_then_bind preview creates one deterministic Website and requires another preview before bind', async () => {
  const f = await fixture();
  const result = await createWebsiteForMigration({
    domainId,
    applicationId,
    previewDigest: f.previewDigest,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
  });
  assert.equal(result.created, true);
  assert.equal(result.website.name, 'api.example.com');
  assert.equal(result.website.applicationId, applicationId);
  assert.equal(result.nextAction, 'rerun_preview_then_bind');
  assert.equal((await f.websiteRegistry.listWebsites()).length, 1);
});

test('retry after Website creation returns the exact existing migration Website without duplicating it', async () => {
  const f = await fixture();
  const first = await createWebsiteForMigration({
    domainId, applicationId, previewDigest: f.previewDigest,
    domainRegistry: f.domainRegistry, websiteRegistry: f.websiteRegistry, applicationRegistry: f.applicationRegistry,
  });
  const retry = await createWebsiteForMigration({
    domainId, applicationId, previewDigest: f.previewDigest,
    domainRegistry: f.domainRegistry, websiteRegistry: f.websiteRegistry, applicationRegistry: f.applicationRegistry,
  });
  assert.equal(retry.created, false);
  assert.equal(retry.website.id, first.website.id);
  assert.equal((await f.websiteRegistry.listWebsites()).length, 1);
});

test('stale preview digest does not create a Website', async () => {
  const f = await fixture();
  await assert.rejects(createWebsiteForMigration({
    domainId, applicationId, previewDigest: 'f'.repeat(64),
    domainRegistry: f.domainRegistry, websiteRegistry: f.websiteRegistry, applicationRegistry: f.applicationRegistry,
  }), code('website_migration_preview_stale'));
  assert.deepEqual(await f.websiteRegistry.listWebsites(), []);
});

test('wrong or ambiguous Application mapping is never created', async () => {
  const wrong = await fixture();
  await assert.rejects(createWebsiteForMigration({
    domainId, applicationId: otherApplicationId, previewDigest: wrong.previewDigest,
    domainRegistry: wrong.domainRegistry, websiteRegistry: wrong.websiteRegistry, applicationRegistry: wrong.applicationRegistry,
  }), code('website_migration_create_not_ready'));

  const applications = [application(), application(otherApplicationId, 4301)];
  const ambiguous = await fixture({ applications });
  await assert.rejects(createWebsiteForMigration({
    domainId, applicationId, previewDigest: ambiguous.previewDigest,
    domainRegistry: ambiguous.domainRegistry, websiteRegistry: ambiguous.websiteRegistry, applicationRegistry: ambiguous.applicationRegistry,
  }), code('website_migration_create_not_ready'));
  assert.deepEqual(await ambiguous.websiteRegistry.listWebsites(), []);
});

test('unresolved legacy target cannot create a migration Website', async () => {
  const f = await fixture({ applications: [application(applicationId, 4400)] });
  await assert.rejects(createWebsiteForMigration({
    domainId, applicationId, previewDigest: f.previewDigest,
    domainRegistry: f.domainRegistry, websiteRegistry: f.websiteRegistry, applicationRegistry: f.applicationRegistry,
  }), code('website_migration_create_not_ready'));
  assert.deepEqual(await f.websiteRegistry.listWebsites(), []);
});
