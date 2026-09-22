import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DatabaseBackupResourceError,
  databaseBackupIdentity,
  databaseBackupResources,
} from '../src/database-backup-resource.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const inventoryJobId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';

function inventory(overrides = {}) {
  return {
    engine: 'mariadb',
    version: '11.4.3-MariaDB',
    databases: [
      { name: 'novasis', sizeBytes: 4096 },
      { name: 'yunsoft', sizeBytes: 8192 },
    ],
    snapshot: {
      jobId: inventoryJobId,
      refreshedAt: '2026-09-13T18:00:00.000Z',
    },
    ...overrides,
  };
}

test('database backup identity follows the existing server plus schema identity', () => {
  const first = databaseBackupIdentity({ serverId, databaseName: 'Novasis' });
  const second = databaseBackupIdentity({ serverId: serverId.toUpperCase(), databaseName: 'novasis' });

  assert.match(first, /^database:[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test('database backup resources bind inventory evidence without inventing a database UUID or revision', () => {
  const resources = databaseBackupResources({ serverId, inventory: inventory() });
  assert.equal(resources.length, 2);

  const resource = resources.find((entry) => entry.databaseName === 'novasis');
  assert.equal(resource.type, 'database');
  assert.equal(resource.serverId, serverId);
  assert.equal(Object.hasOwn(resource, 'databaseId'), false);
  assert.equal(Object.hasOwn(resource, 'revision'), false);
  assert.deepEqual(resource.policy, { disposition: 'include', reason: 'managed_database' });
  assert.deepEqual(resource.snapshot, {
    engine: 'mariadb',
    databaseVersion: '11.4.3-MariaDB',
    sizeBytes: 4096,
    inventoryJobId,
    inventoryRefreshedAt: '2026-09-13T18:00:00.000Z',
  });
});

test('database resource identity stays stable across size, engine version and inventory refreshes', () => {
  const first = databaseBackupResources({ serverId, inventory: inventory() });
  const second = databaseBackupResources({
    serverId,
    inventory: inventory({
      version: '11.4.4-MariaDB',
      databases: [
        { name: 'novasis', sizeBytes: 9999 },
        { name: 'yunsoft', sizeBytes: 12000 },
      ],
      snapshot: {
        jobId: '0bb78242-03a6-429f-9d17-7725c521437c',
        refreshedAt: '2026-09-13T19:00:00.000Z',
      },
    }),
  });

  assert.deepEqual(first.map((entry) => entry.identity), second.map((entry) => entry.identity));
  assert.notDeepEqual(first.map((entry) => entry.snapshot), second.map((entry) => entry.snapshot));
});

test('shared Roundcube schemas never enter Website backup resource choices', () => {
  const resources = databaseBackupResources({
    serverId,
    inventory: inventory({ databases: [
      { name: 'novasis', sizeBytes: 4096 },
      { name: 'roundcube', sizeBytes: 4096 },
      { name: 'ROUNDCUBEMAIL_sessions', sizeBytes: 256 },
    ] }),
  });
  assert.deepEqual(resources.map((resource) => resource.databaseName), ['novasis']);
  assert.throws(() => databaseBackupIdentity({ serverId, databaseName: 'roundcube' }), {
    code: 'database_backup_resource_name_invalid',
  });
});

test('database resource generation rejects case-insensitive duplicate schemas', () => {
  assert.throws(
    () => databaseBackupResources({
      serverId,
      inventory: inventory({ databases: [
        { name: 'Novasis', sizeBytes: 1 },
        { name: 'novasis', sizeBytes: 2 },
      ] }),
    }),
    (error) => error instanceof DatabaseBackupResourceError
      && error.code === 'database_backup_resource_duplicate',
  );
});

test('database resource generation rejects reserved schemas and malformed inventory evidence', () => {
  assert.throws(
    () => databaseBackupResources({
      serverId,
      inventory: inventory({ databases: [{ name: 'mysql', sizeBytes: 1 }] }),
    }),
    (error) => error instanceof DatabaseBackupResourceError
      && error.code === 'database_backup_resource_name_invalid',
  );

  assert.throws(
    () => databaseBackupResources({
      serverId,
      inventory: inventory({ snapshot: { jobId: 'not-a-job', refreshedAt: 'bad-time' } }),
    }),
    (error) => error instanceof DatabaseBackupResourceError
      && error.code === 'database_backup_resource_snapshot_invalid',
  );
});
