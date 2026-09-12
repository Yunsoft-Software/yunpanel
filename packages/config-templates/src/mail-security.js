import { createHash } from 'node:crypto';
import { mailTemplatePolicy } from './mail.js';
import { previewManagedMailForwardingConfiguration } from './mail-forwarding.js';

const TLS_MIN_PROTOCOL = 'TLSv1.2';
const LOOPBACK_NETWORKS = '127.0.0.0/8 [::1]/128';
const RELAY_RESTRICTIONS = 'permit_mynetworks, reject_unauth_destination';

const POSTFIX_SECURITY_PARAMETERS = Object.freeze([
  Object.freeze({ name: 'mynetworks', value: LOOPBACK_NETWORKS }),
  Object.freeze({ name: 'smtp_tls_protocols', value: `>=${TLS_MIN_PROTOCOL}` }),
  Object.freeze({ name: 'smtp_tls_security_level', value: 'may' }),
  Object.freeze({ name: 'smtpd_relay_restrictions', value: RELAY_RESTRICTIONS }),
  Object.freeze({ name: 'smtpd_sasl_auth_enable', value: 'no' }),
  Object.freeze({ name: 'smtpd_tls_auth_only', value: 'yes' }),
  Object.freeze({ name: 'smtpd_tls_protocols', value: `>=${TLS_MIN_PROTOCOL}` }),
  Object.freeze({ name: 'smtpd_tls_security_level', value: 'may' }),
]);

const DOVECOT_TLS_PREFIX = `ssl = required\nssl_min_protocol = ${TLS_MIN_PROTOCOL}\n\n`;

export class MailSecurityTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailSecurityTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicArtifact(artifact, content) {
  return Object.freeze({
    ...artifact,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
  });
}

function secureDovecotMailArtifact(artifact) {
  if (!artifact || artifact.path !== mailTemplatePolicy.dovecotMailConfigPath
    || typeof artifact.content !== 'string' || artifact.sensitive === true) {
    throw new MailSecurityTemplateError(
      'mail_security_dovecot_artifact_invalid',
      'Managed Dovecot mail configuration artifact is unavailable',
    );
  }
  if (/^ssl\s*=/m.test(artifact.content) || /^ssl_min_protocol\s*=/m.test(artifact.content)) {
    throw new MailSecurityTemplateError(
      'mail_security_dovecot_tls_conflict',
      'Managed Dovecot mail configuration already defines TLS policy',
    );
  }
  return publicArtifact(artifact, `${DOVECOT_TLS_PREFIX}${artifact.content}`);
}

function securePostfixParameters(parameters) {
  if (!Array.isArray(parameters)) {
    throw new MailSecurityTemplateError('mail_security_postfix_parameters_invalid', 'Managed Postfix parameters are invalid');
  }
  const byName = new Map();
  for (const parameter of parameters) {
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.value !== 'string'
      || byName.has(parameter.name)) {
      throw new MailSecurityTemplateError('mail_security_postfix_parameters_invalid', 'Managed Postfix parameters are invalid');
    }
    byName.set(parameter.name, Object.freeze({ name: parameter.name, value: parameter.value }));
  }
  for (const security of POSTFIX_SECURITY_PARAMETERS) {
    const existing = byName.get(security.name);
    if (existing && existing.value !== security.value) {
      throw new MailSecurityTemplateError(
        'mail_security_postfix_parameter_conflict',
        `Managed Postfix parameter ${security.name} conflicts with the security policy`,
      );
    }
    byName.set(security.name, security);
  }
  return Object.freeze([...byName.values()].sort((left, right) => left.name.localeCompare(right.name)));
}

export function secureManagedMailPreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.version !== 1 || typeof preview.sha256 !== 'string'
    || !Array.isArray(preview.artifacts) || !Array.isArray(preview.postfixParameters)
    || !Array.isArray(preview.validate) || !Array.isArray(preview.requirements)) {
    throw new MailSecurityTemplateError('mail_security_preview_invalid', 'Managed mail preview is invalid');
  }
  let replaced = 0;
  const artifacts = Object.freeze(preview.artifacts.map((artifact) => {
    if (artifact?.path !== mailTemplatePolicy.dovecotMailConfigPath) return artifact;
    replaced += 1;
    return secureDovecotMailArtifact(artifact);
  }));
  if (replaced !== 1) {
    throw new MailSecurityTemplateError(
      'mail_security_dovecot_artifact_invalid',
      'Managed mail preview must contain exactly one Dovecot mail configuration artifact',
    );
  }
  const postfixParameters = securePostfixParameters(preview.postfixParameters);
  const identity = {
    version: 1,
    baseSha256: preview.sha256,
    tlsPolicy: Object.freeze({ dovecot: 'required', minimumProtocol: TLS_MIN_PROTOCOL }),
    artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    postfixParameters,
  };
  return Object.freeze({
    ...preview,
    sha256: sha256(JSON.stringify(identity)),
    artifacts,
    postfixParameters,
    readyToApply: false,
    sideEffects: false,
  });
}

export function previewManagedMailSecurityConfiguration(input = {}) {
  return secureManagedMailPreview(previewManagedMailForwardingConfiguration(input));
}

export const mailSecurityTemplatePolicy = Object.freeze({
  tlsMinProtocol: TLS_MIN_PROTOCOL,
  loopbackNetworks: LOOPBACK_NETWORKS,
  relayRestrictions: RELAY_RESTRICTIONS,
  postfixParameters: POSTFIX_SECURITY_PARAMETERS,
  dovecotTlsPrefix: DOVECOT_TLS_PREFIX,
});

export const mailSecurityTemplateInternals = Object.freeze({
  secureDovecotMailArtifact,
  securePostfixParameters,
});
