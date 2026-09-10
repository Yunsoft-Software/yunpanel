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
  const view = databaseInventoryView({
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [
      { name: 'zeta', sizeBytes: 2048 },
      { name: 'mysql', sizeBytes: 999 },
      { name: 'alpha', sizeBytes: 1024 },
      { name: 'broken-name', sizeBytes: 1 },
    ],
    snapshot: { jobId: 'job-1', refreshedAt: '2026-09-10T00:00:00.000Z', raw: 'drop' },
  });
  assert.deepEqual(view.databases.map((entry) => entry.name), ['alpha', 'zeta']);
  assert.equal(view.totalBytes, 3072);
  assert.deepEqual(view.snapshot, { jobId: 'job-1', refreshedAt: '2026-09-10T00:00:00.000Z' });
});
