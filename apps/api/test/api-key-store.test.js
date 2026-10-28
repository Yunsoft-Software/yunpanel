import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiKeyStoreError, createApiKeyStore } from '../src/api-key-store.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-api-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'api-keys.json');
  return { filePath, store: createApiKeyStore({ filePath }) };
}
const input = { name: 'Novasis provisioner', parentDomain: 'St.Novasis.ai', portMin: 32000, portMax: 32999, createdBy: 'owner-1' };

test('a new key is shown once; only its hash is stored and listings never include it', async (t) => {
  const f = await fixture(t);
  const { key, token } = await f.store.create(input);
  assert.match(token, /^ypk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
  const secret = /^ypk_[a-f0-9]{12}_([A-Za-z0-9_-]{43})$/.exec(token)[1];
  assert.deepEqual(key.scope, { parentDomain: 'st.novasis.ai', portMin: 32000, portMax: 32999 });
  const stored = await readFile(f.filePath, 'utf8');
  assert.equal(stored.includes(secret), false, 'secret never written');
  const [listed] = await f.store.list();
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal(Object.hasOwn(listed, 'hash'), false);
});

test('only an exact, unrevoked key authenticates, also after a restart', async (t) => {
  const f = await fixture(t);
  const { key, token } = await f.store.create(input);
  const reloaded = createApiKeyStore({ filePath: f.filePath });
  assert.equal((await reloaded.authenticate(token)).id, key.id);
  const [, id, secret] = /^ypk_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/.exec(token);
  const prefix = 'ypk';
  const altered = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
  for (const candidate of [`${prefix}_${id}_${altered}`, `${prefix}_${'0'.repeat(12)}_${secret}`, 'ypk_x', '', null, `Bearer ${token}`]) {
    assert.equal(await reloaded.authenticate(candidate), null, 'invalid or changed token is refused');
  }
  await reloaded.revoke(key.id);
  assert.equal(await reloaded.authenticate(token), null);
  assert.ok((await reloaded.list())[0].revokedAt);
});

test('invalid key definitions are refused', async (t) => {
  const f = await fixture(t);
  for (const bad of [{ ...input, name: '' }, { ...input, name: 'x'.repeat(65) }, { ...input, parentDomain: 'localhost' },
    { ...input, parentDomain: '*.novasis.ai' }, { ...input, portMin: 80 }, { ...input, portMax: 70000 }, { ...input, portMin: 33000 },
    { ...input, extra: 1 }]) {
    await assert.rejects(f.store.create(bad), ApiKeyStoreError, JSON.stringify(bad));
  }
  await assert.rejects(f.store.revoke('0'.repeat(12)), { code: 'api_key_not_found' });
});
