import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';
import { mailTemplatePolicy } from './mail.js';

const ACME_ROOT = '/etc/letsencrypt/live';
const CUSTOM_ROOT = '/var/lib/yunpanel/control-plane/custom-certificates';
const TLS_PARAMETER_NAMES = new Set(['myhostname', 'smtpd_tls_cert_file', 'smtpd_tls_key_file']);

export class MailTlsIdentityTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailTlsIdentityTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalHostname(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { throw new MailTlsIdentityTemplateError('invalid_mail_tls_hostname', 'Mail TLS hostname is invalid'); }
}

function safeMaterialPath(value, expectedBasename) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value
    || path.basename(value) !== expectedBasename || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MailTlsIdentityTemplateError('invalid_mail_tls_material_path', 'Mail TLS material path is invalid');
  }
  const underAcme = value.startsWith(`${ACME_ROOT}/`);
  const underCustom = value.startsWith(`${CUSTOM_ROOT}/`);
  if (!underAcme && !underCustom) {
    throw new MailTlsIdentityTemplateError('invalid_mail_tls_material_path', 'Mail TLS material must stay under a managed certificate root');
  }
  return value;
}

function identity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.certificateId !== 'string' || value.certificateId.length < 8 || value.certificateId.length > 128
    || typeof value.certificateFingerprint256 !== 'string' || value.certificateFingerprint256.length < 5
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new MailTlsIdentityTemplateError('invalid_mail_tls_identity', 'Mail TLS identity metadata is invalid');
  }
  return Object.freeze({
    hostname: canonicalHostname(value.hostname),
    certificateId: value.certificateId,
    certificateFingerprint256: value.certificateFingerprint256,
    fullchainPath: safeMaterialPath(value.fullchainPath, 'fullchain.pem'),
    privateKeyPath: safeMaterialPath(value.privateKeyPath, 'privkey.pem'),
    revision: value.revision,
  });
}

function tlsDovecotArtifact(artifact, tlsIdentity) {
  if (!artifact || artifact.path !== mailTemplatePolicy.dovecotMailConfigPath
    || typeof artifact.content !== 'string' || artifact.sensitive === true) {
    throw new MailTlsIdentityTemplateError('mail_tls_dovecot_artifact_invalid', 'Managed Dovecot mail artifact is unavailable');
  }
  if (/^ssl_(?:cert|key)\s*=/m.test(artifact.content)) {
    throw new MailTlsIdentityTemplateError('mail_tls_dovecot_conflict', 'Managed Dovecot TLS material is already configured');
  }
  const content = `${artifact.content.trimEnd()}\nssl_cert = <${tlsIdentity.fullchainPath}\nssl_key = <${tlsIdentity.privateKeyPath}\n`;
  return Object.freeze({
    ...artifact,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
  });
}

export function bindManagedMailTlsIdentity(preview, rawIdentity) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.version !== 1 || typeof preview.sha256 !== 'string'
    || !Array.isArray(preview.artifacts) || !Array.isArray(preview.postfixParameters)) {
    throw new MailTlsIdentityTemplateError('mail_tls_preview_invalid', 'Managed mail preview is invalid');
  }
  const tlsIdentity = identity(rawIdentity);
  if (preview.postfixParameters.some((parameter) => TLS_PARAMETER_NAMES.has(parameter?.name))) {
    throw new MailTlsIdentityTemplateError('mail_tls_postfix_conflict', 'Managed Postfix TLS identity is already configured');
  }
  let dovecotArtifacts = 0;
  const artifacts = Object.freeze(preview.artifacts.map((artifact) => {
    if (artifact.path !== mailTemplatePolicy.dovecotMailConfigPath) return artifact;
    dovecotArtifacts += 1;
    return tlsDovecotArtifact(artifact, tlsIdentity);
  }));
  if (dovecotArtifacts !== 1) {
    throw new MailTlsIdentityTemplateError('mail_tls_artifact_set_invalid', 'Managed mail preview is missing its Dovecot mail artifact');
  }
  const postfixParameters = Object.freeze([
    ...preview.postfixParameters,
    Object.freeze({ name: 'myhostname', value: tlsIdentity.hostname }),
    Object.freeze({ name: 'smtpd_tls_cert_file', value: tlsIdentity.fullchainPath, protected: true }),
    Object.freeze({ name: 'smtpd_tls_key_file', value: tlsIdentity.privateKeyPath, protected: true }),
  ].sort((left, right) => left.name.localeCompare(right.name)));
  const publicIdentity = Object.freeze({
    hostname: tlsIdentity.hostname,
    certificateId: tlsIdentity.certificateId,
    certificateFingerprint256: tlsIdentity.certificateFingerprint256,
    revision: tlsIdentity.revision,
  });
  const digestIdentity = {
    version: 1,
    baseSha256: preview.sha256,
    tlsIdentity,
    artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    postfixParameters,
  };
  return Object.freeze({
    ...preview,
    sha256: sha256(JSON.stringify(digestIdentity)),
    artifacts,
    postfixParameters,
    tlsIdentity: publicIdentity,
    readyToApply: false,
    sideEffects: false,
  });
}

export const mailTlsIdentityTemplatePolicy = Object.freeze({
  acmeRoot: ACME_ROOT,
  customRoot: CUSTOM_ROOT,
  protectedPostfixParameters: Object.freeze(['smtpd_tls_cert_file', 'smtpd_tls_key_file']),
});

export const mailTlsIdentityTemplateInternals = Object.freeze({
  identity,
  safeMaterialPath,
  tlsDovecotArtifact,
});
