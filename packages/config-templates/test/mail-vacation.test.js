import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailVacationTemplateError,
  previewManagedMailboxVacationSieve,
  renderManagedMailboxForwardingSieve,
} from '../src/index.js';

const mailboxes = ['owner@example.com', 'other@example.com'];
const vacation = Object.freeze({ mailbox: 'owner@example.com', subject: 'Tatildeyim', body: 'Pazartesi döneceğim.' });

test('renders vacation for the exact managed recipient and retains normal delivery', () => {
  const preview = previewManagedMailboxVacationSieve({ mailboxes, policies: [vacation] });
  const actualForwarding = renderManagedMailboxForwardingSieve([{
    source: vacation.mailbox, mode: 'redirect', destinations: ['other@example.com'],
  }]);

  assert.equal(preview.path, '/etc/dovecot/yunpanel-vacation.sieve');
  assert.equal(preview.compile.file, '/usr/bin/sievec');
  assert.deepEqual(preview.compile.args, [preview.path]);
  assert.equal(preview.compiledPath, '/etc/dovecot/yunpanel-vacation.svbin');
  assert.equal(preview.policies, 1);
  assert.equal(preview.sensitive, true);
  assert.equal(preview.sideEffects, false);
  assert.equal(preview.bytes, Buffer.byteLength(preview.content));
  assert.match(preview.content, /^require \["envelope", "vacation"\];/);
  assert.ok(preview.content.includes('envelope :is "to" "owner@example.com", not envelope :is "from" ["", "owner@example.com"]'));
  assert.ok(preview.content.includes('vacation :days 7 :subject "Tatildeyim" :addresses ["owner@example.com"] text:\nPazartesi döneceğim.\n.\n  ;'));
  assert.doesNotMatch(preview.content, /\b(?:stop|keep|redirect|discard);/);
  assert.match(actualForwarding, /redirect "other@example.com";\n  stop;/);
});

test('escapes quoted subjects and dot-stuffs each leading dot in the body', () => {
  const policy = { ...vacation, subject: 'Tatil "bugün" \\ ertesi gün', body: 'İlk satır\r\n.\r\n..devam\r\nson satır' };
  const preview = previewManagedMailboxVacationSieve({ mailboxes, policies: [policy] });
  assert.ok(preview.content.includes(String.raw`:subject "Tatil \"bugün\" \\ ertesi gün"`));
  assert.ok(preview.content.includes('\nİlk satır\n..\n...devam\nson satır\n.\n  ;'));
  assert.equal(preview.sha256, previewManagedMailboxVacationSieve({
    mailboxes,
    policies: [{ ...policy, mailbox: 'OWNER@EXAMPLE.COM.', body: policy.body.replaceAll('\r\n', '\n') }],
  }).sha256);
});

test('empty vacation policies are a no-op and ordering is stable', () => {
  assert.equal(previewManagedMailboxVacationSieve().content, 'require ["envelope", "vacation"];\n\n');
  const other = { ...vacation, mailbox: 'other@example.com' };
  assert.equal(
    previewManagedMailboxVacationSieve({ mailboxes, policies: [vacation, other] }).sha256,
    previewManagedMailboxVacationSieve({ mailboxes: [...mailboxes].reverse(), policies: [other, vacation] }).sha256,
  );
});

test('rejects unmanaged recipients, duplicate policies, arbitrary directives and header injection', () => {
  for (const invalid of [
    { ...vacation, mailbox: 'missing@example.com' },
    { ...vacation, mailbox: 'owner@outside.test' },
    { ...vacation, mailbox: 'owner@example.com"; discard; #' },
    { ...vacation, rawSieve: 'discard;' },
    { ...vacation, subject: 'Reply\r\nBcc: owner@example.com' },
    { ...vacation, body: 'bad\u0000body' },
    { ...vacation, body: '\ud800' },
    { ...vacation, body: 'ü'.repeat(2_001) },
  ]) {
    assert.throws(() => previewManagedMailboxVacationSieve({ mailboxes, policies: [invalid] }),
      (error) => error instanceof MailVacationTemplateError || error.code === 'invalid_mailbox_address');
  }
  assert.throws(() => previewManagedMailboxVacationSieve({
    mailboxes, policies: [vacation, { ...vacation, mailbox: 'OWNER@EXAMPLE.COM.' }],
  }), { code: 'mail_vacation_mailbox_invalid' });
});

test('rejects a combined script above the supported byte limit', () => {
  const owned = Array.from({ length: 140 }, (_, index) => `user${index}@example.com`);
  const policies = owned.map((mailbox) => ({ ...vacation, mailbox, body: 'a'.repeat(4_000) }));
  assert.throws(() => previewManagedMailboxVacationSieve({ mailboxes: owned, policies }), { code: 'mail_vacation_script_too_large' });
});
