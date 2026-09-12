import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
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
const localMailDomain = Object.freeze({
  id: mailDomainId,
  domainName: 'example.com',
  managementMode: 'local',
});
const KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-dkim-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function generator(calls) {
  return async (algorithm, options) => {
    calls.push([algorithm, structuredClone(options)]);
    return {
      publicKey: Buffer.from(KEY_PAIR.publicKey),
      privateKey: KEY_PAIR.privateKey,
    };
  };
}

test('persists only public DKIM metadata while private key stays in a 0600 file', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'state', 'mail-dkim-registry.json');
  const keyRoot = path.join(root, 'keys');
  const calls = [];
  const registry = createMailDkimRegistry({
    filePath,
    keyRoot,
    now: () => Date.parse('2026-09-12T19:00:00.000Z'),
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
    generateKeyPairFn: generator(calls),
  });
  await registry.init();
  const created = await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail-2026' });

  assert.equal(created.mailDomainId, mailDomainId);
  assert.equal(created.domainName, 'example.com');
  assert.equal(created.selector, 'mail-2026');
  assert.equal(created.algorithm, 'rsa-sha256');
  assert.equal(created.revision, 1);
  assert.equal(created.createdAt, '2026-09-12T19:00:00.000Z');
  assert.match(created.publicKey, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(created.dnsRecord, {
    type: 'TXT',
    name: 'mail-2026._domainkey.example.com',
    value: `v=DKIM1; k=rsa; p=${created.publicKey}`,
  });
  assert.doesNotMatch(JSON.stringify(created), /BEGIN PRIVATE KEY|privateKey/i);
  assert.deepEqual(calls, [['rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }]]);

  const keyPath = path.join(keyRoot, `${mailDomainId}.mail-2026.key`);
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(keyRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.match(await readFile(keyPath, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /BEGIN PRIVATE KEY|privateKey/i);

  const materialized = await registry.materializePrivateKey(mailDomainId);
  assert.equal(materialized.privateKey, KEY_PAIR.privateKey);
  assert.equal(materialized.metadata.publicKey, created.publicKey);
  assert.doesNotMatch(JSON.stringify(materialized.metadata), /BEGIN PRIVATE KEY/);

  const reopened = createMailDkimRegistry({
    filePath,
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await reopened.init();
  assert.deepEqual(await reopened.getKey(mailDomainId), created);
}));

test('concurrent first-key creation generates only one key and rejects the loser', async () => {
  const calls = [];
  const registry = createMailDkimRegistry({
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
    generateKeyPairFn: generator(calls),
  });
  await registry.init();

  const results = await Promise.allSettled([
    registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'first' }),
    registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'second' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'mail_dkim_key_exists');
  assert.equal(calls.length, 1);
});

test('startup fails closed when private key content or mode does not match public state', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'state', 'mail-dkim-registry.json');
  const keyRoot = path.join(root, 'keys');
  const registry = createMailDkimRegistry({
    filePath,
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
    generateKeyPairFn: generator([]),
  });
  await registry.init();
  await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail' });
  const keyPath = path.join(keyRoot, `${mailDomainId}.mail.key`);

  await chmod(keyPath, 0o644);
  const unsafe = createMailDkimRegistry({
    filePath,
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await assert.rejects(
    unsafe.init(),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_private_key_unsafe',
  );

  await chmod(keyPath, 0o600);
  await writeFile(keyPath, 'not a private key\n', { mode: 0o600 });
  const corrupted = createMailDkimRegistry({
    filePath,
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await assert.rejects(
    corrupted.init(),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_private_key_invalid',
  );
}));

test('external domains, stale revisions, unsafe selectors and orphan key paths fail closed', async () => withTempDirectory(async (root) => {
  const externalId = randomUUID();
  const domains = new Map([
    [mailDomainId, localMailDomain],
    [externalId, { id: externalId, domainName: 'external.example', managementMode: 'external' }],
  ]);
  const filePath = path.join(root, 'state', 'mail-dkim-registry.json');
  const keyRoot = path.join(root, 'keys');
  const registry = createMailDkimRegistry({
    filePath,
    keyRoot,
    getMailDomain: async (id) => domains.get(id) ?? null,
    generateKeyPairFn: generator([]),
  });
  await registry.init();

  await assert.rejects(
    registry.createKey(externalId, { expectedRevision: 0, selector: 'mail' }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_domain_not_locally_managed',
  );
  await assert.rejects(
    registry.createKey(mailDomainId, { expectedRevision: 1, selector: 'mail' }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'stale_mail_dkim_revision',
  );
  await assert.rejects(
    registry.createKey(mailDomainId, { expectedRevision: 0, selector: '../mail' }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'invalid_mail_dkim_selector',
  );

  await mkdir(keyRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(keyRoot, `${mailDomainId}.mail.key`), KEY_PAIR.privateKey, { mode: 0o600 });
  await assert.rejects(
    registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail' }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_orphan_key_exists',
  );
  assert.deepEqual(await registry.listKeys(), []);
}));
