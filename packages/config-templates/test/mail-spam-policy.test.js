import assert from 'node:assert/strict';
import test from 'node:test';
import { MailSpamPolicyTemplateError, previewManagedMailboxSpamPolicy } from '../src/index.js';

const mailboxes = ['owner@example.com', 'other@example.com'];
const policy = Object.freeze({ mailbox: 'owner@example.com', allow: ['friend@external.test'], deny: ['sender@elsewhere.test'] });

test('renders static Rspamd score maps for one envelope recipient and one sender', () => {
  const preview = previewManagedMailboxSpamPolicy({ mailboxes, policies: [policy] });
  assert.equal(preview.path, '/etc/rspamd/local.d/multimap.conf');
  assert.equal(preview.sideEffects, false);
  assert.equal(preview.sensitive, true);
  assert.equal(preview.bytes, Buffer.byteLength(preview.content));
  assert.deepEqual(preview.counts, { allow: 1, deny: 1 });
  assert.match(preview.content, /YUNPANEL_MAIL_POLICY_AUTHENTICATED \{\n  type = "selector";\n  selector = "user\.id\('present'\)";\n  map = \["present"\];\n  score = 0;/);
  assert.ok(preview.content.includes('selector = "id(\'mailbox\');rcpts(\'smtp\'):addr.lower.join(\',\');from(\'mime\'):addr.lower";'));
  assert.match(preview.content, /map = \["mailbox\|owner@example\.com\|friend@external\.test"\];\n  score = -1;\n  delimiter = "\|";\n  require_symbols = "!YUNPANEL_MAIL_POLICY_AUTHENTICATED & DMARC_POLICY_ALLOW";/);
  assert.match(preview.content, /map = \["mailbox\|owner@example\.com\|sender@elsewhere\.test"\];\n  score = 5;\n  delimiter = "\|";\n  require_symbols = "!YUNPANEL_MAIL_POLICY_AUTHENTICATED";/);
  assert.doesNotMatch(preview.content, /\b(?:action|apply|regexp)\s*=/);
  assert.doesNotMatch(preview.content, /other@example\.com|,owner@example\.com/);
});

test('uses stable canonical exact pairs and no rules for empty lists', () => {
  assert.equal(previewManagedMailboxSpamPolicy().content, '');
  const second = { mailbox: 'other@example.com', allow: [], deny: ['friend@external.test'] };
  const canonical = previewManagedMailboxSpamPolicy({ mailboxes, policies: [policy, second] });
  const equivalent = previewManagedMailboxSpamPolicy({
    mailboxes: [...mailboxes].reverse(),
    policies: [second, { ...policy, mailbox: 'OWNER@EXAMPLE.COM.', allow: ['FRIEND@EXTERNAL.TEST', 'friend@external.test'] }],
  });
  assert.equal(equivalent.sha256, canonical.sha256);
  assert.match(canonical.content, /mailbox\|other@example\.com\|friend@external\.test/);
  assert.deepEqual(canonical.counts, { allow: 1, deny: 2 });
  assert.equal(previewManagedMailboxSpamPolicy({ mailboxes, policies: [{ ...policy, deny: [], allow: [] }] }).content, '');
});

test('rejects unmanaged recipients, duplicate policies, overlapping lists and config injection', () => {
  for (const invalid of [
    { ...policy, mailbox: 'unmanaged@example.com' },
    { ...policy, mailbox: 'owner@outsider.test' },
    { ...policy, deny: ['FRIEND@EXTERNAL.TEST.'] },
    { ...policy, allow: ['https://outside.test/list'] },
    { ...policy, deny: ['sender@example.com"; action = "accept";'] },
    { ...policy, allow: ['*.example.com'] },
    { ...policy, action: 'reject' },
  ]) {
    assert.throws(() => previewManagedMailboxSpamPolicy({ mailboxes, policies: [invalid] }),
      (error) => error instanceof MailSpamPolicyTemplateError || error.code === 'invalid_mailbox_address');
  }
  assert.throws(() => previewManagedMailboxSpamPolicy({ mailboxes, policies: [policy, policy] }), { code: 'mail_spam_mailbox_invalid' });
});

test('enforces bounded sender lists and the aggregate map size', () => {
  const senders = Array.from({ length: 65 }, (_, index) => `sender${index}@external.test`);
  assert.throws(() => previewManagedMailboxSpamPolicy({ mailboxes, policies: [{ ...policy, allow: senders }] }), { code: 'mail_spam_senders_invalid' });
  const owned = Array.from({ length: 16 }, (_, index) => `user${index}@example.com`);
  const policies = owned.map((mailbox) => ({ mailbox, allow: senders.slice(0, 64), deny: [] }));
  assert.throws(() => previewManagedMailboxSpamPolicy({ mailboxes: owned, policies }), { code: 'mail_spam_policy_too_large' });
});
