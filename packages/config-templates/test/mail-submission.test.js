import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enableManagedMailSubmission,
  mailForwardingTemplatePolicy,
  mailSpamPolicyTemplatePolicy,
  MailSubmissionTemplateError,
  mailSubmissionTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailEmptyConfiguration,
  previewManagedMailSecurityConfiguration,
  previewManagedMailSubmissionConfiguration,
  renderPostfixSenderLoginMap,
  secureManagedMailPreview,
} from '../src/index.js';

const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 7).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 8).toString('base64').replace(/=+$/, '')}`;

function input() {
  return {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: HASH, quotaBytes: null }],
    postmasterAddress: 'owner@example.com',
    forwardings: [],
  };
}

test('submission preview reuses canonical Dovecot auth mechanisms and adds one protected auth socket', () => {
  const preview = previewManagedMailSubmissionConfiguration(input());
  const auth = preview.artifacts.find((artifact) => artifact.path === mailTemplatePolicy.dovecotAuthConfigPath);
  const senderLogins = preview.artifacts.find((artifact) => artifact.path === mailSubmissionTemplatePolicy.senderLoginPath);

  assert.ok(auth);
  assert.equal((auth.content.match(/^auth_mechanisms\s*=\s*plain login$/gm) ?? []).length, 1);
  assert.equal((auth.content.match(/unix_listener \/var\/spool\/postfix\/private\/auth/g) ?? []).length, 1);
  assert.match(auth.content, /mode = 0660\n\s+user = postfix\n\s+group = postfix/);

  assert.ok(senderLogins);
  assert.equal(senderLogins.content, 'owner@example.com owner@example.com\n');
  assert.deepEqual(preview.postfixMasterServices, mailSubmissionTemplatePolicy.services);
  assert.equal(preview.postfixMasterServices.length, 2);
  const submission = preview.postfixMasterServices.find((entry) => entry.service === 'submission');
  const submissions = preview.postfixMasterServices.find((entry) => entry.service === 'submissions');
  assert.ok(submission);
  assert.ok(submissions);
  assert.equal(submission.parameters.find((p) => p.name === 'smtpd_tls_security_level').value, 'encrypt');
  assert.equal(submission.parameters.find((p) => p.name === 'smtpd_tls_auth_only').value, 'yes');
  assert.equal(submissions.parameters.find((p) => p.name === 'smtpd_tls_wrappermode').value, 'yes');
  assert.equal(submissions.parameters.find((p) => p.name === 'smtpd_tls_security_level').value, 'encrypt');
  assert.equal(submissions.parameters.find((p) => p.name === 'smtpd_tls_auth_only').value, 'yes');
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
});

test('submission sender login map is canonical, deterministic and empty for an empty managed set', () => {
  assert.equal(renderPostfixSenderLoginMap([]), '');
  assert.equal(
    renderPostfixSenderLoginMap(['Zed@Example.com', 'alice@example.com']),
    'alice@example.com alice@example.com\nzed@example.com zed@example.com\n',
  );
  assert.equal(
    renderPostfixSenderLoginMap(
      ['alice@example.com'],
      [{ source: 'info@example.com', destinations: ['alice@example.com'] }],
    ),
    'alice@example.com alice@example.com\ninfo@example.com alice@example.com\n',
  );
});

test('submission combines vacation before forwarding and uses an independent, clearable spam artifact', () => {
  const fixture = {
    ...input(),
    forwardings: [{ source: 'owner@example.com', mode: 'redirect', destinations: ['outside@elsewhere.test'] }],
  };
  const baseline = previewManagedMailSubmissionConfiguration(fixture);
  const preview = previewManagedMailSubmissionConfiguration({
    ...fixture,
    vacations: [{ mailbox: 'Owner@EXAMPLE.COM', subject: 'Yıllık izin', body: 'Cuma günü döneceğim.' }],
    spamPolicies: [{ mailbox: 'owner@example.com', allow: [], deny: ['sender@elsewhere.test'] }],
  });
  const cleared = previewManagedMailSubmissionConfiguration({ ...fixture, vacations: [], spamPolicies: [] });
  const delivery = (value) => value.artifacts.find((artifact) => artifact.path === mailForwardingTemplatePolicy.sievePath);
  const spam = (value) => value.artifacts.find((artifact) => artifact.path === mailSpamPolicyTemplatePolicy.path);

  assert.equal(delivery(preview).sensitive, true);
  assert.match(delivery(preview).content, /^require \["envelope", "copy", "vacation"\];/);
  assert.match(delivery(preview).content, /vacation[\s\S]*Cuma günü döneceğim\.[\s\S]*redirect "outside@elsewhere\.test"/);
  assert.deepEqual(delivery(preview).compile, delivery(baseline).compile);
  assert.equal(delivery(cleared).content, delivery(baseline).content);
  assert.equal(delivery(cleared).sensitive, false);

  assert.equal(spam(baseline), undefined);
  assert.equal(spam(preview).sensitive, true);
  assert.match(spam(preview).content, /multimap \{[\s\S]*YUNPANEL_MAIL_POLICY_DENY[\s\S]*mailbox\|owner@example\.com\|sender@elsewhere\.test/);
  assert.equal(spam(cleared).content, mailSpamPolicyTemplatePolicy.header);
  assert.equal(new Set([preview.sha256, cleared.sha256, baseline.sha256]).size, 3);
});

test('submission refuses vacation and spam policies for a mailbox outside its validated set', () => {
  assert.throws(() => previewManagedMailSubmissionConfiguration({
    ...input(),
    vacations: [{ mailbox: 'foreign@example.com', subject: 'Away', body: 'Back tomorrow' }],
  }), { code: 'mail_vacation_mailbox_invalid' });
  assert.throws(() => previewManagedMailSubmissionConfiguration({
    ...input(),
    spamPolicies: [{ mailbox: 'foreign@example.com', allow: [], deny: ['sender@elsewhere.test'] }],
  }), { code: 'mail_spam_mailbox_invalid' });
});

test('the last managed domain can clear only the owned spam policy', () => {
  const empty = secureManagedMailPreview(previewManagedMailEmptyConfiguration());
  const legacy = enableManagedMailSubmission(empty);
  const cleared = enableManagedMailSubmission(empty, [], [], []);
  const policy = cleared.artifacts.find((artifact) => artifact.path === mailSpamPolicyTemplatePolicy.path);
  assert.equal(policy.content, mailSpamPolicyTemplatePolicy.header);
  assert.deepEqual(cleared.artifacts.filter((artifact) => artifact !== policy), legacy.artifacts);
  assert.notEqual(cleared.sha256, legacy.sha256);
});

test('submission rejects drifted Dovecot authentication policy instead of silently weakening it', () => {
  const base = previewManagedMailSecurityConfiguration(input());
  const artifacts = base.artifacts.map((artifact) => artifact.path === mailTemplatePolicy.dovecotAuthConfigPath
    ? { ...artifact, content: artifact.content.replace('auth_mechanisms = plain login', 'auth_mechanisms = plain') }
    : artifact);

  assert.throws(
    () => enableManagedMailSubmission({ ...base, artifacts }, ['owner@example.com']),
    (error) => error instanceof MailSubmissionTemplateError && error.code === 'submission_dovecot_auth_conflict',
  );
});
