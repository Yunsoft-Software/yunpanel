import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enableManagedMailSubmission,
  MailSubmissionTemplateError,
  mailSubmissionTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailSecurityConfiguration,
  previewManagedMailSubmissionConfiguration,
  renderPostfixSenderLoginMap,
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
  assert.deepEqual(preview.postfixMasterServices, [mailSubmissionTemplatePolicy.service]);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
});

test('submission sender login map is canonical, deterministic and empty for an empty managed set', () => {
  assert.equal(renderPostfixSenderLoginMap([]), '');
  assert.equal(
    renderPostfixSenderLoginMap(['Zed@Example.com', 'alice@example.com']),
    'alice@example.com alice@example.com\nzed@example.com zed@example.com\n',
  );
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
