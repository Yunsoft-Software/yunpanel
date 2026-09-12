import { createHash } from 'node:crypto';
import {
  MailDkimTemplateError,
  previewRspamdDkimSigningConfig,
} from '@yunpanel/config-templates';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class MailDkimConfigurationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDkimConfigurationError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function applyInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || typeof value.mailDomainId !== 'string' || !value.mailDomainId
    || !Number.isSafeInteger(value.expectedKeyRevision) || value.expectedKeyRevision < 1) {
    throw new MailDkimConfigurationError('mail_dkim_apply_input_invalid', 'Managed DKIM apply input is invalid');
  }
  return Object.freeze({ ...value });
}

function publicConfiguration(preview) {
  return Object.freeze({
    version: preview.version,
    sha256: preview.sha256,
    artifactDigest: Object.freeze({
      path: preview.artifact.path,
      sha256: preview.artifact.sha256,
    }),
    domains: preview.dnsRecords.length,
    sideEffects: false,
  });
}

function previewIdentity(input, targetKey, preview, dnsDiagnostics) {
  const configuration = publicConfiguration(preview);
  const dnsStates = Object.freeze(dnsDiagnostics.map((entry) => Object.freeze({
    mailDomainId: entry.mailDomainId,
    domainName: entry.domainName,
    state: entry.diagnostic.state,
  })));
  const identity = Object.freeze({
    version: 1,
    operation: 'mail_dkim_apply',
    mailDomainId: input.mailDomainId,
    expectedKeyRevision: input.expectedKeyRevision,
    selector: targetKey.selector,
    configurationSha256: configuration.sha256,
    dnsStates,
  });
  const previewDigest = digest(identity);
  const blockers = dnsStates.every((entry) => entry.state === 'ready')
    ? Object.freeze([])
    : Object.freeze(['mail_dkim_dns_not_ready']);
  return Object.freeze({
    ...identity,
    previewDigest,
    confirmation: `apply-mail-dkim:${input.mailDomainId}:${previewDigest}`,
    readyToApply: blockers.length === 0,
    blockers,
    configuration,
    dns: Object.freeze(dnsDiagnostics.map((entry) => Object.freeze({
      mailDomainId: entry.mailDomainId,
      domainName: entry.domainName,
      diagnostic: entry.diagnostic,
    }))),
    sideEffects: false,
  });
}

