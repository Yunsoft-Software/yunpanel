import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAllWebsiteImpactProviders,
  createDatabaseImpactProvider,
  createLogScopeImpactProvider,
  createRuntimeBindingImpactProvider,
  createSftpKeyImpactProvider,
  createUnixIdentityImpactProvider,
} from '../src/website-delete-impact-providers.js';

test('createDatabaseImpactProvider returns database bindings for website', async () => {
  const bindings = [
    { id: 'b-1', websiteId: 'w-1', databaseName: 'db_one' },
    { id: 'b-2', websiteId: 'w-1', databaseName: 'db_two' },
  ];
  const provider = createDatabaseImpactProvider({
    databaseBindingRegistry: {
      async listBindings({ websiteId }) {
        return bindings.filter((b) => b.websiteId === websiteId);
      },
    },
  });

  // With websiteId
  const result = await provider({ websiteId: 'w-1' });
  assert.deepEqual(result, [
    { id: 'b-1', state: 'db_one' },
    { id: 'b-2', state: 'db_two' },
  ]);

  // Without websiteId
  assert.deepEqual(await provider({ websiteId: null }), []);
});

test('createSftpKeyImpactProvider returns sftp keys for website', async () => {
  const keys = [
    { id: 'k-1', websiteId: 'w-1', status: 'active' },
    { id: 'k-2', websiteId: 'w-1', status: 'revoked' },
  ];
  const provider = createSftpKeyImpactProvider({
    websiteSftpKeyRegistry: {
      async listKeys(websiteId) {
        return keys.filter((k) => k.websiteId === websiteId);
      },
    },
  });

  const result = await provider({ websiteId: 'w-1' });
  assert.deepEqual(result, [
    { id: 'k-1', state: 'active' },
    { id: 'k-2', state: 'revoked' },
  ]);

  assert.deepEqual(await provider({ websiteId: null }), []);
});

test('createRuntimeBindingImpactProvider returns runtime binding for application', async () => {
  const provider = createRuntimeBindingImpactProvider({
    runtimeBindingRegistry: {
      async getBinding(appId) {
        if (appId === 'app-1') return { id: 'rb-1', state: 'active' };
        return null;
      },
    },
  });

  assert.deepEqual(await provider({ applicationId: 'app-1' }), [{ id: 'rb-1', state: 'active' }]);
  assert.deepEqual(await provider({ applicationId: 'app-2' }), []);
  assert.deepEqual(await provider({ applicationId: null }), []);
});

test('createUnixIdentityImpactProvider returns system user for website', async () => {
  const provider = createUnixIdentityImpactProvider({
    websiteRegistry: {
      async getWebsite(id) {
        if (id === 'w-1') return { id: 'w-1', systemUser: 'yunapp-123456789012' };
        if (id === 'w-2') return { id: 'w-2', unixUser: 'yunapp-abcdef123456' };
        return null;
      },
    },
  });

  assert.deepEqual(await provider({ websiteId: 'w-1' }), [{ id: 'yunapp-123456789012', state: 'active' }]);
  assert.deepEqual(await provider({ websiteId: 'w-2' }), [{ id: 'yunapp-abcdef123456', state: 'active' }]);
  assert.deepEqual(await provider({ websiteId: 'w-missing' }), []);
  assert.deepEqual(await provider({ websiteId: null }), []);
});

test('createLogScopeImpactProvider returns log scope for website', async () => {
  const provider = createLogScopeImpactProvider({
    websiteRegistry: {
      async getWebsite(id) {
        if (id === 'w-1') return { id: 'w-1' };
        return null;
      },
    },
  });

  assert.deepEqual(await provider({ websiteId: 'w-1' }), [{ id: 'w-1', state: 'managed' }]);
  assert.deepEqual(await provider({ websiteId: 'w-missing' }), []);
  assert.deepEqual(await provider({ websiteId: null }), []);
});

test('createAllWebsiteImpactProviders bundles available providers', async () => {
  const bundle = createAllWebsiteImpactProviders({
    databaseBindingRegistry: { async listBindings() { return []; } },
    websiteSftpKeyRegistry: { async listKeys() { return []; } },
    runtimeBindingRegistry: { async getBinding() { return null; } },
    websiteRegistry: { async getWebsite() { return null; } },
  });

  assert.equal(typeof bundle.databases, 'function');
  assert.equal(typeof bundle.sftpKeys, 'function');
  assert.equal(typeof bundle.runtimeBindings, 'function');
  assert.equal(typeof bundle.unixIdentities, 'function');
  assert.equal(typeof bundle.logScopes, 'function');
});
