import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteForMigration, WebsiteMigrationCreateError } from '../src/website-migration-create.js';
import { createWebsiteMigrationLedger } from '../src/website-migration-ledger.js';
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
  const migrationLedger = createWebsiteMigrationLedger();
  const domainRegistry = { async listDomains() { return domains.map((item) => ({ ...item, target: { ...item.target } })); } };
  const applicationRegistry = { async listApplications() { return applications.map((item) => ({ ...item, proxyTarget: item.proxyTarget ? { ...item.proxyTarget } : null })); } };
  const current = previewWebsiteMigration({ domains, websites: [], applications });
  return { websiteRegistry, migrationLedger, domainRegistry, applicationRegistry, previewDigest: current.digest };
}

function input(f, overrides = {}) {
  return {
    domainId,
    applicationId,
    previewDigest: f.previewDigest,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
    migrationLedger: f.migrationLedger,
    ...overrides,
  };
}

const code = (expected) => (error) => error instanceof WebsiteMigrationCreateError && error.code === expected;

test('exact create_website_then_bind preview journals and creates one deterministic Website', async () => {
  const f = await fixture();
  const result = await createWebsiteForMigration(input(f));
  assert.equal(result.created, true);
  assert.equal(result.website.name, 'api.example.com');
  assert.equal(result.website.applicationId, applicationId);
  assert.equal(result.nextAction, 'rerun_preview_then_bind');
  assert.equal((await f.websiteRegistry.listWebsites()).length, 1);
  const ledger = await f.migrationLedger.get(domainId);
  assert.equal(ledger.state, 'website_created');
  assert.equal(ledger.createdWebsite, true);
  assert.equal(ledger.sourcePreviewDigest, f.previewDigest);
  assert.equal(ledger.websiteId, result.website.id);
});

test('retry after Website creation reconciles ledger without duplicating the Website', async () => {
  const f = await fixture();
  const first = await createWebsiteForMigration(input(f));
  const retry = await createWebsiteForMigration(input(f));
  assert.equal(retry.created, false);
  assert.equal(retry.website.id, first.website.id);
  assert.equal((await f.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await f.migrationLedger.get(domainId)).state, 'website_created');
});

test('ledger planning failure prevents Website creation', async () => {
  const f = await fixture();
  const failure = new Error('ledger unavailable');
  const migrationLedger = {
    async planWebsiteCreation() { throw failure; },
    async markWebsiteCreated() { throw new Error('must not run'); },
  };
  await assert.rejects(createWebsiteForMigration(input(f, { migrationLedger })), (error) => error === failure);
  assert.deepEqual(await f.websiteRegistry.listWebsites(), []);
});

test('retry repairs ledger when Website creation succeeded but final marker was interrupted', async () => {
  const f = await fixture();
  const realLedger = f.migrationLedger;
  let failMarker = true;
  const interruptedLedger = {
    planWebsiteCreation: (...args) => realLedger.planWebsiteCreation(...args),
    async markWebsiteCreated(...args) {
      if (failMarker) { failMarker = false; throw new Error('simulated marker failure'); }
      return realLedger.markWebsiteCreated(...args);
    },
  };
  await assert.rejects(createWebsiteForMigration(input(f, { migrationLedger: interruptedLedger })), /simulated marker failure/);
  assert.equal((await f.websiteRegistry.listWebsites()).length, 1);
  assert.equal((await realLedger.get(domainId)).state, 'creating_website');

  const retry = await createWebsiteForMigration(input(f));
  assert.equal(retry.created, false);
  assert.equal((await realLedger.get(domainId)).state, 'website_created');
  assert.equal((await f.websiteRegistry.listWebsites()).length, 1);
});

test('stale preview digest does not create or journal a Website', async () => {
  const f = await fixture();
  await assert.rejects(createWebsiteForMigration(input(f, { previewDigest: 'f'.repeat(64) })), code('website_migration_preview_stale'));
  assert.deepEqual(await f.websiteRegistry.listWebsites(), []);
  assert.equal(await f.migrationLedger.get(domainId), null);
});

test('wrong or ambiguous Application mapping is never created', async () => {
  const wrong = await fixture();
  await assert.rejects(createWebsiteForMigration(input(wrong, { applicationId: otherApplicationId })), code('website_migration_create_not_ready'));

  const applications = [application(), application(otherApplicationId, 4301)];
  const ambiguous = await fixture({ applications });
  await assert.rejects(createWebsiteForMigration(input(ambiguous)), code('website_migration_create_not_ready'));
  assert.deepEqual(await ambiguous.websiteRegistry.listWebsites(), []);
  assert.equal(await ambiguous.migrationLedger.get(domainId), null);
});

test('unresolved legacy target cannot create a migration Website', async () => {
  const f = await fixture({ applications: [application(applicationId, 4400)] });
  await assert.rejects(createWebsiteForMigration(input(f)), code('website_migration_create_not_ready'));
  assert.deepEqual(await f.websiteRegistry.listWebsites(), []);
  assert.equal(await f.migrationLedger.get(domainId), null);
});