export function createMailDkimConfigurationService({
  mailDomainRegistry,
  mailDkimRegistry,
  mailDiagnosticsInspector,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || typeof mailDkimRegistry.listKeys !== 'function'
    || typeof mailDkimRegistry.materializePrivateKey !== 'function'
    || !mailDiagnosticsInspector || typeof mailDiagnosticsInspector.inspect !== 'function') {
    throw new MailDkimConfigurationError(
      'mail_dkim_configuration_dependencies_invalid',
      'Managed DKIM configuration dependencies are unavailable',
      503,
    );
  }

  async function materializeState(rawInput) {
    const input = applyInput(rawInput);
    const mailDomain = await mailDomainRegistry.getMailDomain(input.mailDomainId);
    if (!mailDomain) throw new MailDkimConfigurationError('mail_domain_not_found', 'Mail domain was not found', 404);
    if (mailDomain.managementMode !== 'local') {
      throw new MailDkimConfigurationError('mail_domain_not_locally_managed', 'Mail domain is not locally managed', 409);
    }
    if (!['enabled', 'disabled'].includes(mailDomain.status)) {
      throw new MailDkimConfigurationError('mail_dkim_domain_state_invalid', 'DKIM signing target mail-domain state is invalid', 409);
    }
    const targetKey = await mailDkimRegistry.getKey(input.mailDomainId);
    if (!targetKey) throw new MailDkimConfigurationError('mail_dkim_key_not_found', 'DKIM key was not found', 404);
    if (targetKey.revision !== input.expectedKeyRevision) {
      throw new MailDkimConfigurationError('stale_mail_dkim_revision', 'DKIM key state changed; refresh and retry', 409);
    }
    if (targetKey.domainName !== mailDomain.domainName) {
      throw new MailDkimConfigurationError('mail_dkim_state_invalid', 'DKIM key domain identity is inconsistent', 409);
    }

    const domains = new Map((await mailDomainRegistry.listMailDomains()).map((item) => [item.id, item]));
    const enabledKeys = [];
    for (const key of await mailDkimRegistry.listKeys()) {
      const owner = domains.get(key.mailDomainId);
      if (!owner) {
        throw new MailDkimConfigurationError('mail_dkim_state_invalid', 'DKIM key references an unavailable mail domain', 409);
      }
      if (owner.domainName !== key.domainName) {
        throw new MailDkimConfigurationError('mail_dkim_state_invalid', 'DKIM key domain identity is inconsistent', 409);
      }
      if (owner.managementMode === 'local' && owner.status === 'enabled') enabledKeys.push(key);
    }
    enabledKeys.sort((left, right) => left.domainName.localeCompare(right.domainName));
    if (mailDomain.status === 'enabled'
      && !enabledKeys.some((key) => key.mailDomainId === input.mailDomainId)) {
      throw new MailDkimConfigurationError('mail_dkim_state_invalid', 'Target DKIM key is missing from enabled signing state', 409);
    }

    let preview;
    try {
      preview = previewRspamdDkimSigningConfig(enabledKeys.map((key) => ({
        domain: key.domainName,
        selector: key.selector,
        publicKey: key.publicKey,
      })));
    } catch (error) {
      if (error instanceof MailDkimTemplateError) {
        throw new MailDkimConfigurationError('mail_dkim_state_invalid', 'Managed DKIM signing state is invalid', 409);
      }
      throw error;
    }

    const dnsDiagnostics = Object.freeze(await Promise.all(enabledKeys.map(async (key) => {
      const diagnostics = await mailDiagnosticsInspector.inspect(key.domainName, { dkim: key });
      const diagnostic = diagnostics?.diagnostics?.dkim;
      if (!diagnostic || typeof diagnostic.state !== 'string') {
        throw new MailDkimConfigurationError('mail_dkim_diagnostics_invalid', 'Managed DKIM DNS diagnostics are unavailable', 503);
      }
      return Object.freeze({
        mailDomainId: key.mailDomainId,
        domainName: key.domainName,
        diagnostic,
      });
    })));
    return Object.freeze({
      input,
      targetKey,
      enabledKeys: Object.freeze(enabledKeys),
      preview,
      publicPreview: previewIdentity(input, targetKey, preview, dnsDiagnostics),
    });
  }

  async function previewApply(input) {
    return (await materializeState(input)).publicPreview;
  }

  async function materializeApply(input, {
    expectedPreviewDigest,
    expectedConfigurationSha256,
  } = {}) {
    if (typeof expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(expectedPreviewDigest)
      || typeof expectedConfigurationSha256 !== 'string' || !SHA256_PATTERN.test(expectedConfigurationSha256)) {
      throw new MailDkimConfigurationError('mail_dkim_apply_identity_invalid', 'Current DKIM configuration digests are required', 409);
    }
    const state = await materializeState(input);
    if (!state.publicPreview.readyToApply) {
      throw new MailDkimConfigurationError('mail_dkim_dns_not_ready', 'Every enabled managed DKIM DNS record must be ready before signing is applied', 409);
    }
    if (state.publicPreview.previewDigest !== expectedPreviewDigest
      || state.preview.sha256 !== expectedConfigurationSha256) {
      throw new MailDkimConfigurationError('mail_dkim_preview_stale', 'Managed DKIM state changed after preview', 409);
    }

    const keys = [];
    for (const key of state.enabledKeys) {
      const materialized = await mailDkimRegistry.materializePrivateKey(key.mailDomainId);
      const metadata = materialized?.metadata;
      if (!metadata || metadata.domainName !== key.domainName || metadata.selector !== key.selector
        || metadata.publicKey !== key.publicKey || metadata.revision !== key.revision
        || typeof materialized.privateKey !== 'string') {
        throw new MailDkimConfigurationError('mail_dkim_private_state_invalid', 'Managed DKIM private state is inconsistent', 409);
      }
      keys.push(Object.freeze({
        domain: metadata.domainName,
        selector: metadata.selector,
        publicKey: metadata.publicKey,
        privateKey: materialized.privateKey,
      }));
    }

    const current = await materializeState(input);
    if (!current.publicPreview.readyToApply
      || current.publicPreview.previewDigest !== expectedPreviewDigest
      || current.preview.sha256 !== expectedConfigurationSha256) {
      throw new MailDkimConfigurationError('mail_dkim_preview_stale', 'Managed DKIM state changed during private materialization', 409);
    }
    return Object.freeze({
      preview: current.preview,
      keys: Object.freeze(keys),
    });
  }

  return Object.freeze({ previewApply, materializeApply });
}

export const mailDkimConfigurationInternals = Object.freeze({
  applyInput,
  publicConfiguration,
  previewIdentity,
});
