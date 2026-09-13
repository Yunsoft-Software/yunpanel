import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createLocalDatabaseCredentialOperation,
  LocalDatabaseCredentialOperationError,
} from '../src/local-database-credential-operation.js';

const serverId = '42345678-1234-4234-8234-123456789012';
const credentialId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const jobId = '32345678-1234-4234-8234-123456789012';
const digest = 'a'.repeat(64);

function payload() {
  return {
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    expectedCredentialRevision: 3,
    expectedBindingRevision: 1,
    desiredStateSha256: digest,
  };
}

function bundle({ privateValue = true } = {}) {
  return {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 1,
    desiredStateSha256: digest,
    databaseName: 'app_main',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    privileges: ['SELECT'],
    ...(privateValue ? { password: Buffer.alloc(32, 6).toString('base64url') } : {}),
  };
}

const execution = Object.freeze({ serverId, jobId, resourceType: 'database', resourceId: 'app_main' });

function applyResult() {
  return {
    version: 1,
    engine: 'mariadb',
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 1,
    databaseName: 'app_main',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    desiredStateSha256: digest,
    applied: true,
    sideEffects: true,
  };
}

function deleteResult() {
  return {
    version: 1,
    engine: 'mysql',
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 1,
    databaseName: 'app_main',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    desiredStateSha256: digest,
    deleted: true,
    sideEffects: true,
  };
}

test('local apply materializes privately and records exact secret-free recovery evidence', async () => {
  const calls = [];
  const receipts = [];
  const operation = createLocalDatabaseCredentialOperation({
    materializer: {
      async materialize(input, name) {
        calls.push(['materialize', input, name]);
        return bundle();
      },
    },
    manager: {
      async applyCredential(input) {
        calls.push(['apply', input]);
        return applyResult();
      },
      async deleteCredential() { throw new Error('not used'); },
    },
    receiptStore: {
      async write(input) {
        calls.push(['receipt', input]);
        receipts.push(structuredClone(input));
      },
    },
  });
  const result = await operation.execute(OPERATIONS.DATABASE_CREDENTIAL_APPLY, payload(), execution);
  assert.equal(result.applied, true);
  assert.equal(Object.hasOwn(result, 'password'), false);
  assert.equal(Object.hasOwn(result, 'engine'), false);
  assert.equal(Object.keys(result).length, 11);
  assert.deepEqual(calls.map(([name]) => name), ['materialize', 'apply', 'receipt']);
  assert.equal(Object.hasOwn(calls[1][1], 'password'), true);
  assert.equal(receipts[0].serverId, serverId);
  assert.equal(receipts[0].jobId, jobId);
  assert.equal(receipts[0].operation, OPERATIONS.DATABASE_CREDENTIAL_APPLY);
  assert.equal(Object.hasOwn(receipts[0].result, 'password'), false);
  assert.equal(Object.hasOwn(receipts[0].result, 'engine'), false);
  assert.equal(Object.keys(receipts[0].result).length, 11);
});

test('local delete does not require private password material and records normalized delete receipt', async () => {
  const receipts = [];
  const operation = createLocalDatabaseCredentialOperation({
    materializer: { async materialize() { return bundle({ privateValue: false }); } },
    manager: {
      async applyCredential() { throw new Error('not used'); },
      async deleteCredential() { return deleteResult(); },
    },
    receiptStore: { async write(input) { receipts.push(structuredClone(input)); } },
  });
  const result = await operation.execute(OPERATIONS.DATABASE_CREDENTIAL_DELETE, payload(), execution);
  assert.equal(result.deleted, true);
  assert.equal(Object.hasOwn(result, 'engine'), false);
  assert.equal(receipts[0].operation, OPERATIONS.DATABASE_CREDENTIAL_DELETE);
  assert.equal(Object.hasOwn(receipts[0].result, 'engine'), false);
});

test('receipt failure never recasts a completed host mutation as failed', async () => {
  const operation = createLocalDatabaseCredentialOperation({
    materializer: { async materialize() { return bundle(); } },
    manager: {
      async applyCredential() { return applyResult(); },
      async deleteCredential() { throw new Error('not used'); },
    },
    receiptStore: { async write() { throw new Error('disk full'); } },
  });
  const result = await operation.execute(OPERATIONS.DATABASE_CREDENTIAL_APPLY, payload(), execution);
  assert.equal(result.applied, true);
  assert.equal(Object.hasOwn(result, 'engine'), false);
});

test('execution resource mismatch fails before host manager mutation', async () => {
  let mutated = false;
  const operation = createLocalDatabaseCredentialOperation({
    materializer: { async materialize() { return bundle(); } },
    manager: {
      async applyCredential() { mutated = true; return {}; },
      async deleteCredential() { mutated = true; return {}; },
    },
  });
  await assert.rejects(
    operation.execute(OPERATIONS.DATABASE_CREDENTIAL_APPLY, payload(), {
      serverId,
      jobId,
      resourceType: 'database',
      resourceId: 'other_db',
    }),
    (error) => error instanceof LocalDatabaseCredentialOperationError && error.code === 'database_credential_bundle_mismatch',
  );
  assert.equal(mutated, false);
});
