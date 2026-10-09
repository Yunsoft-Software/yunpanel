import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createOperationSecretStore } from '../src/operation-secret-store.js';

const id = '11111111-1111-4111-8111-111111111111';
const websiteId = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const value = 'FixtureSecret_Input_123!';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-operation-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = 100000;
  const store = createOperationSecretStore({ root, masterKey: Buffer.alloc(32, 42), now: () => time });
  return { root, store, advance: () => { time += 90000; } };
}

test('operation secret persists encrypted with private modes and binds purpose and Website', async t => {
  const { root, store } = await fixture(t);
  const metadata = await store.put({ id, websiteId, purpose: 'wordpress.install', value });
  assert.equal(metadata.id, id); assert.equal(JSON.stringify(metadata).includes(value), false);
  const file = path.join(root, `${id}.json`);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await readFile(file, 'utf8')).includes(value), false);
  assert.equal(await store.read({ id, websiteId, purpose: 'wordpress.install' }), value);
  await assert.rejects(store.read({ id, websiteId: other, purpose: 'wordpress.install' }), error => error.code.startsWith('operation_secret_'));
  await assert.rejects(store.read({ id, websiteId, purpose: 'wordpress.password' }), error => error.code.startsWith('operation_secret_'));
  await assert.rejects(store.put({ id, websiteId, purpose: 'wordpress.install', value: 'DifferentSecret_123!' }), error => error.code === 'operation_secret_exists');
  await assert.rejects(store.remove({ id, websiteId: other, purpose: 'wordpress.install' }), error => error.code === 'operation_secret_identity_invalid');
  await store.remove({ id, websiteId, purpose: 'wordpress.install' });
  await assert.rejects(lstat(file), error => error.code === 'ENOENT');
});

test('expiry is authenticated and an expired operation cannot decrypt its password', async t => {
  const { root, store, advance } = await fixture(t);
  await store.put({ id, websiteId, purpose: 'wordpress.password', value, ttlMs: 60000 });
  const file = path.join(root, `${id}.json`), record = JSON.parse(await readFile(file, 'utf8'));
  record.expiresAt = new Date(100000 + 86400000).toISOString();
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(store.read({ id, websiteId, purpose: 'wordpress.password' }), error => error.code === 'operation_secret_read_failed');
  await store.remove({ id, websiteId, purpose: 'wordpress.password' });
  await store.put({ id, websiteId, purpose: 'wordpress.password', value, ttlMs: 60000 });
  advance();
  await assert.rejects(store.read({ id, websiteId, purpose: 'wordpress.password' }), error => error.code === 'operation_secret_expired');
});
