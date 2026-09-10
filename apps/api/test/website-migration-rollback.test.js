import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createWebsiteMigrationLedger } from '../src/website-migration-ledger.js';
import { createWebsiteMigrationPolicyStore } from '../src/website-migration-policy.js';
import { rollbackWebsiteMigrationBinding, WebsiteMigrationRollbackError } from '../src/website-migration-rollback.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const domainId = '0ef7e00b-1b85-4938-b726-247c94679c66';
const otherDomainId = '2f4d1b59-b32e-42b1-83dd-a7a6151a2e5d';
const bindingDigest = 'b'.repeat(64);
const sourceDigest = 'a'.repeat(64);

function application() {
  return { id: applicationId, serverId, type: 'node', webRoot: null };
}

async function baseFixture() {
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => id === applicationId ? application() : null,
  });
  const policy = createWebsiteMigrationPolicyStore();
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    websiteBindingRequired: () => policy.snapshot().websiteBindingRequired,
  });
  const ledger = createWebsiteMigrationLedger();
  return { websiteRegistry, domainRegistry, policy, ledger };
}

async function boundFixture({ createdWebsite }) {
  const f = await baseFixture();
  const domain = await f.domainRegistry.createDomain({
    serverId,
    primaryDomain: 'api.example.com',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
  });
  let website;
  if (createdWebsite) {
    website = await f.websiteRegistry.createMigrationWebsite({ domainId: domain.id, serverId, name: domain.primaryDomain, applicationId });
    await f.ledger.planWebsiteCreation({ domainId: domain.id, applicationId, websiteId: website.id, sourcePreviewDigest: sourceDigest });
    await f.ledger.markWebsiteCreated({ domainId: domain.id, applicationId, websiteId: website.id });
  } else {
    website = await f.websiteRegistry.createWebsite({ serverId, name: 'Existing Website', applicationId });
  }
  await f.ledger.planBinding({ domainId: domain.id, applicationId, websiteId: website.id, previewDigest: bindingDigest, createdWebsite });
  await f.domainRegistry.bindWebsite(domain.id, website.id);
  await f.ledger.markBound({ domainId: domain.id, applicationId, websiteId: website.id });
  return { ...f, domain, website };
}

function rollbackInput(f, overrides = {}) {
  return {
    domainId: f.domain.id,
    websiteId: f.website.id,
    bindingPreviewDigest: bindingDigest,
    websiteMigrationPolicy: f.policy,
    migrationLedger: f.ledger,
    domainRegistry: f.domainRegistry,
    websiteRegistry: f.websiteRegistry,
    ...overrides,
  };
}

const code = (expected) => (error) => error instanceof WebsiteMigrationRollbackError && error.code === expected;

test('rollback of migration binding to an existing Website preserves the Website resource', async () => {
  const f = await boundFixture({ createdWebsite: false });
  const before = await f.domainRegistry.getDomain(f.domain.id);
  const result = await rollbackWebsiteMigrationBinding(rollbackInput(f));
  assert.equal(result.rolledBack, true);
  assert.equal(result.websiteDeleted, false);
  assert.equal(result.domain.websiteId, null);
  assert.ok(await f.websiteRegistry.getWebsite(f.website.id));
  assert.equal(result.domain.desiredRevision, before.desiredRevision);
  assert.deepEqual(result.domain.target, before.target);
  assert.equal((await f.ledger.get(f.domain.id)).state, 'rolled_back');
});

test('rollback removes deterministic Website created by migration after Domain unbind', async () => {
  const f = await boundFixture({ createdWebsite: true });
  const result = await rollbackWebsiteMigrationBinding(rollbackInput(f));
  assert.equal(result.rolledBack, true);
  assert.equal(result.websiteDeleted, true);
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
  assert.equal(await f.websiteRegistry.getWebsite(f.website.id), null);
  assert.equal((await f.ledger.get(f.domain.id)).state, 'rolled_back');

  const retry = await rollbackWebsiteMigrationBinding(rollbackInput(f));
  assert.equal(retry.rolledBack, false);
  assert.equal(retry.websiteDeleted, true);
});

test('enforced policy and wrong ledger digest block rollback before resource mutation', async () => {
  const f = await boundFixture({ createdWebsite: false });
  await f.policy.finalize({
    preview: { version: 1, digest: sourceDigest, destructive: false, autoApply: false, counts: { total: 1, alreadyBound: 1, ready: 0, ambiguous: 0, unresolved: 0 }, items: [{ status: 'already_bound', action: 'none', requiresConfirmation: false }] },
    previewDigest: sourceDigest,
  });
  await assert.rejects(rollbackWebsiteMigrationBinding(rollbackInput(f)), code('website_migration_policy_rollback_required'));
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, f.website.id);
  assert.equal((await f.ledger.get(f.domain.id)).state, 'bound');

  await f.policy.rollback({ enforcedDigest: sourceDigest });
  await assert.rejects(rollbackWebsiteMigrationBinding(rollbackInput(f, { bindingPreviewDigest: 'c'.repeat(64) })), code('website_migration_rollback_identity_mismatch'));
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, f.website.id);
});

test('migration-created Website is not deleted while another Domain still references it', async () => {
  const f = await boundFixture({ createdWebsite: true });
  const other = await f.domainRegistry.createDomain({
    serverId,
    primaryDomain: 'alias.example.com',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
  });
  await f.domainRegistry.bindWebsite(other.id, f.website.id);

  await assert.rejects(rollbackWebsiteMigrationBinding(rollbackInput(f)), code('website_migration_rollback_website_in_use'));
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
  assert.equal((await f.domainRegistry.getDomain(other.id)).websiteId, f.website.id);
  assert.ok(await f.websiteRegistry.getWebsite(f.website.id));
  assert.equal((await f.ledger.get(f.domain.id)).state, 'rolling_back');
});

test('retry completes ledger after resources rolled back but final marker was interrupted', async () => {
  const f = await boundFixture({ createdWebsite: true });
  let failMarker = true;
  const interrupted = {
    get: (...args) => f.ledger.get(...args),
    beginRollback: (...args) => f.ledger.beginRollback(...args),
    async markRolledBack(...args) {
      if (failMarker) { failMarker = false; throw new Error('simulated rollback marker failure'); }
      return f.ledger.markRolledBack(...args);
    },
  };
  await assert.rejects(rollbackWebsiteMigrationBinding(rollbackInput(f, { migrationLedger: interrupted })), /simulated rollback marker failure/);
  assert.equal((await f.domainRegistry.getDomain(f.domain.id)).websiteId, null);
  assert.equal(await f.websiteRegistry.getWebsite(f.website.id), null);
  assert.equal((await f.ledger.get(f.domain.id)).state, 'rolling_back');

  const retry = await rollbackWebsiteMigrationBinding(rollbackInput(f));
  assert.equal(retry.rolledBack, true);
  assert.equal((await f.ledger.get(f.domain.id)).state, 'rolled_back');
});
