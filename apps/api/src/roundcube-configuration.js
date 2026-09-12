import { createHash } from 'node:crypto';
import {
  previewRoundcubeConfiguration,
  previewRoundcubeFpmPool,
  previewRoundcubeNginxConfig,
  renderRoundcubeConfig,
  renderRoundcubeFpmPool,
  renderRoundcubeNginxConfig,
} from '@yunpanel/config-templates';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class RoundcubeConfigurationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RoundcubeConfigurationError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function serverId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RoundcubeConfigurationError('invalid_roundcube_server_id', 'Roundcube server ID is invalid');
  }
  return value.toLowerCase();
}

export function createRoundcubeConfigurationService({
  mailServiceIdentityRegistry,
  roundcubeSecretRegistry,
} = {}) {
  if (!mailServiceIdentityRegistry || typeof mailServiceIdentityRegistry.getForServer !== 'function'
    || typeof mailServiceIdentityRegistry.materializeForServer !== 'function'
    || !roundcubeSecretRegistry || typeof roundcubeSecretRegistry.getForServer !== 'function'
    || typeof roundcubeSecretRegistry.ensureForServer !== 'function'
    || typeof roundcubeSecretRegistry.materializeForServer !== 'function') {
    throw new RoundcubeConfigurationError('roundcube_configuration_dependencies_invalid', 'Roundcube configuration dependencies are unavailable', 503);
  }

  async function inspectDependencies(id) {
    const [identity, secret] = await Promise.all([
      mailServiceIdentityRegistry.getForServer(id),
      roundcubeSecretRegistry.getForServer(id),
    ]);
    const blockers = [];
    if (!identity) blockers.push('mail_service_identity_required');
    else if (identity.ready !== true) blockers.push(...(identity.blockers?.length ? identity.blockers : ['mail_service_identity_not_ready']));
    if (!secret) blockers.push('roundcube_secret_required');
    return Object.freeze({ identity, secret, blockers: Object.freeze([...new Set(blockers)]) });
  }

  async function materializeCurrent(id) {
    const [identity, secret] = await Promise.all([
      mailServiceIdentityRegistry.materializeForServer(id),
      roundcubeSecretRegistry.materializeForServer(id),
    ]);
    const configInput = Object.freeze({
      mailHostname: identity.hostname,
      desKey: secret.desKey,
    });
    const config = previewRoundcubeConfiguration(configInput);
    const fpmInput = Object.freeze({ temporaryDirectory: config.temporaryDirectory });
    const fpm = previewRoundcubeFpmPool(fpmInput);
    const nginxInput = Object.freeze({
      webHostname: identity.hostname,
      fullchainPath: identity.fullchainPath,
      privateKeyPath: identity.privateKeyPath,
      publicRoot: config.publicRoot,
      fpmSocketPath: fpm.socketPath,
    });
    const nginx = previewRoundcubeNginxConfig(nginxInput);
    const identityRecord = Object.freeze({
      version: 1,
      serverId: id,
      mailHostname: identity.hostname,
      certificateId: identity.certificateId,
      certificateFingerprint256: identity.certificateFingerprint256,
      mailServiceIdentityRevision: identity.revision,
      roundcubeSecretRevision: secret.revision,
      configSha256: config.sha256,
      fpmSha256: fpm.sha256,
      nginxSha256: nginx.sha256,
      databasePath: config.databasePath,
      publicRoot: config.publicRoot,
      fpmSocketPath: fpm.socketPath,
      fpmServiceUnit: fpm.serviceUnit,
      nginxServiceUnit: nginx.serviceUnit,
      webEndpoint: nginx.endpoint,
    });
    return Object.freeze({
      identity: identityRecord,
      sha256: digest(identityRecord),
      config,
      fpm,
      nginx,
      configContent: renderRoundcubeConfig(configInput),
      fpmContent: renderRoundcubeFpmPool(fpmInput),
      nginxContent: renderRoundcubeNginxConfig(nginxInput),
    });
  }

  function publicPreview(current) {
    return Object.freeze({
      ...current.identity,
      sha256: current.sha256,
      readyToApply: true,
      configuration: Object.freeze({
        version: current.config.version,
        sha256: current.config.sha256,
        artifact: current.config.artifact,
        mailHostname: current.config.mailHostname,
        databasePath: current.config.databasePath,
        temporaryDirectory: current.config.temporaryDirectory,
        databaseSchemaPath: current.config.databaseSchemaPath,
        publicRoot: current.config.publicRoot,
        requires: current.config.requires,
      }),
      fpm: current.fpm,
      nginx: current.nginx,
      sideEffects: false,
    });
  }

  async function previewForServer(value) {
    const id = serverId(value);
    const dependencies = await inspectDependencies(id);
    if (dependencies.blockers.length > 0) {
      return Object.freeze({
        version: 1,
        serverId: id,
        readyToApply: false,
        blockers: dependencies.blockers,
        sideEffects: false,
      });
    }
    return publicPreview(await materializeCurrent(id));
  }

  async function prepareForServer(value) {
    const id = serverId(value);
    const identity = await mailServiceIdentityRegistry.getForServer(id);
    if (!identity) {
      throw new RoundcubeConfigurationError('roundcube_mail_identity_required', 'Configure the mail service TLS identity before preparing Roundcube', 409);
    }
    if (identity.ready !== true) {
      throw new RoundcubeConfigurationError('roundcube_mail_identity_not_ready', 'Mail service TLS identity is not ready for Roundcube', 409);
    }
    await roundcubeSecretRegistry.ensureForServer(id);
    return publicPreview(await materializeCurrent(id));
  }

  async function materializeForServer(value, { expectedPreviewSha256 } = {}) {
    const id = serverId(value);
    if (typeof expectedPreviewSha256 !== 'string' || !SHA256_PATTERN.test(expectedPreviewSha256)) {
      throw new RoundcubeConfigurationError('roundcube_preview_identity_invalid', 'Roundcube preview digest is required', 409);
    }
    const dependencies = await inspectDependencies(id);
    if (dependencies.blockers.length > 0) {
      throw new RoundcubeConfigurationError('roundcube_configuration_not_ready', 'Roundcube configuration is not ready to apply', 409);
    }
    const current = await materializeCurrent(id);
    if (current.sha256 !== expectedPreviewSha256) {
      throw new RoundcubeConfigurationError('roundcube_preview_stale', 'Roundcube configuration changed after preview', 409);
    }
    return Object.freeze({
      preview: publicPreview(current),
      sensitiveArtifacts: Object.freeze([Object.freeze({
        path: current.config.artifact.path,
        content: current.configContent,
      })]),
      publicArtifacts: Object.freeze([
        Object.freeze({ path: current.fpm.artifact.path, content: current.fpmContent }),
        Object.freeze({ path: current.nginx.artifact.path, content: current.nginxContent }),
      ]),
    });
  }

  return Object.freeze({ previewForServer, prepareForServer, materializeForServer });
}

export const roundcubeConfigurationInternals = Object.freeze({ digest, serverId });