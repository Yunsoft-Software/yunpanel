import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseCredentialRegistry,
  DatabaseCredentialRegistryError,
} from '../src/database-credential-registry.js';

const bindingId = '12345678-1234-4234-8234-123456789012';
const serverId = '22345678-1234-4234-8234-123456789012';
const websiteId = '32345678-1234-4234-8234-123456789012';
const applicationId = '42345678-1234-4234-8234-123456789012';
const expectedUsername = 'ydb_d9f59d29173c219f47c718e5';
const masterKey = Buffer.alloc(32, 7);
const generatedSecrets = [
  Buffer.alloc(32, 1).toString('base64url'),
  Buffer.alloc(32, 2).toString('base64url'),
];

function binding(overrides = {}) {
  return {
    id: bindingId,
    serverId,
    databaseName: 'app_main',
    websiteId,
    applicationId,
    unixUser: 'yunapp-abcdef123456',
    revision: 1,
    createdAt: '2026-09-13T02:00:00.000Z',
    updatedAt: '2026-09-13T02:00:00.000Z',
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-credential-'));
  const filePath = path.join(root, 'state', 'database-credentials.json');
  const queue = [...generatedSecrets];
  const registry = createDatabaseCredentialRegistry({
    filePath,
    masterKey,
    getDatabaseBinding: async (id) => id === bindingId ? binding() : null,
    now: () => Date.parse('2026-09-13T02:30:00.000Z'),
    generatePassword: () => queue.shift() ?? Buffer.alloc(32, 3).toString('base64url'),
  });
  await registry.init();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { registry, filePath };
}

test('database credential persists encrypted secret and exposes only safe metadata', async (t) => {
  const state = await fixture(t);
  const credential = await state.registry.createCredential({
    databaseBindingId: bindingId,
    confirmation: `create-database-credential:${bindingId}:${expectedUsername}`,
  });
  assert.equal(credential.username, expectedUsername);
  assert.equal(credential.host, 'localhost');
  assert.equal(credential.passwordConfigured, true);
  assert.equal(Object.hasOwn(credential, 'password'), false);

  const privateCredential = await state.registry.materializeCredential(credential.id, { expectedRevision: 1 });
  assert.equal(privateCredential.password, generatedSecrets[0]);
  const persisted = await readFile(state.filePath, 'utf8');
  assert.equal(persisted.includes(generatedSecrets[0]), false);
  assert.match(persisted, /"ciphertext"/);
  assert.equal((await stat(state.filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(state.filePath))).mode & 0o777, 0o700);
});

test('grant update and password rotation are revisioned and allowlisted', async (t) => {
  const state = await fixture(t);
  const created = await state.registry.createCredential({
    databaseBindingId: bindingId,
    privileges: ['SELECT', 'INSERT'],
    confirmation: `create-database-credential:${bindingId}:${expectedUsername}`,
  });
  await assert.rejects(
    state.registry.setPrivileges(created.id, {
      expectedRevision: 1,
      privileges: ['SELECT', 'GRANT OPTION'],
      confirmation: `update-database-grants:${created.id}:1`,
    }),
    (error) => error instanceof DatabaseCredentialRegistryError && error.code === 'invalid_database_privileges',
  );
  const grants = await state.registry.setPrivileges(created.id, {
    expectedRevision: 1,
    privileges: ['SELECT', 'UPDATE', 'DELETE'],
    confirmation: `update-database-grants:${created.id}:1`,
  });
  assert.equal(grants.revision, 2);
  assert.deepEqual(grants.privileges, ['SELECT', 'UPDATE', 'DELETE']);

  const rotated = await state.registry.rotatePassword(created.id, {
    expectedRevision: 2,
    confirmation: `rotate-database-password:${created.id}:2`,
  });
  assert.equal(rotated.revision, 3);
  const privateCredential = await state.registry.materializeCredential(created.id, { expectedRevision: 3 });
  assert.equal(privateCredential.password, generatedSecrets[1]);
  assert.notEqual(privateCredential.password, generatedSecrets[0]);
});

test('credential deletion requires exact revision and typed confirmation', async (t) => {
  const state = await fixture(t);
  const created = await state.registry.createCredential({
    databaseBindingId: bindingId,
    confirmation: `create-database-credential:${bindingId}:${expectedUsername}`,
  });
  await assert.rejects(
    state.registry.deleteCredential(created.id, { expectedRevision: 1, confirmation: 'wrong' }),
    (error) => error instanceof DatabaseCredentialRegistryError && error.code === 'database_credential_confirmation_mismatch',
  );
  const deleted = await state.registry.deleteCredential(created.id, {
    expectedRevision: 1,
    confirmation: `delete-database-credential:${created.id}:1`,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(await state.registry.getForBinding(bindingId), null);
});
