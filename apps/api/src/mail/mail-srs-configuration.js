import { createHash } from 'node:crypto';
import { assertUuid } from '@yunpanel/shared';
import { mailSrsTemplatePolicy } from '@yunpanel/config-templates';

export class MailSrsConfigurationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailSrsConfigurationError';
    this.code = code;
    this.status = status;
  }
}

function serverId(value) {
  try { return assertUuid(value, 'serverId'); }
  catch { throw new MailSrsConfigurationError('invalid_mail_srs_server_id', 'SRS server ID is invalid'); }
}

function secretContent(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new MailSrsConfigurationError('mail_srs_secret_invalid', 'Private SRS secret is invalid', 500);
  }
  return `${value}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createMailSrsConfigurationService({
  mailServiceIdentityRegistry,
  mailSrsSecretRegistry,
} = {}) {
  if (!mailServiceIdentityRegistry || typeof mailServiceIdentityRegistry.getForServer !== 'function'
    || typeof mailServiceIdentityRegistry.materializeForServer !== 'function'
    || !mailSrsSecretRegistry || typeof mailSrsSecretRegistry.getForServer !== 'function'
    || typeof mailSrsSecretRegistry.ensureForServer !== 'function'
    || typeof mailSrsSecretRegistry.materializeForServer !== 'function'
    || typeof mailSrsSecretRegistry.rotateForServer !== 'function') {
    throw new MailSrsConfigurationError('mail_srs_configuration_dependencies_invalid', 'SRS configuration dependencies are unavailable', 503);
  }

  async function previewForServer(value) {
    const id = serverId(value);
    const [identity, secret] = await Promise.all([
      mailServiceIdentityRegistry.getForServer(id),
      mailSrsSecretRegistry.getForServer(id),
    ]);
    const blockers = [];
    if (!identity) blockers.push('mail_service_identity_required');
    else if (identity.ready !== true) blockers.push(...(identity.blockers?.length ? identity.blockers : ['mail_service_identity_not_ready']));
    if (!secret) blockers.push('mail_srs_secret_required');
    return Object.freeze({
      version: 1,
      serverId: id,
      srsDomain: identity?.hostname ?? null,
      mailServiceIdentityRevision: identity?.revision ?? null,
      srsSecretRevision: secret?.revision ?? null,
      configured: Boolean(identity && secret),
      ready: blockers.length === 0,
      blockers: Object.freeze([...new Set(blockers)]),
      sideEffects: false,
    });
  }

  async function prepareForServer(value) {
    const id = serverId(value);
    const identity = await mailServiceIdentityRegistry.getForServer(id);
    if (!identity) {
      throw new MailSrsConfigurationError('mail_srs_identity_required', 'Configure the mail service TLS identity before preparing SRS', 409);
    }
    if (identity.ready !== true) {
      throw new MailSrsConfigurationError('mail_srs_identity_not_ready', 'Mail service TLS identity is not ready for SRS', 409);
    }
    await mailSrsSecretRegistry.ensureForServer(id);
    return previewForServer(id);
  }

  async function materializeForServer(value) {
    const id = serverId(value);
    let identity;
    let privateSecret;
    try {
      [identity, privateSecret] = await Promise.all([
        mailServiceIdentityRegistry.materializeForServer(id),
        mailSrsSecretRegistry.materializeForServer(id),
      ]);
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        throw new MailSrsConfigurationError('mail_srs_configuration_not_ready', 'SRS configuration is not ready to apply', 409);
      }
      throw error;
    }
    const content = secretContent(privateSecret.secret);
    return Object.freeze({
      version: 1,
      serverId: id,
      srsDomain: identity.hostname,
      mailServiceIdentityRevision: identity.revision,
      srsSecretRevision: privateSecret.revision,
      secretArtifact: Object.freeze({
        version: 1,
        path: mailSrsTemplatePolicy.secretPath,
        sha256: sha256(content),
        bytes: Buffer.byteLength(content),
        sensitive: true,
        contentIncluded: false,
        mode: mailSrsTemplatePolicy.secretMode,
      }),
      secretContent: content,
    });
  }

  async function rotateForServer(value, options = {}) {
    const id = serverId(value);
    const current = await previewForServer(id);
    if (!current.ready) {
      throw new MailSrsConfigurationError('mail_srs_configuration_not_ready', 'SRS configuration is not ready for secret rotation', 409);
    }
    await mailSrsSecretRegistry.rotateForServer(id, options);
    return previewForServer(id);
  }

  return Object.freeze({ previewForServer, prepareForServer, materializeForServer, rotateForServer });
}

export const mailSrsConfigurationInternals = Object.freeze({ serverId, secretContent, sha256 });
