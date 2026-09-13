import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMailConfiguration,
  clearMailboxForwarding,
  clearMailboxQuota,
  createMailAlias,
  createMailbox,
  getMailDiagnostics,
  getMailDkim,
  listMailDomains,
  listMailboxes,
  previewMailConfiguration,
  rotateMailboxPassword,
  setMailboxEnabled,
  setMailboxForwarding,
  setMailboxQuota,
} from '../src/workspace/mail-client.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('managed mail client uses same-origin panel routes and exact guarded payloads', async (t) => {
  setSession({ csrfToken: 'csrf-mail' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({});
  });
  const domainId = 'mail-domain-1';
  const mailboxId = 'mailbox-1';
  await listMailDomains();
  await listMailboxes(domainId);
  await createMailbox({ mailDomainId: domainId, address: 'user@example.test', password: 'secret-pass' });
  await setMailboxEnabled(mailboxId, { expectedRevision: 2, enabled: false });
  await rotateMailboxPassword(mailboxId, { expectedRevision: 3, password: 'next-pass' });
  await setMailboxQuota(mailboxId, { expectedRevision: 0, quotaBytes: 1024 * 1024 });
  await clearMailboxQuota(mailboxId, { expectedRevision: 1 });
  await setMailboxForwarding(mailboxId, { expectedRevision: 0, mode: 'copy', destinations: ['other@example.test'], enabled: true });
  await clearMailboxForwarding(mailboxId, { expectedRevision: 1 });
  await createMailAlias({ mailDomainId: domainId, source: 'sales@example.test', destinations: ['user@example.test'] });
  await getMailDiagnostics(domainId);
  await getMailDkim(domainId);
  await previewMailConfiguration(domainId, { expectedRevision: 4, status: 'enabled' });
  await applyMailConfiguration(domainId, {
    expectedRevision: 4,
    status: 'enabled',
    preview: {
      previewDigest: 'a'.repeat(64),
      configuration: { sha256: 'b'.repeat(64) },
      confirmation: 'apply-mail-config:mail-domain-1',
    },
  });

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['/api/panel/mail-domains', 'GET'],
    ['/api/panel/mailboxes?mailDomainId=mail-domain-1', 'GET'],
    ['/api/panel/mailboxes', 'POST'],
    ['/api/panel/mailboxes/mailbox-1', 'PATCH'],
    ['/api/panel/mailboxes/mailbox-1/password', 'POST'],
    ['/api/panel/mailboxes/mailbox-1/quota', 'PUT'],
    ['/api/panel/mailboxes/mailbox-1/quota', 'DELETE'],
    ['/api/panel/mailboxes/mailbox-1/forwarding', 'PUT'],
    ['/api/panel/mailboxes/mailbox-1/forwarding', 'DELETE'],
    ['/api/panel/mail-aliases', 'POST'],
    ['/api/panel/mail-domains/mail-domain-1/diagnostics', 'GET'],
    ['/api/panel/mail-domains/mail-domain-1/dkim', 'GET'],
    ['/api/panel/mail-domains/mail-domain-1/config-preview', 'POST'],
    ['/api/panel/mail-domains/mail-domain-1/config-apply', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    expectedRevision: 1,
    confirmation: 'clear-mailbox-quota:mailbox-1',
  });
  assert.deepEqual(JSON.parse(calls[8].options.body), {
    expectedRevision: 1,
    confirmation: 'clear-mailbox-forwarding:mailbox-1',
  });
  assert.deepEqual(JSON.parse(calls[13].options.body), {
    expectedRevision: 4,
    status: 'enabled',
    previewDigest: 'a'.repeat(64),
    configurationSha256: 'b'.repeat(64),
    confirmation: 'apply-mail-config:mail-domain-1',
  });
  for (const call of calls.filter(({ options }) => options.method !== 'GET')) {
    assert.equal(call.options.headers['x-csrf-token'], 'csrf-mail');
  }
  setSession(null);
});

test('managed mail client rejects unsafe revisions and incomplete mutation inputs before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => setMailboxEnabled('mailbox-1', { expectedRevision: 0, enabled: true }), /expectedRevision is invalid/);
  assert.throws(() => setMailboxQuota('mailbox-1', { expectedRevision: 0, quotaBytes: 0 }), /quotaBytes is invalid/);
  assert.throws(() => setMailboxForwarding('mailbox-1', { expectedRevision: 0, mode: 'invalid', destinations: ['a@example.test'] }), /forwarding mode is invalid/);
  assert.throws(() => createMailAlias({ mailDomainId: 'domain-1', source: '', destinations: [] }), /mail alias input is invalid/);
  assert.throws(() => applyMailConfiguration('domain-1', { expectedRevision: 1, status: 'enabled', preview: {} }), /preview is required/);
  assert.equal(calls, 0);
});
