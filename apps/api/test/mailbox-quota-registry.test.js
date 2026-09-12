import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createMailboxQuotaRegistry,
  MailboxQuotaRegistryError,
  mailboxQuotaRegistryInternals,
} from '../src/mailbox-quota-registry.js';

const mailboxId = randomUUID();
const mailbox = Object.freeze({ id: mailboxId, address: 'owner@example.com', revision: 1 });

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mailbox-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'mailbox-quota-registry.json');
  const registry = createMailboxQuotaRegistry({
    filePath,
    now: options.now,
    getMailbox: options.getMailbox ?? (async (id) => id === mailboxId ? mailbox : null),
  });
  await registry.init();
  return { root, filePath, registry };
}

test('persists bounded mailbox quota metadata with optimistic revisions', async (t) => {
  let clock = Date.parse('2026-09-12T17:00:00.000Z');
  const state = await fixture(t, { now: () => clock });
  assert.equal(await state.registry.getQuota(mailboxId), null);

  const created = await state.registry.setQuota(mailboxId, {
    expectedRevision: 0,
    quotaBytes: 1024 * 1024 * 1024,
  });
  assert.deepEqual(created, {
    mailboxId,
    quotaBytes: 1024 * 1024 * 1024,
    revision: 1,
    createdAt: '2026-09-12T17:00:00.000Z',
    updatedAt: '2026-09-12T17:00:00.000Z',
  });

  clock += 1_000;
  const updated = await state.registry.setQuota(mailboxId, {
    expectedRevision: 1,
    quotaBytes: 2 * 1024 * 1024 * 1024,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.updatedAt, '2026-09-12T17:00:01.000Z');
  assert.equal((await stat(state.filePath)).mode & 0o077, 0);
  assert.equal((await stat(state.root)).mode & 0o077, 0);

  const raw = JSON.parse(await readFile(state.filePath, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['policies', 'version']);
  assert.equal(raw.policies[0].quotaBytes, updated.quotaBytes);

  const reopened = createMailboxQuotaRegistry({
    filePath: state.filePath,
    getMailbox: async () => mailbox,
  });
  await reopened.init();
  assert.deepEqual(await reopened.getQuota(mailboxId), updated);
});

test('rejects stale, no-op, missing mailbox and out-of-policy quotas', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    state.registry.setQuota(randomUUID(), { expectedRevision: 0, quotaBytes: 1024 * 1024 }),
    { code: 'mailbox_not_found' },
  );
  await assert.rejects(
    state.registry.setQuota(mailboxId, { expectedRevision: 0, quotaBytes: mailboxQuotaRegistryInternals.minQuotaBytes - 1 }),
    { code: 'invalid_mailbox_quota_bytes' },
  );
  const created = await state.registry.setQuota(mailboxId, { expectedRevision: 0, quotaBytes: 1024 * 1024 });
  await assert.rejects(
    state.registry.setQuota(mailboxId, { expectedRevision: 0, quotaBytes: 2 * 1024 * 1024 }),
    { code: 'stale_mailbox_quota_revision' },
  );
  await assert.rejects(
    state.registry.setQuota(mailboxId, { expectedRevision: created.revision, quotaBytes: created.quotaBytes }),
    { code: 'mailbox_quota_no_change' },
  );
});

test('quota removal requires exact revision and typed confirmation', async (t) => {
  const state = await fixture(t);
  const created = await state.registry.setQuota(mailboxId, { expectedRevision: 0, quotaBytes: 512 * 1024 * 1024 });
  await assert.rejects(
    state.registry.clearQuota(mailboxId, { expectedRevision: created.revision, confirmation: 'clear-mailbox-quota:wrong' }),
    { code: 'mailbox_quota_confirmation_mismatch' },
  );
  await assert.rejects(
    state.registry.clearQuota(mailboxId, { expectedRevision: created.revision + 1, confirmation: `clear-mailbox-quota:${mailboxId}` }),
    { code: 'stale_mailbox_quota_revision' },
  );
  await state.registry.clearQuota(mailboxId, {
    expectedRevision: created.revision,
    confirmation: `clear-mailbox-quota:${mailboxId}`,
  });
  assert.equal(await state.registry.getQuota(mailboxId), null);
});

test('orphan cleanup is explicit and does not require the mailbox to still exist', async (t) => {
  let exists = true;
  const state = await fixture(t, { getMailbox: async (id) => exists && id === mailboxId ? mailbox : null });
  await state.registry.setQuota(mailboxId, { expectedRevision: 0, quotaBytes: 256 * 1024 * 1024 });
  exists = false;
  await assert.rejects(state.registry.getQuota(mailboxId), { code: 'mailbox_not_found' });
  assert.equal(await state.registry.removeOrphan(mailboxId), true);
  assert.deepEqual(await state.registry.listQuotas(), []);
});

test('invalid persisted quota state fails closed without exposing raw content', async (t) => {
  const state = await fixture(t);
  await state.registry.setQuota(mailboxId, { expectedRevision: 0, quotaBytes: 128 * 1024 * 1024 });
  const raw = JSON.parse(await readFile(state.filePath, 'utf8'));
  raw.policies[0].quotaBytes = 1;
  await import('node:fs/promises').then(({ writeFile }) => writeFile(state.filePath, JSON.stringify(raw)));
  const reopened = createMailboxQuotaRegistry({ filePath: state.filePath, getMailbox: async () => mailbox });
  await assert.rejects(
    reopened.init(),
    (error) => error instanceof MailboxQuotaRegistryError
      && ['invalid_mailbox_quota_bytes', 'mailbox_quota_state_invalid'].includes(error.code)
      && !error.message.includes('owner@example.com'),
  );
});
