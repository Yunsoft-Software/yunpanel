import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createDatabaseCredentialMaterializer,
  DatabaseCredentialMaterializerError,
} from '../src/database-credential-materializer.js';

const credentialId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';
const websiteId = '42345678-1234-4234-8234-123456789012';
const applicationId = '52345678-1234-4234-8234-123456789012';
const privateValue = Buffer.alloc(32, 5).toString('base64url');

function state() {
  const binding = {
    id: bindingId,
    serverId,
    databaseName: 'app_main',
    websiteId,
    applicationId,
    unixUser: 'yunapp-abcdef123456',
    revision: 2,
  };
  const credential = {
    id: credentialId,
    databaseBindingId: bindingId,
    serverId,
    databaseName: 'app_main',
    websiteId,
    applicationId,
    siteUnixUser: 'yunapp-abcdef123456',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    privileges: ['SELECT', 'INSERT'],
    revision: 4,
    passwordUpdatedAt: '2026-09-13T03:30:00.000Z',
  };
  return { binding, credential };
}

function payload(operation, current = state()) {
  const identity = {
    version: 1,
    operation,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    serverId,
    databaseName: 'app_main',
    username: current.credential.username,
    host: 'localhost',
    privileges: current.credential.privileges,
    expectedCredentialRevision: 4,
    expectedBindingRevision: 2,
    passwordUpdatedAt: current.credential.passwordUpdatedAt,
  };
  return {
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    expectedCredentialRevision: 4,
    expectedBindingRevision: 2,
    desiredStateSha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  };
}

function fixture() {
  const current = state();
  let materializeCalls = 0;
  const materializer = createDatabaseCredentialMaterializer({
    databaseBindingRegistry: { async getBinding(id) { return id === bindingId ? current.binding : null; } },
    databaseCredentialRegistry: {
      async getCredential(id) { return id === credentialId ? current.credential : null; },
      async materializeCredential(id, options) {
        materializeCalls += 1;
        assert.equal(id, credentialId);
        assert.deepEqual(options, { expectedRevision: 4 });
        return { ...current.credential, password: privateValue };
      },
    },
  });
  return { current, materializer, materializeCalls: () => materializeCalls };
}

test('apply materializes private value only after exact desired-state validation', async () => {
  const stateFixture = fixture();
  const input = payload(OPERATIONS.DATABASE_CREDENTIAL_APPLY, stateFixture.current);
  const bundle = await stateFixture.materializer.materialize(input, OPERATIONS.DATABASE_CREDENTIAL_APPLY);
  assert.equal(bundle.password, privateValue);
  assert.equal(bundle.databaseName, 'app_main');
  assert.equal(bundle.credentialRevision, 4);
  assert.equal(stateFixture.materializeCalls(), 1);
});

test('delete never materializes the private password', async () => {
  const stateFixture = fixture();
  const input = payload(OPERATIONS.DATABASE_CREDENTIAL_DELETE, stateFixture.current);
  const bundle = await stateFixture.materializer.materialize(input, OPERATIONS.DATABASE_CREDENTIAL_DELETE);
  assert.equal(Object.hasOwn(bundle, 'password'), false);
  assert.equal(stateFixture.materializeCalls(), 0);
});

test('revision or digest drift fails before opening the private secret', async () => {
  const stateFixture = fixture();
  const input = payload(OPERATIONS.DATABASE_CREDENTIAL_APPLY, stateFixture.current);
  await assert.rejects(
    stateFixture.materializer.materialize({ ...input, desiredStateSha256: 'f'.repeat(64) }, OPERATIONS.DATABASE_CREDENTIAL_APPLY),
    (error) => error instanceof DatabaseCredentialMaterializerError && error.code === 'database_credential_desired_state_stale',
  );
  stateFixture.current.credential.revision = 5;
  await assert.rejects(
    stateFixture.materializer.materialize(input, OPERATIONS.DATABASE_CREDENTIAL_APPLY),
    (error) => error instanceof DatabaseCredentialMaterializerError && error.code === 'database_credential_desired_state_stale',
  );
  assert.equal(stateFixture.materializeCalls(), 0);
});
