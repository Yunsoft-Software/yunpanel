import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseCredentialHostStateStore,
  DatabaseCredentialHostStateError,
} from '../src/database-credential-host-state.js';

const credentialId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-host-state-'));
  const storeRoot = path.join(root, 'state');
  const store = createDatabaseCredentialHostStateStore({
    root: storeRoot,
    now: () => Date.parse('2026-09-13T03:00:00.000Z'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { store, storeRoot };
}

test('database credential host marker is private and exact', async (t) => {
  const state = await fixture(t);
  const marker = await state.store.write({
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    databaseName: 'app_main',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    credentialRevision: 3,
    bindingRevision: 1,
    desiredStateSha256: 'a'.repeat(64),
  });
  assert.equal(marker.appliedAt, '2026-09-13T03:00:00.000Z');
  assert.deepEqual(await state.store.read(credentialId), marker);
  assert.equal((await stat(state.storeRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(state.store.markerPath(credentialId))).mode & 0o777, 0o600);
});

test('unsafe database credential host marker fails closed', async (t) => {
  const state = await fixture(t);
  await state.store.write({
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    databaseName: 'app_main',
    username: 'ydb_0123456789abcdef01234567',
    host: 'localhost',
    credentialRevision: 1,
    bindingRevision: 1,
    desiredStateSha256: 'b'.repeat(64),
  });
  await chmod(state.store.markerPath(credentialId), 0o644);
  await assert.rejects(
    state.store.read(credentialId),
    (error) => error instanceof DatabaseCredentialHostStateError && error.code === 'database_credential_host_state_unsafe',
  );
});
