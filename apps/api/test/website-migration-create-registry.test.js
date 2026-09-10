import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRegistry, WebsiteRegistryError, websiteRegistryInternals } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const otherApplicationId = '55eb283e-b1a4-471a-89fe-74959f83d482';
const domainId = '0ef7e00b-1b85-4938-b726-247c94679c66';

function application(id = applicationId) {
  return { id, serverId, type: 'node', webRoot: null };
}

function registry(apps = new Map([[applicationId, application()], [otherApplicationId, application(otherApplicationId)]])) {
  return createWebsiteRegistry({
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => apps.get(id) ?? null,
  });
}

test('migration Website ID is deterministic, canonical and stable across candidate drift', () => {
  const lower = websiteRegistryInternals.migrationWebsiteId(domainId, applicationId);
  const upper = websiteRegistryInternals.migrationWebsiteId(domainId.toUpperCase(), applicationId.toUpperCase());
  assert.equal(lower, upper);
  assert.equal(websiteRegistryInternals.migrationWebsiteId(domainId, otherApplicationId), lower);
  assert.match(lower, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('migration Website creation is idempotent for exact Domain Application identity', async () => {
  const websites = registry();
  const first = await websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId });
  const retry = await websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId });
  assert.deepEqual(retry, first);
  assert.equal(first.id, websiteRegistryInternals.migrationWebsiteId(domainId, applicationId));
  assert.equal(first.applicationId, applicationId);
  assert.equal((await websites.listWebsites()).length, 1);
});

test('migration Website identity does not silently accept a changed name or binding', async () => {
  const websites = registry();
  const created = await websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId });
  await assert.rejects(
    websites.createMigrationWebsite({ domainId, serverId, name: 'changed.example.com', applicationId }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'migration_website_identity_conflict',
  );
  await assert.rejects(
    websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId: otherApplicationId }),
    (error) => error instanceof WebsiteRegistryError && ['migration_website_identity_conflict', 'application_already_bound'].includes(error.code),
  );

  for (const nextName of ['temporarily changed', 'api.example.com']) {
    const preview = await websites.previewWebsiteUpdate(created.id, { name: nextName });
    await websites.updateWebsite({
      websiteId: created.id,
      expectedRevision: preview.currentRevision,
      changes: { name: nextName },
      previewFingerprint: preview.fingerprint,
    });
  }
  await assert.rejects(
    websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'migration_website_identity_conflict',
  );
});

test('migration creation refuses applications already bound by ordinary Website creation', async () => {
  const websites = registry();
  const ordinary = await websites.createWebsite({ serverId, name: 'Ordinary', applicationId });
  assert.notEqual(ordinary.id, websiteRegistryInternals.migrationWebsiteId(domainId, applicationId));
  await assert.rejects(
    websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'application_already_bound',
  );
  assert.equal((await websites.listWebsites()).length, 1);
});
