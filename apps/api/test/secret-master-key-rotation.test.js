import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';
import { createMfaVault } from '../src/mfa-crypto.js';
import { rollbackSecretMasterKey, rotateSecretMasterKey } from '../src/secret-master-key-rotation.js';

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-key-rotation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authDbPath = path.join(directory, 'auth.sqlite');
  const applicationEnvironmentStorePath = path.join(directory, 'application-environment-registry.json');
  const currentMasterKey = randomBytes(32);
  const nextMasterKey = randomBytes(32);
  const oldVault = createMfaVault(currentMasterKey);
  const db = new DatabaseSync(authDbPath);
  db.exec(`
    CREATE TABLE auth_mfa (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL, last_counter INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE auth_mfa_pending (user_id TEXT PRIMARY KEY, secret TEXT NOT NULL);
    CREATE TABLE auth_events (id INTEGER PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO auth_mfa(user_id, secret, last_counter) VALUES (?, ?, ?)').run('owner-1', oldVault.encrypt('owner-1', 'ACTIVE-SECRET'), 10);
  db.prepare('INSERT INTO auth_mfa_pending(user_id, secret) VALUES (?, ?)').run('owner-2', oldVault.encrypt('owner-2', 'PENDING-SECRET'));
  db.close();

  const environment = createApplicationEnvironmentRegistry({
    filePath: applicationEnvironmentStorePath,
    masterKey: currentMasterKey,
    applicationExists: async (id) => id === APPLICATION_ID,
  });
  await environment.init();
  await environment.setVariable({ applicationId: APPLICATION_ID, key: 'API_TOKEN', value: 'super-secret-token', secret: true });
  await environment.setVariable({ applicationId: APPLICATION_ID, key: 'PUBLIC_NAME', value: 'yunpanel', secret: false });
  return { directory, authDbPath, applicationEnvironmentStorePath, currentMasterKey, nextMasterKey };
}

function readMfa(authDbPath) {
  const db = new DatabaseSync(authDbPath, { readOnly: true });
  try {
    return {
      active: db.prepare('SELECT user_id, secret, last_counter FROM auth_mfa').get(),
      pending: db.prepare('SELECT user_id, secret FROM auth_mfa_pending').get(),
      events: db.prepare("SELECT count(*) AS count FROM auth_events WHERE action = 'secret_master_key.rotated'").get().count,
    };
  } finally { db.close(); }
}

async function materialize(applicationEnvironmentStorePath, masterKey) {
  const registry = createApplicationEnvironmentRegistry({
    filePath: applicationEnvironmentStorePath,
    masterKey,
    applicationExists: async (id) => id === APPLICATION_ID,
  });
  await registry.init();
  return registry.materialize(APPLICATION_ID);
}

function rollbackOptions(state, backupDirectory, now) {
  return {
    authDbPath: state.authDbPath,
    applicationEnvironmentStorePath: state.applicationEnvironmentStorePath,
    backupDirectory,
    ...(now ? { now } : {}),
  };
}

test('rotation rewraps application and MFA secrets together and rollback restores the old key', async (t) => {
  const state = await fixture(t);
  const backupDirectory = path.join(state.directory, 'backup');
  const manifest = await rotateSecretMasterKey({ ...state, backupDirectory, now: () => 1_800_000_000_000 });
  assert.equal(manifest.status, 'applied');
  assert.deepEqual(manifest.counts, { mfa: 1, mfaPending: 1, applicationSecrets: 1 });
  assert.match(manifest.backupHashes.authDb, /^[a-f0-9]{64}$/);
  assert.match(manifest.backupHashes.applicationEnvironmentStore, /^[a-f0-9]{64}$/);

  const rotated = readMfa(state.authDbPath);
  const nextVault = createMfaVault(state.nextMasterKey);
  const oldVault = createMfaVault(state.currentMasterKey);
  assert.equal(nextVault.decrypt('owner-1', rotated.active.secret), 'ACTIVE-SECRET');
  assert.equal(nextVault.decrypt('owner-2', rotated.pending.secret), 'PENDING-SECRET');
  assert.equal(rotated.active.last_counter, 10);
  assert.equal(rotated.events, 1);
  assert.throws(() => oldVault.decrypt('owner-1', rotated.active.secret), { code: 'mfa_key_unavailable' });
  assert.deepEqual(await materialize(state.applicationEnvironmentStorePath, state.nextMasterKey), { API_TOKEN: 'super-secret-token', PUBLIC_NAME: 'yunpanel' });
  await assert.rejects(() => materialize(state.applicationEnvironmentStorePath, state.currentMasterKey), { code: 'secret_decryption_failed' });

  const rolledBack = await rollbackSecretMasterKey(rollbackOptions(state, backupDirectory, () => 1_800_000_100_000));
  assert.equal(rolledBack.status, 'rolled_back');
  const restored = readMfa(state.authDbPath);
  assert.equal(oldVault.decrypt('owner-1', restored.active.secret), 'ACTIVE-SECRET');
  assert.equal(oldVault.decrypt('owner-2', restored.pending.secret), 'PENDING-SECRET');
  assert.equal(restored.events, 0);
  assert.deepEqual(await materialize(state.applicationEnvironmentStorePath, state.currentMasterKey), { API_TOKEN: 'super-secret-token', PUBLIC_NAME: 'yunpanel' });
});

test('wrong current key fails before replacing either live store', async (t) => {
  const state = await fixture(t);
  const originalEnvironment = await readFile(state.applicationEnvironmentStorePath, 'utf8');
  const backupDirectory = path.join(state.directory, 'wrong-key-backup');
  await assert.rejects(() => rotateSecretMasterKey({
    ...state,
    currentMasterKey: randomBytes(32),
    backupDirectory,
  }), { code: 'application_secret_decryption_failed' });
  assert.equal(await readFile(state.applicationEnvironmentStorePath, 'utf8'), originalEnvironment);
  const current = readMfa(state.authDbPath);
  assert.equal(createMfaVault(state.currentMasterKey).decrypt('owner-1', current.active.secret), 'ACTIVE-SECRET');
  const failureManifest = JSON.parse(await readFile(path.join(backupDirectory, 'manifest.json'), 'utf8'));
  assert.equal(failureManifest.status, 'failed');
});

test('rollback refuses a modified backup snapshot', async (t) => {
  const state = await fixture(t);
  const backupDirectory = path.join(state.directory, 'tamper-backup');
  await rotateSecretMasterKey({ ...state, backupDirectory });
  await writeFile(path.join(backupDirectory, 'auth.sqlite'), 'not a sqlite backup');
  await assert.rejects(() => rollbackSecretMasterKey(rollbackOptions(state, backupDirectory)), { code: 'rotation_backup_tampered' });
});

test('rollback cannot redirect a manifest to a different live store path', async (t) => {
  const state = await fixture(t);
  const backupDirectory = path.join(state.directory, 'bound-target-backup');
  await rotateSecretMasterKey({ ...state, backupDirectory });
  await assert.rejects(() => rollbackSecretMasterKey({
    authDbPath: path.join(state.directory, 'different-auth.sqlite'),
    applicationEnvironmentStorePath: state.applicationEnvironmentStorePath,
    backupDirectory,
  }), { code: 'rotation_target_mismatch' });
  assert.equal(createMfaVault(state.nextMasterKey).decrypt('owner-1', readMfa(state.authDbPath).active.secret), 'ACTIVE-SECRET');
});

test('rollback removes an environment store that did not exist before rotation', async (t) => {
  const state = await fixture(t);
  await rm(state.applicationEnvironmentStorePath);
  const backupDirectory = path.join(state.directory, 'no-environment-backup');
  const manifest = await rotateSecretMasterKey({ ...state, backupDirectory });
  assert.equal(manifest.backups.applicationEnvironmentStore, null);

  const environment = createApplicationEnvironmentRegistry({
    filePath: state.applicationEnvironmentStorePath,
    masterKey: state.nextMasterKey,
    applicationExists: async (id) => id === APPLICATION_ID,
  });
  await environment.init();
  await environment.setVariable({ applicationId: APPLICATION_ID, key: 'AFTER_ROTATION', value: 'new-key-value', secret: true });
  await rollbackSecretMasterKey(rollbackOptions(state, backupDirectory));
  await assert.rejects(() => readFile(state.applicationEnvironmentStorePath), { code: 'ENOENT' });
  assert.equal(createMfaVault(state.currentMasterKey).decrypt('owner-1', readMfa(state.authDbPath).active.secret), 'ACTIVE-SECRET');
});

test('rotation rejects reusing the current root key', async (t) => {
  const state = await fixture(t);
  await assert.rejects(() => rotateSecretMasterKey({
    ...state,
    nextMasterKey: state.currentMasterKey,
    backupDirectory: path.join(state.directory, 'same-key-backup'),
  }), { code: 'secret_master_key_unchanged' });
});
