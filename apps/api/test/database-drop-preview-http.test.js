import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDatabaseRoutes } from '../src/database-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const applicationId = '32345678-1234-4234-8234-123456789012';
const bindingId = '42345678-1234-4234-8234-123456789012';
const credentialId = '52345678-1234-4234-8234-123456789012';
const backupId = '62345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';

function fixture({ jobs = null, credential = true } = {}) {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers]); },
    delete(path, ...handlers) { routes.push(['DELETE', path, handlers]); },
  };
  const binding = {
    id: bindingId,
    serverId,
    databaseName,
    websiteId,
    applicationId,
    unixUser: 'yunapp-abcdef012345',
    revision: 2,
  };
  const backupJob = {
    id: backupId,
    serverId,
    operation: 'database.backup',
    status: 'succeeded',
    resourceType: 'database',
    resourceId: databaseName,
    result: {
      version: 1,
      backupId,
      databaseName,
      engine: 'mariadb',
      databaseVersion: '10.11.13-MariaDB',
      dumpSha256: 'a'.repeat(64),
      dumpBytes: 4096,
      createdAt: '2026-09-17T12:00:00.000Z',
      backedUp: true,
      sideEffects: true,
      dumpPath: '/private/ignored.sql',
    },
  };
  mountDatabaseRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    jobRegistry: {
      async listJobs() { return jobs ?? [backupJob]; },
      async enqueue() { throw new Error('preview must not enqueue'); },
    },
    databaseBindingRegistry: {
      async getByDatabase(input) { return input.serverId === serverId && input.databaseName === databaseName ? binding : null; },
      async listBindings() { return [binding]; },
    },
    databaseCredentialRegistry: {
      async listCredentials() {
        return credential ? [{
          id: credentialId,
          databaseBindingId: bindingId,
          serverId,
          databaseName,
          websiteId,
          applicationId,
          siteUnixUser: binding.unixUser,
          username: 'ydb_abcdef012345abcdef012345',
          host: 'localhost',
          revision: 3,
          ciphertext: 'private',
        }] : [];
      },
    },
    databaseInventoryProvider: async () => ({
      engine: 'mariadb',
      version: '10.11.13-MariaDB',
      databases: [{ name: databaseName, sizeBytes: 8192 }],
    }),
  });
  return routes.find(([method, path]) => method === 'GET' && path.endsWith('/drop-preview'))[2].at(-1);
}

async function invoke(handler, { query = {} } = {}) {
  let payload = null;
  let error = null;
  const headers = new Map();
  const response = {
    set(name, value) { headers.set(name.toLowerCase(), value); return this; },
    json(value) { payload = value; return this; },
  };
  await handler(
    { params: { serverId, name: databaseName }, query },
    response,
    (value) => { error = value; },
  );
  return { payload, error, headers };
}

test('database drop preview exposes exact ownership backup and blockers without side effects', async () => {
  const response = await invoke(fixture());
  assert.equal(response.error, null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.payload.data.exists, true);
  assert.deepEqual(response.payload.data.binding, {
    id: bindingId,
    websiteId,
    applicationId,
    unixUser: 'yunapp-abcdef012345',
    revision: 2,
  });
  assert.deepEqual(response.payload.data.credential, {
    id: credentialId,
    username: 'ydb_abcdef012345abcdef012345',
    revision: 3,
  });
  assert.equal(response.payload.data.latestBackup.backupId, backupId);
  assert.deepEqual(response.payload.data.blockers, [
    'database_credential_exists',
    'database_binding_exists',
    'database_delete_safety_chain_pending',
  ]);
  assert.equal(response.payload.data.readyToDrop, false);
  assert.equal(response.payload.data.sideEffects, false);
  assert.match(response.payload.data.previewDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(response.payload), /private|dumpPath|ciphertext/);
});

test('database drop preview reports missing backup active work and rejects query expansion', async () => {
  const active = {
    id: '72345678-1234-4234-8234-123456789012',
    operation: 'database.restore',
    status: 'running',
  };
  const response = await invoke(fixture({ jobs: [active], credential: false }));
  assert.deepEqual(response.payload.data.blockers, [
    'database_binding_exists',
    'database_backup_required',
    'database_job_active',
    'database_delete_safety_chain_pending',
  ]);
  assert.deepEqual(response.payload.data.activeJobs, [{
    id: active.id,
    operation: active.operation,
    status: active.status,
  }]);

  const expanded = await invoke(fixture(), { query: { include: 'private' } });
  assert.equal(expanded.error?.code, 'database_drop_preview_query_invalid');
});
