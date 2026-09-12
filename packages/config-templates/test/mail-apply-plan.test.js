import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailApplyPlanError,
  previewManagedMailApplyPlan,
  previewManagedMailConfiguration,
} from '../src/index.js';

const ARGON2ID_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY';

function managedPreview() {
  return previewManagedMailConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'] }],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
  });
}

test('builds deterministic secret-free managed mail apply and rollback stages', () => {
  const preview = managedPreview();
  const plan = previewManagedMailApplyPlan(preview);

  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.previewSha256, preview.sha256);
  assert.equal(plan.readyToExecute, false);
  assert.equal(plan.sideEffects, false);
  assert.equal(plan.sensitiveMaterialRequired, true);
  assert.deepEqual(plan.stages.write.map((entry) => entry.path), preview.artifacts.map((entry) => entry.path));
  assert.deepEqual(plan.stages.compile, [
    { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-domains'] },
    { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-mailboxes'] },
    { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-aliases'] },
  ]);
  assert.deepEqual(plan.stages.reload.map((entry) => entry.args), [
    ['reload', 'rspamd'],
    ['reload', 'dovecot'],
    ['reload', 'postfix'],
  ]);
  assert.deepEqual(plan.rollback.reload.map((entry) => entry.args), [
    ['reload', 'postfix'],
    ['reload', 'dovecot'],
    ['reload', 'rspamd'],
  ]);
  assert.deepEqual(plan.stages.health.map((entry) => entry.args), [
    ['is-active', '--quiet', 'rspamd'],
    ['is-active', '--quiet', 'dovecot'],
    ['is-active', '--quiet', 'postfix'],
  ]);

  const protectedArtifact = plan.artifacts.find((entry) => entry.path.endsWith('/dovecot/users'));
  assert.deepEqual(protectedArtifact, {
    path: '/etc/yunpanel/mail/dovecot/users',
    sha256: preview.artifacts.find((entry) => entry.path.endsWith('/dovecot/users')).sha256,
    sensitive: true,
    contentIncluded: false,
  });
  assert.equal(JSON.stringify(plan).includes(ARGON2ID_HASH), false);
  assert.equal(previewManagedMailApplyPlan(preview).sha256, plan.sha256);
});

test('rejects malformed preview and unsafe Postfix parameter metadata', () => {
  assert.throws(
    () => previewManagedMailApplyPlan(null),
    (error) => error instanceof MailApplyPlanError && error.code === 'invalid_mail_preview',
  );

  const preview = managedPreview();
  assert.throws(
    () => previewManagedMailApplyPlan({
      ...preview,
      postfixParameters: [{ name: 'virtual_transport;rm', value: 'lmtp:unix:private/dovecot-lmtp' }],
    }),
    (error) => error instanceof MailApplyPlanError && error.code === 'invalid_postfix_parameter',
  );
  assert.throws(
    () => previewManagedMailApplyPlan({
      ...preview,
      postfixParameters: [{ name: 'virtual_transport', value: 'lmtp:unix:private/dovecot-lmtp\nrelayhost = attacker' }],
    }),
    (error) => error instanceof MailApplyPlanError && error.code === 'invalid_postfix_parameter',
  );
});

test('rejects compile and validator commands outside the managed allowlist', () => {
  const preview = managedPreview();
  const forgedArtifacts = preview.artifacts.map((artifact, index) => index === 0
    ? { ...artifact, compile: { file: '/bin/sh', args: ['-c', 'true'] } }
    : artifact);
  assert.throws(
    () => previewManagedMailApplyPlan({ ...preview, artifacts: forgedArtifacts }),
    (error) => error instanceof MailApplyPlanError && error.code === 'invalid_mail_compile_command',
  );
  assert.throws(
    () => previewManagedMailApplyPlan({
      ...preview,
      validate: [{ file: '/bin/true', args: [] }],
    }),
    (error) => error instanceof MailApplyPlanError && error.code === 'invalid_mail_validator',
  );
});
