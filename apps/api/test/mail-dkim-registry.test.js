import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
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

test('atomically persists public metadata beside a private 0600 DKIM key', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  const calls = [];
  const registry = createMailDkimRegistry({
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

  const keyDirectory = path.join(keyRoot, mailDomainId);
  const metadataPath = path.join(keyDirectory, 'metadata.json');
  const privateKeyPath = path.join(keyDirectory, 'private.pem');
  assert.equal((await stat(keyRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(keyDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
  assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600);
  assert.match(await readFile(privateKeyPath, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
  const persisted = await readFile(metadataPath, 'utf8');
  assert.doesNotMatch(persisted, /BEGIN PRIVATE KEY|privateKey/i);
  assert.match(persisted, /"selector": "mail-2026"/);
  assert.deepEqual(await readdir(keyRoot), [mailDomainId]);

  const materialized = await registry.materializePrivateKey(mailDomainId);
  assert.equal(materialized.privateKey, KEY_PAIR.privateKey);
  assert.equal(materialized.metadata.publicKey, created.publicKey);
  assert.doesNotMatch(JSON.stringify(materialized.metadata), /BEGIN PRIVATE KEY/);

  const reopened = createMailDkimRegistry({
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

test('startup fails closed when committed private material mode or content is unsafe', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  const registry = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
    generateKeyPairFn: generator([]),
  });
  await registry.init();
  await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail' });
  const privateKeyPath = path.join(keyRoot, mailDomainId, 'private.pem');

  await chmod(privateKeyPath, 0o644);
  const unsafe = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await assert.rejects(
    unsafe.init(),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_private_key_unsafe',
  );

  await chmod(privateKeyPath, 0o600);
  await writeFile(privateKeyPath, 'not a private key\n', { mode: 0o600 });
  const corrupted = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await assert.rejects(
    corrupted.init(),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_private_key_invalid',
  );
}));

test('startup removes safe interrupted pending transactions but rejects unsafe pending entries', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  await mkdir(keyRoot, { recursive: true, mode: 0o700 });
  const pending = path.join(keyRoot, `.pending-${mailDomainId}-deadbeef`);
  await mkdir(pending, { mode: 0o700 });
  await writeFile(path.join(pending, 'partial'), 'incomplete\n', { mode: 0o600 });

  const registry = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await registry.init();
  assert.deepEqual(await readdir(keyRoot), []);

  const unsafePending = path.join(keyRoot, `.pending-${mailDomainId}-symlink`);
  await symlink(root, unsafePending);
  const unsafe = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await assert.rejects(
    unsafe.init(),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_state_invalid',
  );
}));

test('external domains, stale revisions and unsafe selectors fail closed without creating state', async () => withTempDirectory(async (root) => {
  const externalId = randomUUID();
  const domains = new Map([
    [mailDomainId, localMailDomain],
    [externalId, { id: externalId, domainName: 'external.example', managementMode: 'external' }],
  ]);
  const keyRoot = path.join(root, 'keys');
  const registry = createMailDkimRegistry({
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
  assert.deepEqual(await registry.listKeys(), []);
  assert.deepEqual(await readdir(keyRoot), []);
}));

test('unexpected persistent entries fail closed instead of being ignored', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  await mkdir(path.join(keyRoot, 'not-a-uuid'), { recursive: true, mode: 0o700 });
  const registry = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? localMailDomain : null,
  });
  await assert.rejects(registry.init(), (error) => error instanceof MailDkimRegistryError);
}));
