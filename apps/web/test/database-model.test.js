import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseInventoryView, formatDatabaseBytes, validDatabaseName } from '../src/workspace/database-model.js';

test('database names mirror the host/protocol safety boundary', () => {
  assert.equal(validDatabaseName('app_main'), true);
  assert.equal(validDatabaseName('Customer42'), true);
  assert.equal(validDatabaseName('mysql'), false);
  assert.equal(validDatabaseName('information_schema'), false);
  assert.equal(validDatabaseName('app-main'), false);
  assert.equal(validDatabaseName('../app'), false);
});

test('database byte formatter stays compact and deterministic', () => {
  assert.equal(formatDatabaseBytes(0), '0 B');
  assert.equal(formatDatabaseBytes(1024), '1 KB');
  assert.equal(formatDatabaseBytes(1536), '1.5 KB');
  assert.equal(formatDatabaseBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(formatDatabaseBytes(-1), '—');
});

test('database inventory view sorts safe rows and computes total size without trusting malformed entries', () => {
  const ownership = {
    bindingId: '12345678-1234-4234-8234-123456789012',
    websiteId: '22345678-1234-4234-8234-123456789012',
    applicationId: '32345678-1234-4234-8234-123456789012',
    unixUser: 'yunapp-abcdef012345',
    revision: 2,
    credential: {
      id: '42345678-1234-4234-8234-123456789012',
      username: 'ydb_abcdef012345abcdef012345',
      host: 'localhost',
      revision: 3,
    },
  };
  const view = databaseInventoryView({
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [
      { name: 'zeta', sizeBytes: 2048 },
      { name: 'mysql', sizeBytes: 999 },
      { name: 'alpha', sizeBytes: 1024, ownership },
      { name: 'broken-name', sizeBytes: 1 },
    ],
    live: true,
    health: {
      available: true,
      ready: true,
      reason: null,
      connection: {
        protocol: 'socket',
        adminAccount: 'root@localhost',
        loginAccount: 'root@localhost',
        authPlugin: 'unix_socket',
        nativeSocketAuth: true,
      },
      hygiene: {
        anonymousAccountsAbsent: true,
        remoteRootAccountsAbsent: true,
        testSchemaAbsent: true,
      },
    },
    ownership: { bindingCount: 1, credentialCount: 1, missingDatabaseBindingCount: 0 },
    snapshot: { jobId: 'job-1', refreshedAt: '2026-09-10T00:00:00.000Z', raw: 'drop' },
  });
  assert.deepEqual(view.databases.map((entry) => entry.name), ['alpha', 'zeta']);
  assert.equal(view.totalBytes, 3072);
  assert.equal(view.live, true);
  assert.equal(view.health.ready, true);
  assert.deepEqual(view.health.connection, {
    adminAccount: 'root@localhost',
    authPlugin: 'unix_socket',
    nativeSocketAuth: true,
  });
  assert.equal(view.databases[0].ownership.credential.username, ownership.credential.username);
  assert.deepEqual(view.ownership, { bindingCount: 1, credentialCount: 1, missingDatabaseBindingCount: 0 });
  assert.deepEqual(view.snapshot, { jobId: 'job-1', refreshedAt: '2026-09-10T00:00:00.000Z' });
});
