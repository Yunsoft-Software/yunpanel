import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailApplyPlanError,
  mailSubmissionTemplatePolicy,
  previewManagedMailApplyPlan,
  previewManagedMailSubmissionConfiguration,
} from '../src/index.js';

const ARGON2ID_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY';

function managedPreview(overrides = {}) {
  return previewManagedMailSubmissionConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'] }],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [],
    ...overrides,
  });
}

function forwardingPreview() {
  return managedPreview({
    aliases: [],
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['backup@elsewhere.test'] }],
  });
}

const EXPECTED_COMPILE = [
  { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-domains'] },
  { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-mailboxes'] },
  { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-aliases'] },
  { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/sender-logins'] },
  { file: '/usr/bin/sievec', args: ['/etc/dovecot/yunpanel-forwarding.sieve'] },
];

test('builds deterministic secret-free managed mail apply and rollback stages with guarded submission', () => {
  const preview = managedPreview();
  const plan = previewManagedMailApplyPlan(preview);

  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.previewSha256, preview.sha256);
  assert.equal(plan.readyToExecute, false);
  assert.equal(plan.sideEffects, false);
  assert.equal(plan.sensitiveMaterialRequired, true);
  assert.deepEqual(plan.stages.write.map((entry) => entry.path), preview.artifacts.map((entry) => entry.path));
  assert.deepEqual(plan.stages.compile, EXPECTED_COMPILE);
  assert.deepEqual(plan.postfixMasterServices, [mailSubmissionTemplatePolicy.service]);
  assert.equal(plan.stages.configurePostfixMaster.length, 1 + mailSubmissionTemplatePolicy.service.parameters.length);
  assert.deepEqual(plan.stages.configurePostfixMaster[0], {
    file: '/usr/sbin/postconf',
    args: ['-M', 'submission/inet=submission inet n - n - - smtpd'],
  });
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

test('forwarding-aware submission plan keeps the same fixed compile allowlist', () => {
  const preview = forwardingPreview();
  const plan = previewManagedMailApplyPlan(preview);
  assert.deepEqual(plan.stages.compile, EXPECTED_COMPILE);
  assert.equal(plan.artifacts.some((artifact) => artifact.path === '/etc/dovecot/yunpanel-forwarding.sieve'), true);
  assert.equal(plan.artifacts.some((artifact) => artifact.path === mailSubmissionTemplatePolicy.senderLoginPath), true);
});

test('rejects malformed preview, unsafe Postfix metadata and forged submission master state', () => {
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
  const forgedService = [{
    ...mailSubmissionTemplatePolicy.service,
    parameters: mailSubmissionTemplatePolicy.service.parameters.map((parameter) => parameter.name === 'smtpd_tls_security_level'
      ? { ...parameter, value: 'may' }
      : parameter),
  }];
  assert.throws(
    () => previewManagedMailApplyPlan({ ...preview, postfixMasterServices: forgedService }),
    (error) => error instanceof MailApplyPlanError && error.code === 'invalid_postfix_master_service',
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

  const forwarding = forwardingPreview();
  const forgedSieve = forwarding.artifacts.map((artifact) => artifact.path === '/etc/dovecot/yunpanel-forwarding.sieve'
    ? { ...artifact, compile: { file: '/usr/bin/sievec', args: ['/tmp/attacker.sieve'] } }
    : artifact);
  assert.throws(
    () => previewManagedMailApplyPlan({ ...forwarding, artifacts: forgedSieve }),
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
