import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseBindingRegistry,
  DatabaseBindingRegistryError,
} from '../src/database-binding-registry.js';

const serverId = '11111111-1111-4111-8111-111111111111';
const websiteId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const unixUser = 'yunapp-abcdef123456';

function dependencies(overrides = {}) {
  return {
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => id === websiteId ? {
      id,
      serverId,
      applicationId,
      runtimeType: 'node',
      unixUser,
    } : null,
    getApplication: async (id) => id === applicationId ? {
      id,
      serverId,
      type: 'node',
    } : null,
    ...overrides,
  };
}

test('database binding persists exact Website Application and site-user ownership', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'database-bindings.json');
  const registry = createDatabaseBindingRegistry({ filePath, ...dependencies() });
  await registry.init();
  const binding = await registry.bindDatabase({
    serverId,
    databaseName: 'app_db',
    websiteId,
    applicationId,
    confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
  });
  assert.equal(binding.databaseName, 'app_db');
  assert.equal(binding.websiteId, websiteId);
  assert.equal(binding.applicationId, applicationId);
  assert.equal(binding.unixUser, unixUser);
  assert.equal(binding.revision, 1);

  const reopened = createDatabaseBindingRegistry({ filePath, ...dependencies() });
  await reopened.init();
  assert.deepEqual(await reopened.getBinding(binding.id), binding);
  assert.deepEqual(await reopened.getByDatabase({ serverId, databaseName: 'app_db' }), binding);
});

test('database binding rejects cross-server unsupported Website and explicit Application mismatch', async () => {
  for (const [overrides, code] of [
    [{ getWebsite: async () => ({ id: websiteId, serverId: '44444444-4444-4444-8444-444444444444', applicationId, runtimeType: 'node', unixUser }) }, 'database_binding_website_server_mismatch'],
    [{ getWebsite: async () => ({ id: websiteId, serverId, applicationId: null, runtimeType: 'proxy', unixUser: null }) }, 'database_binding_website_unsupported'],
  ]) {
    const registry = createDatabaseBindingRegistry({ ...dependencies(overrides) });
    await assert.rejects(
      registry.bindDatabase({
        serverId,
        databaseName: 'app_db',
        websiteId,
        confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
      }),
      (error) => error instanceof DatabaseBindingRegistryError && error.code === code,
    );
  }

  const registry = createDatabaseBindingRegistry({ ...dependencies() });
  await assert.rejects(
    registry.bindDatabase({
      serverId,
      databaseName: 'app_db',
      websiteId,
      applicationId: '55555555-5555-4555-8555-555555555555',
      confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
    }),
    (error) => error instanceof DatabaseBindingRegistryError && error.code === 'database_binding_application_mismatch',
  );
});

test('database identity is unique per server case-insensitively and bind confirmation is exact', async () => {
  const registry = createDatabaseBindingRegistry({ ...dependencies() });
  await assert.rejects(
    registry.bindDatabase({ serverId, databaseName: 'app_db', websiteId, confirmation: 'wrong' }),
    (error) => error instanceof DatabaseBindingRegistryError && error.code === 'database_binding_confirmation_mismatch',
  );
  await registry.bindDatabase({
    serverId,
    databaseName: 'app_db',
    websiteId,
    confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
  });
  await assert.rejects(
    registry.bindDatabase({
      serverId,
      databaseName: 'APP_DB',
      websiteId,
      confirmation: `bind-database:${serverId}:APP_DB:${websiteId}`,
    }),
    (error) => error instanceof DatabaseBindingRegistryError && error.code === 'database_already_bound',
  );
});

test('database unbind is revisioned and typed-confirmed', async () => {
  const registry = createDatabaseBindingRegistry({ ...dependencies() });
  const binding = await registry.bindDatabase({
    serverId,
    databaseName: 'app_db',
    websiteId,
    confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
  });
  await assert.rejects(
    registry.unbindDatabase(binding.id, { expectedRevision: 2, confirmation: `unbind-database:${binding.id}:2` }),
    (error) => error instanceof DatabaseBindingRegistryError && error.code === 'database_binding_revision_conflict',
  );
  const removed = await registry.unbindDatabase(binding.id, {
    expectedRevision: 1,
    confirmation: `unbind-database:${binding.id}:1`,
  });
  assert.equal(removed.unbound, true);
  assert.equal(await registry.getBinding(binding.id), null);
});

test('persisted binding with stale Website site-user fails closed on reopen', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-binding-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'database-bindings.json');
  const registry = createDatabaseBindingRegistry({ filePath, ...dependencies() });
  await registry.init();
  await registry.bindDatabase({
    serverId,
    databaseName: 'app_db',
    websiteId,
    confirmation: `bind-database:${serverId}:app_db:${websiteId}`,
  });

  const drifted = createDatabaseBindingRegistry({
    filePath,
    ...dependencies({
      getWebsite: async () => ({
        id: websiteId,
        serverId,
        applicationId,
        runtimeType: 'node',
        unixUser: 'yunapp-111111111111',
      }),
    }),
  });
  await assert.rejects(
    drifted.init(),
    (error) => error instanceof DatabaseBindingRegistryError && error.code === 'database_binding_site_user_drift',
  );
});
