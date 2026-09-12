import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const apiSource = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const configSource = (name) => readFile(new URL(`../../../packages/config-templates/src/${name}`, import.meta.url), 'utf8');
const hostSource = (name) => readFile(new URL(`../../../packages/host-runtime/src/${name}`, import.meta.url), 'utf8');

test('managed mail desired state always composes security and authenticated submission', async () => {
  const [configuration, submission, applyPlan] = await Promise.all([
    apiSource('mail-configuration.js'),
    configSource('mail-submission.js'),
    configSource('mail-apply-plan.js'),
  ]);

  assert.match(configuration, /previewManagedMailSubmissionConfiguration/);
  assert.match(configuration, /enableManagedMailSubmission\([\s\S]*?secureManagedMailPreview\(previewManagedMailEmptyConfiguration\(\)\)[\s\S]*?\[\][\s\S]*?\)/);
  assert.match(configuration, /postfixMasterServices:\s*preview\.postfixMasterServices/);

  assert.match(submission, /SENDER_LOGIN_PATH = '\/etc\/yunpanel\/mail\/postfix\/sender-logins'/);
  assert.match(submission, /DOVECOT_AUTH_SOCKET = '\/var\/spool\/postfix\/private\/auth'/);
  assert.match(submission, /smtpd_tls_security_level', value: 'encrypt'/);
  assert.match(submission, /smtpd_sender_restrictions', value: 'reject_sender_login_mismatch'/);
  assert.match(submission, /smtpd_relay_restrictions', value: 'permit_sasl_authenticated,reject'/);

  assert.match(applyPlan, /configurePostfixMaster/);
  assert.match(applyPlan, /'\/usr\/sbin\/postconf', \['-M'/);
  assert.match(applyPlan, /'\/usr\/sbin\/postconf', \['-P'/);
});

test('smtp submission participates in staging, transactional rollback and lost-ack evidence', async () => {
  const [manager, backup, activator, evidence] = await Promise.all([
    hostSource('mail-config-manager.js'),
    hostSource('mail-config-backup.js'),
    hostSource('mail-config-activator.js'),
    hostSource('mail-config-evidence-inspector.js'),
  ]);

  assert.match(manager, /mailSubmissionTemplatePolicy\.senderLoginPath/);
  assert.match(manager, /MANIFEST_VERSION = 3/);

  assert.match(backup, /MANIFEST_VERSION = 4/);
  assert.match(backup, /POSTFIX_MASTER_CF_PATH = '\/etc\/postfix\/master\.cf'/);
  assert.match(backup, /mailSubmissionTemplatePolicy\.senderLoginPath/);
  assert.match(backup, /`\$\{mailSubmissionTemplatePolicy\.senderLoginPath\}\.db`/);

  assert.match(activator, /assertPostfixMasterServices/);
  assert.match(activator, /assertSubmissionSocketSafe/);
  assert.match(activator, /SUBMISSION_SOCKET_MODE = 0o660/);
  assert.match(activator, /parseManagedSystemIdentity\(output, name\)/);

  assert.match(evidence, /postfixMasterServiceSatisfied/);
  assert.match(evidence, /inspectSubmissionSocket/);
  assert.match(evidence, /SUBMISSION_SOCKET_MODE = 0o660/);
  assert.match(evidence, /mailSubmissionTemplatePolicy\.dovecotAuthSocket/);
});
