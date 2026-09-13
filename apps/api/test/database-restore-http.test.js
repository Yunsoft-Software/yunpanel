import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseBackupOperationsError } from '../src/database-backup-operations.js';
import { JobRegistryError } from '../src/job-registry.js';
import {
  DatabaseRestoreHttpError,
  mountDatabaseRestoreRoutes,
} from '../src/database-restore-http.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const databaseName = 'app_main';
const backupId = '22345678-1234-4234-8234-123456789012';
const previewDigest = 'a'.repeat(64);
const backupSha256 = 'b'.repeat(64);
const confirmation = `restore-database:${databaseName}:${previewDigest}`;

function mounted({ previewError = null, queueError = null } = {}) {
  const routes = [];
  const calls = [];
  const app = {
    post(path, ...handlers) { routes.push([path, handlers]); },
  };
  const service = {
    async previewRestore(input) {
      calls.push(['preview', structuredClone(input)]);
      if (previewError) throw previewError;
      return {
        version: 1,
        operation: 'database_restore',
        serverId,
        databaseName,
        backupId,
        backupSha256,
        backupBytes: 4096,
        engine: 'mariadb',
        databaseVersion: '10.11.13-MariaDB',
        previewDigest,
        confirmation,
        sideEffects: false,
      };
    },
    async queueRestore(input) {
      calls.push(['queue', structuredClone(input)]);
      if (queueError) throw queueError;
      return {
        previewDigest,
        backupSha256,
        job: { id: '32345678-1234-4234-8234-123456789012', status: 'queued' },
      };
    },
  };
  mountDatabaseRestoreRoutes(app, {
    registry: { async getServer(id) { return id === serverId ? { id } : null; } },
    databaseBackupOperationsService: service,
  });
  return {
    calls,
    preview: routes.find(([path]) => path.endsWith('/restore-preview'))?.[1].at(-1),
    apply: routes.find(([path]) => path.endsWith('/restore'))?.[1].at(-1),
  };
}

async function invoke(handler, body) {
  let status = 200;
  let payload = null;
  let error = null;
  const response = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  };
  await handler(
    { params: { serverId, name: databaseName }, body },
    response,
    (value) => { error = value; },
  );
  return { status, payload, error };
}

test('database restore preview accepts only backup identity and returns pinned public evidence', async () => {
  const fx = mounted();
  const response = await invoke(fx.preview, { backupId });
  assert.equal(response.error, null);
  assert.equal(response.status, 200);
  assert.deepEqual(fx.calls, [['preview', { serverId, databaseName, backupId }]]);
  assert.equal(response.payload.data.previewDigest, previewDigest);
  assert.equal(response.payload.data.backupSha256, backupSha256);
  assert.equal(JSON.stringify(response.payload).includes('dumpPath'), false);
  assert.equal(JSON.stringify(response.payload).includes('CREATE TABLE'), false);
});

test('database restore apply forwards only pinned preview fields and returns queued job', async () => {
  const fx = mounted();
  const response = await invoke(fx.apply, {
    backupId,
    expectedPreviewDigest: previewDigest,
    expectedBackupSha256: backupSha256,
    confirmation,
  });
  assert.equal(response.error, null);
  assert.equal(response.status, 202);
  assert.deepEqual(fx.calls, [['queue', {
    serverId,
    databaseName,
    backupId,
    expectedPreviewDigest: previewDigest,
    expectedBackupSha256: backupSha256,
    confirmation,
  }]]);
  assert.equal(response.payload.data.job.status, 'queued');
});

test('database restore routes reject extra or incomplete body fields before service invocation', async () => {
  for (const [handlerName, body] of [
    ['preview', { backupId, dumpPath: '/private/dump.sql' }],
    ['apply', { backupId, expectedPreviewDigest: previewDigest, expectedBackupSha256: backupSha256 }],
    ['apply', { backupId, expectedPreviewDigest: previewDigest, expectedBackupSha256: backupSha256, confirmation, sql: 'secret' }],
  ]) {
    const fx = mounted();
    const response = await invoke(fx[handlerName], body);
    assert.ok(response.error instanceof DatabaseRestoreHttpError);
    assert.ok(response.error instanceof JobRegistryError);
    assert.equal(fx.calls.length, 0);
  }
});

test('database restore service errors retain safe HTTP code and status', async () => {
  const fx = mounted({
    previewError: new DatabaseBackupOperationsError('database_restore_backup_evidence_drift', 'Selected backup evidence drifted', 409),
  });
  const response = await invoke(fx.preview, { backupId });
  assert.ok(response.error instanceof DatabaseRestoreHttpError);
  assert.ok(response.error instanceof JobRegistryError);
  assert.equal(response.error.code, 'database_restore_backup_evidence_drift');
  assert.equal(response.error.status, 409);
});
