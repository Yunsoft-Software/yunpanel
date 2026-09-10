import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry } from '../src/domain-registry.js';
import { bindLegacyDomainToWebsite, WebsiteMigrationBindError } from '../src/website-migration-bind.js';
import { createWebsiteMigrationLedger } from '../src/website-migration-ledger.js';
import { previewWebsiteMigration } from '../src/website-migration-preview.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const wrongWebsiteId = 'da25db71-1a5d-414e-af9f-f1e7f9a9baf7';

function app(overrides = {}) {
  return { id: applicationId, serverId, type: 'node', proxyTarget: { host: '127.0.0.1', port: 4301 }, ...overrides };
}
function website(id = websiteId, overrides = {}) {
  return { id, serverId, applicationId, runtimeType: 'node', ...overrides };
}

async function fixture({ websites = [website()], applications = [app()] } = {}) {
  const websiteMap = new Map(websites.map((item) => [item.id, item]));
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websiteMap.get(id) ?? null,
  });
  const domain = await domainRegistry.createDomain({
    serverId, primaryDomain: 'api.example.com', targetType: 'proxy', target: { upstreamPort: 4301 },
  });
  return {
    domain,
    domainRegistry,
    migrationLedger: createWebsiteMigrationLedger(),
    websites,
    applications,
    websiteRegistry: { async listWebsites() { return websites.map((item) => ({ ...item })); } },
    applicationRegistry: { async listApplications() { return applications.map((item) => ({ ...item })); } },
  };
}

async function digestFor(f) {
  return previewWebsiteMigration({
    domains: await f.domainRegistry.listDomains(), websites: f.websites, applications: f.applications,
  }).digest;
}

const code = (expected) => (error) => error instanceof WebsiteMigrationBindError && error.code === expected;

async function bind(f, targetWebsiteId = websiteId, previewDigest = null, migrationLedger = f.migrationLedger) {
  return bindLegacyDomainToWebsite({
    domainId: f.domain.id,
    websiteId: targetWebsiteId,
    previewDigest: previewDigest ?? await digestFor(f),
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    applicationRegistry: f.applicationRegistry,
    migrationLedger,
  });
}

test('exact ready preview journals then binds legacy Domain to an existing Website', async () => {
  const f = await fixture();
  const before = await f.domainRegistry.getDomain(f.domain.id);
  const approvedDigest = await digestFor(f);
  const result = await bind(f, websiteId, approvedDigest);
  assert.equal(result.migrated, true);
  assert.equal(result.ledgerTracked, true);
  assert.equal(result.domain.websiteId, websiteId);
  assert.equal(result.previewDigest, approvedDigest);
  assert.equal(result.domain.desiredRevision, before.desiredRevision);
  assert.deepEqual(result.domain.target, before.target);
  const ledger = await f.migrationLedger.get(f.domain.id);
  assert.equal(ledger.state, 'bound');
  assert.equal(ledger.createdWebsite, false);
  assert.equal(ledger.bindingPreviewDigest, approvedDigest);

  const retry = await bind(f, websiteId, approvedDigest);
  assert.equal(retry.migrated, false);
  assert.equal(retry.ledgerTracked, true);
  assert.equal(retry.domain.websiteId, websiteId);
  assert.equal((await f.migrationLedger.get(f.domain.id)).state, 'bound');
});

test('binding ledger planning failure prevents Domain mutation', async () => {
  const f = await fixture();
  const failure = new Error('ledger unavailable');
  const ledger = {
    async get() { return null; },
    async planBinding() { throw failure; },
    async markBound() { throw new Error('must not run'); },
  };
  await assert.rejects(bind(f, websiteId, await digestFor(f), ledger), (error) => error === failure);
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
});

test('retry repairs ledger when Domain bind succeeded but terminal ledger marker was interrupted', async () => {
  const f = await fixture();
  const approvedDigest = await digestFor(f);
  let failMarker = true;
  const interrupted = {
    get: (...args) => f.migrationLedger.get(...args),
    planBinding: (...args) => f.migrationLedger.planBinding(...args),
    async markBound(...args) {
      if (failMarker) { failMarker = false; throw new Error('simulated bound marker failure'); }
      return f.migrationLedger.markBound(...args);
    },
  };

  await assert.rejects(bind(f, websiteId, approvedDigest, interrupted), /simulated bound marker failure/);
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, websiteId);
  assert.equal((await f.migrationLedger.get(f.domain.id)).state, 'binding_planned');

  const retry = await bind(f, websiteId, approvedDigest);
  assert.equal(retry.migrated, false);
  assert.equal(retry.ledgerTracked, true);
  assert.equal((await f.migrationLedger.get(f.domain.id)).state, 'bound');
});

test('state drift after preview rejects mutation before ledger planning', async () => {
  const f = await fixture();
  const approvedDigest = await digestFor(f);
  f.applications[0] = app({ proxyTarget: { host: '127.0.0.1', port: 5500 } });
  await assert.rejects(bind(f, websiteId, approvedDigest), code('website_migration_preview_stale'));
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
  assert.equal(await f.migrationLedger.get(f.domain.id), null);
});

test('wrong Website ID is not authorized by current migration preview', async () => {
  const f = await fixture({ websites: [website(), website(wrongWebsiteId, { applicationId: null, runtimeType: 'proxy' })] });
  await assert.rejects(bind(f, wrongWebsiteId), code('website_migration_binding_not_ready'));
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
  assert.equal(await f.migrationLedger.get(f.domain.id), null);
});

test('create-Website and ambiguous preview states cannot enter existing-Website bind', async () => {
  const noWebsite = await fixture({ websites: [] });
  await assert.rejects(bind(noWebsite), code('website_migration_binding_not_ready'));
  assert.equal((await noWebsite.domainRegistry.getDomain(noWebsite.domain.id)).websiteId, null);

  const secondAppId = '55eb283e-b1a4-471a-89fe-74959f83d482';
  const ambiguous = await fixture({
    websites: [website()],
    applications: [app(), { ...app(), id: secondAppId }],
  });
  await assert.rejects(bind(ambiguous), code('website_migration_binding_not_ready'));
  assert.equal((await ambiguous.domainRegistry.getDomain(ambiguous.domain.id)).websiteId, null);
});

test('retry against a different Website refuses existing binding conflict', async () => {
  const f = await fixture({ websites: [website(), website(wrongWebsiteId, { applicationId: null, runtimeType: 'proxy' })] });
  const approvedDigest = await digestFor(f);
  await bind(f, websiteId, approvedDigest);
  await assert.rejects(bind(f, wrongWebsiteId, approvedDigest), code('website_migration_binding_conflict'));
});

test('already-bound Domain without migration ledger is not retroactively marked migratable', async () => {
  const f = await fixture();
  await f.domainRegistry.bindWebsite(f.domain.id, websiteId);
  const result = await bind(f, websiteId, 'a'.repeat(64));
  assert.equal(result.migrated, false);
  assert.equal(result.ledgerTracked, false);
  assert.equal(await f.migrationLedger.get(f.domain.id), null);
});

test('migration bind requires a canonical preview digest', async () => {
  const f = await fixture();
  for (const previewDigest of [null, '', 'ABC', 'g'.repeat(64)]) {
    await assert.rejects(bindLegacyDomainToWebsite({
      domainId: f.domain.id,
      websiteId,
      previewDigest,
      domainRegistry: f.domainRegistry,
      websiteRegistry: f.websiteRegistry,
      applicationRegistry: f.applicationRegistry,
      migrationLedger: f.migrationLedger,
    }), code('website_migration_preview_digest_invalid'));
  }
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
});
