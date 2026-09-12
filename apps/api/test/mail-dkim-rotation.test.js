import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailDkimRegistry,
  MailDkimRegistryError,
} from '../src/mail-dkim-registry.js';

const mailDomainId = randomUUID();
const mailDomain = Object.freeze({
  id: mailDomainId,
  domainName: 'example.com',
  managementMode: 'local',
});

function pair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-dkim-rotate-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function sequenceGenerator(pairs, calls) {
  let index = 0;
  return async (algorithm, options) => {
    calls.push([algorithm, structuredClone(options)]);
    const value = pairs[index];
    index += 1;
    if (!value) throw new Error('generator exhausted');
    return { publicKey: Buffer.from(value.publicKey), privateKey: value.privateKey };
  };
}

test('rotation atomically replaces protected key state with a new selector and revision', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  const pairs = [pair(), pair()];
  const calls = [];
  let now = Date.parse('2026-09-12T19:00:00.000Z');
  const registry = createMailDkimRegistry({
    keyRoot,
    now: () => now,
    getMailDomain: async (id) => id === mailDomainId ? mailDomain : null,
    generateKeyPairFn: sequenceGenerator(pairs, calls),
  });
  await registry.init();
  const created = await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail-2026a' });

  now = Date.parse('2026-09-12T20:00:00.000Z');
  const rotated = await registry.rotateKey(mailDomainId, { expectedRevision: 1, selector: 'mail-2026b' });
  assert.equal(rotated.revision, 2);
  assert.equal(rotated.selector, 'mail-2026b');
  assert.equal(rotated.createdAt, created.createdAt);
  assert.equal(rotated.updatedAt, '2026-09-12T20:00:00.000Z');
  assert.notEqual(rotated.publicKey, created.publicKey);
  assert.equal(rotated.dnsRecord.name, 'mail-2026b._domainkey.example.com');
  assert.doesNotMatch(JSON.stringify(rotated), /BEGIN PRIVATE KEY|privateKey/i);
  assert.equal(calls.length, 2);

  const materialized = await registry.materializePrivateKey(mailDomainId);
  assert.equal(materialized.privateKey, pairs[1].privateKey);
  assert.equal(materialized.metadata.revision, 2);
  assert.deepEqual(await readdir(keyRoot), [mailDomainId]);

  const reopened = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? mailDomain : null,
  });
  await reopened.init();
  assert.deepEqual(await reopened.getKey(mailDomainId), rotated);
}));

test('rotation rejects stale revisions and selector reuse before generating private material', async () => {
  const calls = [];
  const registry = createMailDkimRegistry({
    getMailDomain: async (id) => id === mailDomainId ? mailDomain : null,
    generateKeyPairFn: sequenceGenerator([pair(), pair()], calls),
  });
  await registry.init();
  await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail-a' });

  await assert.rejects(
    registry.rotateKey(mailDomainId, { expectedRevision: 2, selector: 'mail-b' }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'stale_mail_dkim_revision',
  );
  await assert.rejects(
    registry.rotateKey(mailDomainId, { expectedRevision: 1, selector: 'mail-a' }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_rotation_selector_unchanged',
  );
  assert.equal(calls.length, 1);
});

test('startup rolls an interrupted directory swap back to the previous committed key', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  const registry = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? mailDomain : null,
    generateKeyPairFn: sequenceGenerator([pair()], []),
  });
  await registry.init();
  const created = await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail-a' });

  const previous = path.join(keyRoot, `.previous-${mailDomainId}-deadbeefcafe`);
  await rename(path.join(keyRoot, mailDomainId), previous);
  const pending = path.join(keyRoot, `.pending-${mailDomainId}-aabbccddeeff`);
  await mkdir(pending, { mode: 0o700 });
  await writeFile(path.join(pending, 'partial'), 'interrupted\n', { mode: 0o600 });

  const reopened = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? mailDomain : null,
  });
  await reopened.init();
  assert.deepEqual(await readdir(keyRoot), [mailDomainId]);
  assert.deepEqual(await reopened.getKey(mailDomainId), created);
}));
