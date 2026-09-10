import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { DatabaseJobResultError, sanitizeDatabaseJobResult } from '../src/database-job-result.js';

const base = { engine: 'mariadb', version: '10.11.13-MariaDB' };

test('database inspection strips unknown fields and preserves bounded inventory metadata', () => {
  const sanitized = sanitizeDatabaseJobResult(
    { operation: OPERATIONS.DATABASE_INSPECT, payload: {} },
    {
      ...base,
      databases: [{ name: 'app-main', sizeBytes: 1024, sql: 'SECRET' }],
      clientPath: '/usr/bin/mariadb',
      raw: 'must not persist',
    },
  );
  assert.deepEqual(sanitized, {
    engine: 'mariadb',
    version: '10.11.13-MariaDB',
    databases: [{ name: 'app-main', sizeBytes: 1024 }],
  });
});

test('database mutation result must match the exact queued database identity', () => {
  const created = sanitizeDatabaseJobResult(
    { operation: OPERATIONS.DATABASE_CREATE, payload: { name: 'customer_42' } },
    { ...base, database: { name: 'customer_42', sizeBytes: 0, extra: 'drop-me' }, created: true, raw: 'drop-me' },
  );
  assert.deepEqual(created, {
    engine: 'mariadb', version: '10.11.13-MariaDB', database: { name: 'customer_42', sizeBytes: 0 }, created: true,
  });
  assert.throws(
    () => sanitizeDatabaseJobResult(
      { operation: OPERATIONS.DATABASE_DELETE, payload: { name: 'customer_42' } },
      { ...base, database: { name: 'other_db', sizeBytes: 10 }, deleted: true },
    ),
    (error) => error instanceof DatabaseJobResultError && error.code === 'invalid_job_result',
  );
});

test('system schemas, duplicate names and unsafe version metadata fail closed', () => {
  for (const result of [
    { ...base, databases: [{ name: 'mysql', sizeBytes: 1 }] },
    { ...base, databases: [{ name: 'App', sizeBytes: 1 }, { name: 'app', sizeBytes: 2 }] },
    { engine: 'mysql', version: '8.0\nSECRET', databases: [] },
    { engine: 'postgres', version: '16', databases: [] },
  ]) {
    assert.throws(
      () => sanitizeDatabaseJobResult({ operation: OPERATIONS.DATABASE_INSPECT, payload: {} }, result),
      (error) => error instanceof DatabaseJobResultError && error.code === 'invalid_job_result',
    );
  }
});

test('database delete keeps only the deleted confirmation and prior bounded size metadata', () => {
  const deleted = sanitizeDatabaseJobResult(
    { operation: OPERATIONS.DATABASE_DELETE, payload: { name: 'archive_db' } },
    { engine: 'mysql', version: '8.0.43', database: { name: 'archive_db', sizeBytes: 2048 }, deleted: true, stdout: 'secret' },
  );
  assert.deepEqual(deleted, {
    engine: 'mysql', version: '8.0.43', database: { name: 'archive_db', sizeBytes: 2048 }, deleted: true,
  });
});
