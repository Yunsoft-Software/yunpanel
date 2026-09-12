import { createHash } from 'node:crypto';
import { normalizeMailboxAddress, mailTemplatePolicy } from './mail.js';
import { mailSecurityTemplatePolicy, previewManagedMailSecurityConfiguration } from './mail-security.js';

const SENDER_LOGIN_PATH = '/etc/yunpanel/mail/postfix/sender-logins';
const DOVECOT_AUTH_SOCKET = '/var/spool/postfix/private/auth';
const POSTFIX_SUBMISSION_SERVICE = Object.freeze({
  service: 'submission',
  type: 'inet',
  definition: 'submission inet n - n - - smtpd',
  parameters: Object.freeze([
    Object.freeze({ name: 'syslog_name', value: 'postfix/submission' }),
    Object.freeze({ name: 'smtpd_recipient_restrictions', value: 'permit_sasl_authenticated,reject' }),
    Object.freeze({ name: 'smtpd_relay_restrictions', value: 'permit_sasl_authenticated,reject' }),
    Object.freeze({ name: 'smtpd_sasl_auth_enable', value: 'yes' }),
    Object.freeze({ name: 'smtpd_sasl_path', value: 'private/auth' }),
    Object.freeze({ name: 'smtpd_sasl_security_options', value: 'noanonymous' }),
    Object.freeze({ name: 'smtpd_sasl_type', value: 'dovecot' }),
    Object.freeze({ name: 'smtpd_sender_login_maps', value: `hash:${SENDER_LOGIN_PATH}` }),
    Object.freeze({ name: 'smtpd_sender_restrictions', value: 'reject_sender_login_mismatch' }),
    Object.freeze({ name: 'smtpd_tls_auth_only', value: 'yes' }),
    Object.freeze({ name: 'smtpd_tls_mandatory_protocols', value: `>=${mailSecurityTemplatePolicy.tlsMinProtocol}` }),
    Object.freeze({ name: 'smtpd_tls_security_level', value: 'encrypt' }),
  ]),
});
const AUTH_APPEND = [
  '',
  'service auth {',
  `  unix_listener ${DOVECOT_AUTH_SOCKET} {`,
  '    mode = 0660',
  '    user = postfix',
  '    group = postfix',
  '  }',
  '}',
  '',
].join('\n');

export class MailSubmissionTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailSubmissionTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalAddresses(values) {
  if (!Array.isArray(values) || values.length > mailTemplatePolicy.maxMailboxes) {
    throw new MailSubmissionTemplateError('invalid_submission_mailboxes', 'Submission mailbox set is invalid');
  }
  const result = values.map((value) => normalizeMailboxAddress(value).address).sort();
  if (new Set(result).size !== result.length) {
    throw new MailSubmissionTemplateError('duplicate_submission_mailbox', 'Submission mailbox addresses must be unique');
  }
  return Object.freeze(result);
}

export function renderPostfixSenderLoginMap(mailboxes = []) {
  const addresses = canonicalAddresses(mailboxes);
  return addresses.length === 0 ? '' : `${addresses.map((address) => `${address} ${address}`).join('\n')}\n`;
}

function senderLoginArtifact(mailboxes) {
  const content = renderPostfixSenderLoginMap(mailboxes);
  return Object.freeze({
    version: 1,
    path: SENDER_LOGIN_PATH,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
    sensitive: false,
    compile: Object.freeze({ file: '/usr/sbin/postmap', args: Object.freeze([`hash:${SENDER_LOGIN_PATH}`]) }),
    sideEffects: false,
  });
}

function submissionAuthArtifact(artifact) {
  if (!artifact || artifact.path !== mailTemplatePolicy.dovecotAuthConfigPath
    || typeof artifact.content !== 'string' || artifact.sensitive === true) {
    throw new MailSubmissionTemplateError(
      'submission_dovecot_auth_invalid',
      'Managed Dovecot authentication artifact is unavailable',
    );
  }
  const mechanisms = [...artifact.content.matchAll(/^auth_mechanisms\s*=\s*([^\r\n]+)$/gm)];
  if (mechanisms.length !== 1 || mechanisms[0][1].trim().toLowerCase() !== 'plain login'
    || artifact.content.includes(`unix_listener ${DOVECOT_AUTH_SOCKET}`)) {
    throw new MailSubmissionTemplateError(
      'submission_dovecot_auth_conflict',
      'Managed Dovecot authentication policy is not canonical for submission',
    );
  }
  const content = `${artifact.content.trimEnd()}\n${AUTH_APPEND}`;
  return Object.freeze({
    ...artifact,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
  });
}

export function enableManagedMailSubmission(preview, mailboxes = []) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.version !== 1 || typeof preview.sha256 !== 'string'
    || !Array.isArray(preview.artifacts) || !Array.isArray(preview.postfixParameters)) {
    throw new MailSubmissionTemplateError('submission_preview_invalid', 'Managed mail preview is invalid');
  }
  const loginArtifact = senderLoginArtifact(mailboxes);
  const artifacts = [];
  let authArtifacts = 0;
  let insertedSenderLogins = false;
  for (const artifact of preview.artifacts) {
    if (artifact?.path === SENDER_LOGIN_PATH) {
      throw new MailSubmissionTemplateError('submission_sender_login_conflict', 'Managed sender login map path is duplicated');
    }
    if (!insertedSenderLogins && artifact?.path === mailTemplatePolicy.dovecotPasswdFilePath) {
      artifacts.push(loginArtifact);
      insertedSenderLogins = true;
    }
    if (artifact?.path === mailTemplatePolicy.dovecotAuthConfigPath) {
      authArtifacts += 1;
      artifacts.push(submissionAuthArtifact(artifact));
    } else {
      artifacts.push(artifact);
    }
  }
  if (!insertedSenderLogins || authArtifacts !== 1) {
    throw new MailSubmissionTemplateError(
      'submission_artifact_set_invalid',
      'Managed mail preview does not contain the canonical submission insertion points',
    );
  }
  const frozenArtifacts = Object.freeze(artifacts);
  const identity = Object.freeze({
    version: 1,
    baseSha256: preview.sha256,
    artifactDigests: frozenArtifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    postfixMasterServices: Object.freeze([POSTFIX_SUBMISSION_SERVICE]),
  });
  return Object.freeze({
    ...preview,
    sha256: sha256(JSON.stringify(identity)),
    artifacts: frozenArtifacts,
    postfixMasterServices: Object.freeze([POSTFIX_SUBMISSION_SERVICE]),
    readyToApply: false,
    sideEffects: false,
  });
}

export function previewManagedMailSubmissionConfiguration(input = {}) {
  return enableManagedMailSubmission(
    previewManagedMailSecurityConfiguration(input),
    input.mailboxes ?? [],
  );
}

export const mailSubmissionTemplatePolicy = Object.freeze({
  senderLoginPath: SENDER_LOGIN_PATH,
  dovecotAuthSocket: DOVECOT_AUTH_SOCKET,
  service: POSTFIX_SUBMISSION_SERVICE,
});

export const mailSubmissionTemplateInternals = Object.freeze({
  authAppend: AUTH_APPEND,
  canonicalAddresses,
  senderLoginArtifact,
  submissionAuthArtifact,
});
