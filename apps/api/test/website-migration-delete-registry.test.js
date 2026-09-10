import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRegistry, WebsiteRegistryError, websiteRegistryInternals } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const domainId = '0ef7e00b-1b85-4938-b726-247c94679c66';
const otherDomainId = '2f4d1b59-b32e-42b1-83dd-a7a6151a2e5d';

function app() {
  return { id: applicationId, serverId, type: 'node', webRoot: null };
}

function registry() {
  return createWebsiteRegistry({
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => id === applicationId ? app() : null,
  });
}

test('exact deterministic migration Website can be removed and retry is idempotent', async () => {
  const websites = registry();
  const created = await websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId });
  const result = await websites.deleteMigrationWebsite({
    domainId, applicationId, websiteId: created.id, serverId, name: 'api.example.com',
  });
  assert.deepEqual(result, { deleted: true, websiteId: created.id });
  assert.deepEqual(await websites.listWebsites(), []);
  assert.deepEqual(await websites.deleteMigrationWebsite({
    domainId, applicationId, websiteId: created.id, serverId, name: 'api.example.com',
  }), { deleted: false, websiteId: created.id });
});

test('ordinary Website cannot be deleted through migration rollback primitive', async () => {
  const websites = registry();
  const ordinary = await websites.createWebsite({ serverId, name: 'api.example.com', applicationId });
  const expected = websiteRegistryInternals.migrationWebsiteId(domainId, applicationId);
  assert.notEqual(ordinary.id, expected);
  await assert.rejects(
    websites.deleteMigrationWebsite({ domainId, applicationId, websiteId: ordinary.id, serverId, name: 'api.example.com' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'migration_website_delete_identity_mismatch',
  );
  assert.equal((await websites.listWebsites()).length, 1);
});

test('migration delete rejects changed Domain identity or current Website state', async () => {
  const websites = registry();
  const created = await websites.createMigrationWebsite({ domainId, serverId, name: 'api.example.com', applicationId });

  await assert.rejects(
    websites.deleteMigrationWebsite({ domainId: otherDomainId, applicationId, websiteId: created.id, serverId, name: 'api.example.com' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'migration_website_delete_identity_mismatch',
  );
  await assert.rejects(
    websites.deleteMigrationWebsite({ domainId, applicationId, websiteId: created.id, serverId, name: 'changed.example.com' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'migration_website_delete_state_mismatch',
  );
  assert.equal((await websites.listWebsites()).length, 1);
});
