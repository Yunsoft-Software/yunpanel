import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createLocalDatabaseCredentialOperation,
  LocalDatabaseCredentialOperationError,
} from '../src/local-database-credential-operation.js';

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

const execution = Object.freeze({ jobId, resourceType: 'database', resourceId: 'app_main' });

test('local apply materializes privately and returns only manager evidence', async () => {
  const calls = [];
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
        return {
          version: 1,
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
      },
      async deleteCredential() { throw new Error('not used'); },
    },
  });
  const result = await operation.execute(OPERATIONS.DATABASE_CREDENTIAL_APPLY, payload(), execution);
  assert.equal(result.applied, true);
  assert.equal(Object.hasOwn(result, 'password'), false);
  assert.equal(calls[0][0], 'materialize');
  assert.equal(calls[1][0], 'apply');
  assert.equal(Object.hasOwn(calls[1][1], 'password'), true);
});

test('local delete does not require private password material', async () => {
  const operation = createLocalDatabaseCredentialOperation({
    materializer: { async materialize() { return bundle({ privateValue: false }); } },
    manager: {
      async applyCredential() { throw new Error('not used'); },
      async deleteCredential() {
        return {
          version: 1,
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
      },
    },
  });
  const result = await operation.execute(OPERATIONS.DATABASE_CREDENTIAL_DELETE, payload(), execution);
  assert.equal(result.deleted, true);
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
      jobId,
      resourceType: 'database',
      resourceId: 'other_db',
    }),
    (error) => error instanceof LocalDatabaseCredentialOperationError && error.code === 'database_credential_bundle_mismatch',
  );
  assert.equal(mutated, false);
});
