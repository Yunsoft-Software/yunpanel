import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailDkimRegistry,
  MailDkimRegistryError,
} from '../src/mail-dkim-registry.js';

const mailDomainId = randomUUID();
const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-dkim-delete-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function generator() {
  return async () => ({ publicKey: Buffer.from(pair.publicKey), privateKey: pair.privateKey });
}

function domain(status) {
  return { id: mailDomainId, domainName: 'example.com', managementMode: 'local', status };
}

test('disabled domain deletes committed private DKIM state only with exact revision and confirmation', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  let status = 'enabled';
  const registry = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? domain(status) : null,
    generateKeyPairFn: generator(),
  });
  await registry.init();
  const created = await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail-2026' });

  await assert.rejects(
    registry.deleteKey(mailDomainId, {
      expectedRevision: 1,
      confirmation: `delete-mail-dkim:${mailDomainId}:mail-2026:1`,
    }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_delete_domain_enabled',
  );
  assert.equal((await registry.getKey(mailDomainId)).revision, 1);

  status = 'disabled';
  await assert.rejects(
    registry.deleteKey(mailDomainId, {
      expectedRevision: 2,
      confirmation: `delete-mail-dkim:${mailDomainId}:mail-2026:2`,
    }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'stale_mail_dkim_revision',
  );
  await assert.rejects(
    registry.deleteKey(mailDomainId, { expectedRevision: 1, confirmation: 'delete-mail-dkim:wrong' }),
    (error) => error instanceof MailDkimRegistryError && error.code === 'mail_dkim_delete_confirmation_mismatch',
  );

  const deleted = await registry.deleteKey(mailDomainId, {
    expectedRevision: 1,
    confirmation: `delete-mail-dkim:${mailDomainId}:${created.selector}:${created.revision}`,
  });
  assert.deepEqual(deleted, {
    mailDomainId,
    selector: 'mail-2026',
    revision: 1,
    deleted: true,
  });
  assert.equal(await registry.getKey(mailDomainId), null);
  assert.deepEqual(await readdir(keyRoot), []);

  const reopened = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? domain('disabled') : null,
  });
  await reopened.init();
  assert.equal(await reopened.getKey(mailDomainId), null);
}));

test('startup completes an interrupted tombstoned deletion instead of resurrecting the private key', async () => withTempDirectory(async (root) => {
  const keyRoot = path.join(root, 'keys');
  const registry = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? domain('disabled') : null,
    generateKeyPairFn: generator(),
  });
  await registry.init();
  await registry.createKey(mailDomainId, { expectedRevision: 0, selector: 'mail-2026' });

  await rename(
    path.join(keyRoot, mailDomainId),
    path.join(keyRoot, `.deleted-${mailDomainId}-deadbeefcafe`),
  );
  const reopened = createMailDkimRegistry({
    keyRoot,
    getMailDomain: async (id) => id === mailDomainId ? domain('disabled') : null,
  });
  await reopened.init();
  assert.deepEqual(await readdir(keyRoot), []);
  assert.equal(await reopened.getKey(mailDomainId), null);
}));
