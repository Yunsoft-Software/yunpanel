import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderDovecotPasswdFile } from '@yunpanel/config-templates';
import {
  createMailboxRegistry,
  MailboxRegistryError,
  rewrapMailboxSnapshot,
} from '../src/mailbox-registry.js';
import { verifyMailboxPassword } from '../src/mailbox-password.js';

const mailDomainId = randomUUID();
const managedDomain = Object.freeze({ id: mailDomainId, domainName: 'example.com', managementMode: 'local' });

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mailboxes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'mailbox-registry.json');
  const masterKey = options.masterKey ?? randomBytes(32);
  const registry = createMailboxRegistry({
    filePath,
    masterKey,
    now: options.now,
    getMailDomain: options.getMailDomain ?? (async (id) => id === mailDomainId ? managedDomain : null),
  });
  await registry.init();
  return { root, filePath, masterKey, registry };
}

test('persists only encrypted mailbox credentials and exposes bounded public metadata', async (t) => {
  const state = await fixture(t, { now: () => Date.parse('2026-09-12T01:00:00.000Z') });
  const mailbox = await state.registry.createMailbox({
    mailDomainId,
    address: 'OWNER@EXAMPLE.COM.',
    password: 'private mailbox password',
  });
  assert.deepEqual(mailbox, {
    id: mailbox.id,
    mailDomainId,
    address: 'owner@example.com',
    enabled: true,
    revision: 1,
    passwordConfigured: true,
    passwordUpdatedAt: '2026-09-12T01:00:00.000Z',
    createdAt: '2026-09-12T01:00:00.000Z',
    updatedAt: '2026-09-12T01:00:00.000Z',
  });
  assert.equal(Object.hasOwn(mailbox, 'passwordHash'), false);
  assert.equal(Object.hasOwn(mailbox, 'ciphertext'), false);

  const raw = await readFile(state.filePath, 'utf8');
  assert.doesNotMatch(raw, /private mailbox password|\$argon2id\$/);
  assert.equal((await stat(state.filePath)).mode & 0o077, 0);
  assert.equal((await stat(state.root)).mode & 0o077, 0);

  const accounts = await state.registry.materializeEnabledAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(await verifyMailboxPassword('private mailbox password', accounts[0].passwordHash), true);
  assert.match(renderDovecotPasswdFile({ domains: ['example.com'], accounts }), /^owner@example\.com:\{ARGON2ID\}/);

  const reopened = createMailboxRegistry({
    filePath: state.filePath,
    masterKey: state.masterKey,
    getMailDomain: async () => managedDomain,
  });
  await reopened.init();
  assert.deepEqual(await reopened.listMailboxes(), [mailbox]);
});

test('rotation, disable and deletion require exact revisions and confirmation', async (t) => {
  let clock = Date.parse('2026-09-12T02:00:00.000Z');
  const { registry } = await fixture(t, { now: () => clock });
  const created = await registry.createMailbox({ mailDomainId, address: 'owner@example.com', password: 'old mailbox password' });
  clock += 1_000;
  const rotated = await registry.rotatePassword(created.id, { expectedRevision: 1, password: 'new mailbox password' });
  assert.equal(rotated.revision, 2);
  assert.equal(rotated.passwordUpdatedAt, '2026-09-12T02:00:01.000Z');
  const [account] = await registry.materializeEnabledAccounts();
  assert.equal(await verifyMailboxPassword('old mailbox password', account.passwordHash), false);
  assert.equal(await verifyMailboxPassword('new mailbox password', account.passwordHash), true);

  await assert.rejects(registry.setEnabled(created.id, { expectedRevision: 1, enabled: false }), { code: 'stale_mailbox_revision' });
  const disabled = await registry.setEnabled(created.id, { expectedRevision: 2, enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.revision, 3);
  assert.deepEqual(await registry.materializeEnabledAccounts(), []);
  await assert.rejects(
    registry.deleteMailbox(created.id, { expectedRevision: 3, confirmation: 'delete-mailbox:wrong@example.com' }),
    { code: 'mailbox_confirmation_mismatch' },
  );
  await registry.deleteMailbox(created.id, { expectedRevision: 3, confirmation: 'delete-mailbox:owner@example.com' });
  assert.deepEqual(await registry.listMailboxes(), []);
});

test('rejects external, missing, mismatched and duplicate mailbox bindings', async (t) => {
  const external = await fixture(t, {
    getMailDomain: async () => ({ ...managedDomain, managementMode: 'external' }),
  });
  await assert.rejects(
    external.registry.createMailbox({ mailDomainId, address: 'owner@example.com', password: 'valid mailbox password' }),
    (error) => error instanceof MailboxRegistryError && error.code === 'mail_domain_not_locally_managed',
  );

  const state = await fixture(t);
  await assert.rejects(
    state.registry.createMailbox({ mailDomainId: randomUUID(), address: 'owner@example.com', password: 'valid mailbox password' }),
    { code: 'mail_domain_not_found' },
  );
  await assert.rejects(
    state.registry.createMailbox({ mailDomainId, address: 'owner@other.example', password: 'valid mailbox password' }),
    { code: 'mailbox_domain_mismatch' },
  );
  await state.registry.createMailbox({ mailDomainId, address: 'Owner@example.com', password: 'valid mailbox password' });
  await assert.rejects(
    state.registry.createMailbox({ mailDomainId, address: 'owner@EXAMPLE.COM.', password: 'another mailbox password' }),
    { code: 'mailbox_already_exists' },
  );
});

test('fails closed for credential tampering, wrong keys and invalid persisted ownership', async (t) => {
  const state = await fixture(t);
  await state.registry.createMailbox({ mailDomainId, address: 'owner@example.com', password: 'valid mailbox password' });
  const wrongKey = createMailboxRegistry({
    filePath: state.filePath,
    masterKey: randomBytes(32),
    getMailDomain: async () => managedDomain,
  });
  await assert.rejects(wrongKey.init(), { code: 'secret_decryption_failed' });

  const parsed = JSON.parse(await readFile(state.filePath, 'utf8'));
  parsed.mailboxes[0].mailDomainId = randomUUID();
  await writeFile(state.filePath, JSON.stringify(parsed));
  const drifted = createMailboxRegistry({
    filePath: state.filePath,
    masterKey: state.masterKey,
    getMailDomain: async () => null,
  });
  await assert.rejects(drifted.init(), { code: 'mail_domain_not_found' });
});

test('rewraps encrypted mailbox hashes without changing public identity', async (t) => {
  const state = await fixture(t);
  const created = await state.registry.createMailbox({
    mailDomainId,
    address: 'owner@example.com',
    password: 'valid mailbox password',
  });
  const snapshot = JSON.parse(await readFile(state.filePath, 'utf8'));
  const nextKey = randomBytes(32);
  const rewrapped = rewrapMailboxSnapshot(snapshot, { currentMasterKey: state.masterKey, nextMasterKey: nextKey });
  assert.notEqual(rewrapped.mailboxes[0].ciphertext, snapshot.mailboxes[0].ciphertext);
  await writeFile(state.filePath, JSON.stringify(rewrapped));

  const reopened = createMailboxRegistry({
    filePath: state.filePath,
    masterKey: nextKey,
    getMailDomain: async () => managedDomain,
  });
  await reopened.init();
  assert.deepEqual(await reopened.listMailboxes(), [created]);
  assert.equal(await verifyMailboxPassword('valid mailbox password', (await reopened.materializeEnabledAccounts())[0].passwordHash), true);
});
