import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDatabaseCredentialOperationReceiptStore } from '../src/database-credential-operation-receipt.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const jobId = 'database-credential-job-0001';
const credentialId = '22345678-1234-4234-8234-123456789012';
const bindingId = '32345678-1234-4234-8234-123456789012';

function result(operation) {
  return {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 2,
    databaseName: 'app_main',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    desiredStateSha256: 'a'.repeat(64),
    [operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'applied' : 'deleted']: true,
    sideEffects: true,
  };
}

test('database credential receipt persists only secret-free terminal evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-cred-receipt-'));
  const store = createDatabaseCredentialOperationReceiptStore({ root, now: () => Date.parse('2026-09-13T03:00:00.000Z') });
  const written = await store.write({
    serverId,
    jobId,
    operation: OPERATIONS.DATABASE_CREDENTIAL_APPLY,
    result: result(OPERATIONS.DATABASE_CREDENTIAL_APPLY),
  });
  assert.equal(written.result.applied, true);
  assert.equal(Object.hasOwn(written.result, 'password'), false);
  assert.equal(Object.hasOwn(written.result, 'privileges'), false);
  const target = store.receiptPath(serverId, jobId);
  const raw = await readFile(target, 'utf8');
  assert.equal(raw.includes('password'), false);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  assert.deepEqual(await store.read(serverId, jobId), written);
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
});

test('database credential receipt keeps delete evidence distinct', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-cred-delete-receipt-'));
  const store = createDatabaseCredentialOperationReceiptStore({ root });
  const written = await store.write({
    serverId,
    jobId,
    operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    result: result(OPERATIONS.DATABASE_CREDENTIAL_DELETE),
  });
  assert.equal(written.result.deleted, true);
  assert.equal(Object.hasOwn(written.result, 'applied'), false);
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
});
