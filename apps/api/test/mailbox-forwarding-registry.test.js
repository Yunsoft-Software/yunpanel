import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailboxForwardingRegistry,
  MailboxForwardingRegistryError,
} from '../src/mailbox-forwarding-registry.js';

const mailboxA = '87654321-1234-4234-8234-123456789012';
const mailboxB = '97654321-1234-4234-8234-123456789012';
const mailboxC = 'a7654321-1234-4234-8234-123456789012';
const mailboxes = new Map([
  [mailboxA, { id: mailboxA, address: 'a@example.com' }],
  [mailboxB, { id: mailboxB, address: 'b@example.com' }],
  [mailboxC, { id: mailboxC, address: 'c@example.com' }],
]);

async function withTemp(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-forwarding-'));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function registry({ filePath = null, getMailbox = async (id) => mailboxes.get(id) ?? null } = {}) {
  return createMailboxForwardingRegistry({
    filePath,
    now: () => Date.parse('2026-09-12T17:00:00.000Z'),
    getMailbox,
  });
}

test('persists canonical copy forwarding policy in private state', async () => withTemp(async (root) => {
  const filePath = path.join(root, 'state', 'forwarding.json');
  const first = registry({ filePath });
  await first.init();
  const created = await first.setForwarding(mailboxA, {
    expectedRevision: 0,
    mode: 'copy',
    destinations: ['External@Elsewhere.test.', 'B@Example.com', 'external@elsewhere.test'],
  });
  assert.equal(created.mailboxId, mailboxA);
  assert.equal(created.mode, 'copy');
  assert.equal(created.enabled, true);
  assert.equal(created.revision, 1);
  assert.deepEqual(created.destinations, ['b@example.com', 'external@elsewhere.test']);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /password|token|secret/i);

  const reopened = registry({ filePath });
  await reopened.init();
  assert.deepEqual(await reopened.getForwarding(mailboxA), created);
  assert.deepEqual(await reopened.materializeEnabledForwardings(), [{
    mailboxId: mailboxA,
    source: 'a@example.com',
    mode: 'copy',
    destinations: ['b@example.com', 'external@elsewhere.test'],
  }]);
}));

test('supports redirect mode, optimistic revisions, disable and typed clear', async () => {
  const state = registry();
  await state.init();
  const created = await state.setForwarding(mailboxA, {
    expectedRevision: 0,
    mode: 'redirect',
    destinations: ['external@elsewhere.test'],
  });
  assert.equal(created.revision, 1);
  assert.equal(created.mode, 'redirect');

  await assert.rejects(
    state.setForwarding(mailboxA, {
      expectedRevision: 0,
      mode: 'copy',
      destinations: ['external@elsewhere.test'],
    }),
    { code: 'stale_mailbox_forwarding_revision' },
  );
  const disabled = await state.setForwarding(mailboxA, {
    expectedRevision: 1,
    mode: 'redirect',
    destinations: ['external@elsewhere.test'],
    enabled: false,
  });
  assert.equal(disabled.revision, 2);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(await state.materializeEnabledForwardings(), []);

  await assert.rejects(
    state.clearForwarding(mailboxA, { expectedRevision: 2, confirmation: 'clear-mailbox-forwarding:wrong' }),
    { code: 'mailbox_forwarding_confirmation_mismatch' },
  );
  await state.clearForwarding(mailboxA, {
    expectedRevision: 2,
    confirmation: `clear-mailbox-forwarding:${mailboxA}`,
  });
  assert.equal(await state.getForwarding(mailboxA), null);
});

test('rejects self and transitive forwarding cycles while allowing external destinations', async () => {
  const state = registry();
  await state.init();
  await assert.rejects(
    state.setForwarding(mailboxA, {
      expectedRevision: 0,
      mode: 'copy',
      destinations: ['A@EXAMPLE.COM.'],
    }),
    (error) => error instanceof MailboxForwardingRegistryError
      && error.code === 'mailbox_forwarding_self_destination' && error.status === 409,
  );

  await state.setForwarding(mailboxA, {
    expectedRevision: 0,
    mode: 'copy',
    destinations: ['b@example.com', 'external@elsewhere.test'],
  });
  await state.setForwarding(mailboxB, {
    expectedRevision: 0,
    mode: 'redirect',
    destinations: ['c@example.com'],
  });
  await assert.rejects(
    state.setForwarding(mailboxC, {
      expectedRevision: 0,
      mode: 'copy',
      destinations: ['a@example.com'],
    }),
    (error) => error instanceof MailboxForwardingRegistryError
      && error.code === 'mailbox_forwarding_cycle' && error.status === 409,
  );
  assert.equal((await state.listForwardings()).length, 2);
});

test('forwarding destinations are bounded to Pigeonhole default redirect capacity', async () => {
  const state = registry();
  await state.init();
  await assert.rejects(
    state.setForwarding(mailboxA, {
      expectedRevision: 0,
      mode: 'copy',
      destinations: [
        'one@external.test', 'two@external.test', 'three@external.test', 'four@external.test', 'five@external.test',
      ],
    }),
    { code: 'invalid_mailbox_forwarding_destinations' },
  );
});

test('missing mailbox policy target fails closed', async () => {
  const state = registry({ getMailbox: async () => null });
  await state.init();
  await assert.rejects(
    state.setForwarding(mailboxA, {
      expectedRevision: 0,
      mode: 'copy',
      destinations: ['external@elsewhere.test'],
    }),
    { code: 'mailbox_not_found', status: 404 },
  );
});
