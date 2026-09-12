import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMailAliasRegistry, MailAliasRegistryError } from '../src/mail-alias-registry.js';

const mailDomainId = '87654321-1234-4234-8234-123456789012';
const otherMailDomainId = '97654321-1234-4234-8234-123456789012';

async function withTemp(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-alias-'));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function domain(id = mailDomainId, mode = 'local') {
  return { id, domainName: id === mailDomainId ? 'example.com' : 'other.example', managementMode: mode };
}

function registry({ filePath = null, mailboxes = [], getMailDomain = async (id) => domain(id) } = {}) {
  return createMailAliasRegistry({
    filePath,
    now: () => Date.parse('2026-09-12T16:00:00.000Z'),
    getMailDomain,
    listMailboxes: async ({ mailDomainId: id }) => mailboxes.filter((mailbox) => mailbox.mailDomainId === id),
  });
}

test('mail alias registry canonicalizes forwarding destinations and persists private state', async () => {
  await withTemp(async (root) => {
    const filePath = path.join(root, 'state', 'aliases.json');
    const first = registry({ filePath });
    await first.init();
    const created = await first.createAlias({
      mailDomainId,
      source: 'INFO@EXAMPLE.COM.',
      destinations: ['Owner@Example.com', 'external@OTHER.example.', 'owner@example.com'],
    });
    assert.equal(created.source, 'info@example.com');
    assert.deepEqual(created.destinations, ['external@other.example', 'owner@example.com']);
    assert.equal(created.enabled, true);
    assert.equal(created.revision, 1);

    const metadata = await stat(filePath);
    assert.equal(metadata.mode & 0o777, 0o600);
    const directory = await stat(path.dirname(filePath));
    assert.equal(directory.mode & 0o777, 0o700);
    const raw = await readFile(filePath, 'utf8');
    assert.doesNotMatch(raw, /password|secret|token/i);

    const reopened = registry({ filePath });
    await reopened.init();
    assert.deepEqual(await reopened.listAliases({ mailDomainId }), [created]);
    assert.deepEqual(await reopened.materializeEnabledAliases(), [{
      source: 'info@example.com',
      destinations: ['external@other.example', 'owner@example.com'],
    }]);
  });
});

test('mail alias registry rejects mailbox conflicts and cross-domain sources', async () => {
  const conflicted = registry({
    mailboxes: [{ id: 'mailbox-1', mailDomainId, address: 'info@example.com' }],
  });
  await conflicted.init();
  await assert.rejects(
    conflicted.createAlias({ mailDomainId, source: 'info@example.com', destinations: ['owner@example.com'] }),
    (error) => error instanceof MailAliasRegistryError
      && error.code === 'mail_alias_mailbox_conflict' && error.status === 409,
  );

  const crossDomain = registry();
  await crossDomain.init();
  await assert.rejects(
    crossDomain.createAlias({ mailDomainId, source: 'info@other.example', destinations: ['owner@example.com'] }),
    (error) => error instanceof MailAliasRegistryError
      && error.code === 'mail_alias_domain_mismatch' && error.status === 409,
  );
});

test('enabled alias graph rejects direct and transitive forwarding cycles', async () => {
  const state = registry();
  await state.init();
  await state.createAlias({ mailDomainId, source: 'a@example.com', destinations: ['b@example.com'] });
  await state.createAlias({ mailDomainId, source: 'b@example.com', destinations: ['c@example.com'] });
  await assert.rejects(
    state.createAlias({ mailDomainId, source: 'c@example.com', destinations: ['a@example.com'] }),
    (error) => error instanceof MailAliasRegistryError && error.code === 'mail_alias_cycle' && error.status === 409,
  );
  assert.equal((await state.listAliases()).length, 2);
  await assert.rejects(
    state.createAlias({ mailDomainId, source: 'self@example.com', destinations: ['SELF@EXAMPLE.COM'] }),
    (error) => error instanceof MailAliasRegistryError && error.code === 'mail_alias_self_forward',
  );
});

test('mail alias update and delete use optimistic revisions and typed confirmation', async () => {
  const state = registry();
  await state.init();
  const created = await state.createAlias({
    mailDomainId,
    source: 'sales@example.com',
    destinations: ['owner@example.com'],
  });
  const updated = await state.updateAlias(created.id, {
    expectedRevision: 1,
    destinations: ['external@elsewhere.test'],
    enabled: false,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.enabled, false);
  assert.deepEqual(await state.materializeEnabledAliases(), []);

  await assert.rejects(
    state.updateAlias(created.id, { expectedRevision: 1, destinations: ['owner@example.com'], enabled: true }),
    (error) => error instanceof MailAliasRegistryError && error.code === 'stale_mail_alias_revision',
  );
  await assert.rejects(
    state.deleteAlias(created.id, { expectedRevision: 2, confirmation: 'delete-mail-alias:wrong@example.com' }),
    (error) => error instanceof MailAliasRegistryError && error.code === 'mail_alias_confirmation_mismatch',
  );
  await state.deleteAlias(created.id, {
    expectedRevision: 2,
    confirmation: 'delete-mail-alias:sales@example.com',
  });
  assert.deepEqual(await state.listAliases(), []);
});

test('external mail domains cannot own managed aliases', async () => {
  const state = registry({
    getMailDomain: async (id) => id === otherMailDomainId ? domain(otherMailDomainId, 'external') : domain(id),
  });
  await state.init();
  await assert.rejects(
    state.createAlias({
      mailDomainId: otherMailDomainId,
      source: 'forward@other.example',
      destinations: ['owner@example.com'],
    }),
    (error) => error instanceof MailAliasRegistryError
      && error.code === 'mail_domain_not_locally_managed' && error.status === 409,
  );
});
