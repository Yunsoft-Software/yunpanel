import { createHash } from 'node:crypto';
import {
  MailForwardingTemplateError,
  MailQuotaTemplateError,
  MailSecurityTemplateError,
  MailSrsTemplateError,
  MailSubmissionTemplateError,
  MailTemplateError,
  MailTlsIdentityTemplateError,
  bindManagedMailTlsIdentity,
  enableManagedMailSrs,
  enableManagedMailSubmission,
  mailSrsTemplatePolicy,
  mailTemplatePolicy,
  normalizeMailboxAddress,
  previewManagedMailEmptyConfiguration,
  previewManagedMailSubmissionConfiguration,
  renderDovecotQuotaPasswdFile,
  secureManagedMailPreview,
} from '@yunpanel/config-templates';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_STATUSES = new Set(['disabled', 'enabled']);
const EMPTY_QUOTA_REGISTRY = Object.freeze({ listQuotas: async () => [] });
const EMPTY_FORWARDING_REGISTRY = Object.freeze({ materializeEnabledForwardings: async () => [] });

export class MailConfigurationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailConfigurationError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function transitionInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || typeof value.mailDomainId !== 'string' || !value.mailDomainId
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || typeof value.status !== 'string' || !LOCAL_STATUSES.has(value.status)) {
    throw new MailConfigurationError('mail_configuration_transition_invalid', 'Mail configuration transition is invalid');
  }
  return value;
}

function externalForwardingRequired(domains, forwardings) {
  const localDomains = new Set(domains);
  return forwardings.some((policy) => policy.destinations.some(
    (destination) => !localDomains.has(normalizeMailboxAddress(destination).domain),
  ));
}

function publicPostfixParameter(parameter) {
  if (parameter?.protected === true) {
    return Object.freeze({
      name: parameter.name,
      protected: true,
      valueSha256: digest(parameter.value),
    });
  }
  return Object.freeze({ name: parameter.name, value: parameter.value });
}

function publicConfigurationPreview(preview) {
  return Object.freeze({
    version: preview.version,
    sha256: preview.sha256,
    counts: preview.counts,
    artifactDigests: Object.freeze(preview.artifacts.map((artifact) => Object.freeze({
      path: artifact.path,
      sha256: artifact.sha256,
      sensitive: artifact.sensitive === true,
    }))),
    postfixParameters: Object.freeze(preview.postfixParameters.map(publicPostfixParameter)),
    postfixMasterServices: preview.postfixMasterServices ?? Object.freeze([]),
    tlsIdentity: preview.tlsIdentity ?? null,
    srs: preview.srs ?? null,
    validate: preview.validate,
    requirements: preview.requirements,
    sideEffects: false,
  });
}

function transitionPreview(resolved, materialized) {
  const configuration = materialized.preview ? publicConfigurationPreview(materialized.preview) : null;
  const identity = Object.freeze({
    version: 1,
    operation: 'mail_configuration_apply',
    mailDomainId: resolved.candidate.id,
    expectedRevision: resolved.candidate.revision,
    currentStatus: resolved.candidate.status,
    desiredStatus: resolved.input.status,
    domains: resolved.domains,
    configurationSha256: configuration?.sha256 ?? null,
    blockers: materialized.blockers,
  });
  const previewDigest = digest(identity);
  return Object.freeze({
    ...identity,
    previewDigest,
    confirmation: `apply-mail-configuration:${resolved.candidate.id}:${previewDigest}`,
    readyToApply: materialized.ready,
    configuration,
    sideEffects: false,
  });
}

export function createMailConfigurationService({
  mailDomainRegistry,
  mailboxRegistry,
  mailAliasRegistry,
  mailboxQuotaRegistry = EMPTY_QUOTA_REGISTRY,
  mailboxForwardingRegistry = EMPTY_FORWARDING_REGISTRY,
  domainRegistry = null,
  mailServiceIdentityRegistry = null,
  mailSrsConfigurationService = null,
} = {}) {
  const tlsIdentityConfigured = domainRegistry !== null || mailServiceIdentityRegistry !== null;
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.listMailboxes !== 'function'
    || typeof mailboxRegistry.materializeEnabledAccounts !== 'function'
    || !mailAliasRegistry || typeof mailAliasRegistry.materializeEnabledAliases !== 'function'
    || !mailboxQuotaRegistry || typeof mailboxQuotaRegistry.listQuotas !== 'function'
    || !mailboxForwardingRegistry || typeof mailboxForwardingRegistry.materializeEnabledForwardings !== 'function'
    || (tlsIdentityConfigured && (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
      || !mailServiceIdentityRegistry || typeof mailServiceIdentityRegistry.materializeForServer !== 'function'))
    || (mailSrsConfigurationService !== null
      && (typeof mailSrsConfigurationService.previewForServer !== 'function'
        || typeof mailSrsConfigurationService.materializeForServer !== 'function'))) {
    throw new MailConfigurationError('mail_configuration_dependencies_invalid', 'Mail configuration registries are unavailable', 503);
  }

  async function resolveTransition(input) {
    const normalized = transitionInput(input);
    const candidate = await mailDomainRegistry.getMailDomain(normalized.mailDomainId);
    if (!candidate) throw new MailConfigurationError('mail_domain_not_found', 'Mail domain was not found', 404);
    if (candidate.managementMode !== 'local') {
      throw new MailConfigurationError('mail_domain_not_locally_managed', 'Mail domain is not locally managed', 409);
    }
    if (candidate.revision !== normalized.expectedRevision) {
      throw new MailConfigurationError('mail_domain_revision_conflict', 'Mail domain changed after the transition was prepared', 409);
    }
    if (candidate.status === normalized.status && normalized.status !== 'enabled') {
      throw new MailConfigurationError('mail_domain_status_no_change', 'Mail domain already has the requested status', 409);
    }

    const domains = (await mailDomainRegistry.listMailDomains())
      .filter((mailDomain) => mailDomain.managementMode === 'local'
        && (mailDomain.id === candidate.id ? normalized.status === 'enabled' : mailDomain.status === 'enabled'))
      .map((mailDomain) => mailDomain.domainName)
      .sort();
    return Object.freeze({ candidate, input: Object.freeze({ ...normalized }), domains: Object.freeze(domains) });
  }

  async function resolveTlsIdentity(resolved) {
    if (!tlsIdentityConfigured || resolved.domains.length === 0) {
      return Object.freeze({ identity: null, blocker: null, serverId: null });
    }
    if (!resolved.candidate.webDomainId) {
      return Object.freeze({ identity: null, blocker: 'mail_service_domain_required', serverId: null });
    }
    let webDomain;
    try { webDomain = await domainRegistry.getDomain(resolved.candidate.webDomainId); }
    catch {
      throw new MailConfigurationError('mail_service_domain_unavailable', 'Mail service Domain could not be verified', 503);
    }
    if (!webDomain || typeof webDomain.serverId !== 'string' || !webDomain.serverId) {
      return Object.freeze({ identity: null, blocker: 'mail_service_domain_required', serverId: null });
    }
    try {
      return Object.freeze({
        identity: await mailServiceIdentityRegistry.materializeForServer(webDomain.serverId),
        blocker: null,
        serverId: webDomain.serverId,
      });
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
        && typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)) {
        return Object.freeze({ identity: null, blocker: error.code, serverId: webDomain.serverId });
      }
      throw new MailConfigurationError('mail_service_identity_unavailable', 'Mail service TLS identity could not be materialized', 503);
    }
  }

  async function materializeSrs(resolved, forwardings, tlsIdentity) {
    if (!externalForwardingRequired(resolved.domains, forwardings)) return null;
    if (!mailSrsConfigurationService) {
      return Object.freeze({ blocker: 'mail_srs_configuration_unavailable' });
    }
    if (!tlsIdentity.serverId) {
      return Object.freeze({ blocker: 'mail_service_domain_required' });
    }
    let publicSrs;
    try { publicSrs = await mailSrsConfigurationService.previewForServer(tlsIdentity.serverId); }
    catch {
      throw new MailConfigurationError('mail_srs_configuration_unavailable', 'Managed SRS state could not be inspected', 503);
    }
    if (!publicSrs?.ready) {
      const blockers = Array.isArray(publicSrs?.blockers) && publicSrs.blockers.length > 0
        ? publicSrs.blockers
        : ['mail_srs_configuration_not_ready'];
      return Object.freeze({ blockers: Object.freeze([...new Set(blockers)]) });
    }
    let privateSrs;
    try { privateSrs = await mailSrsConfigurationService.materializeForServer(tlsIdentity.serverId); }
    catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        return Object.freeze({ blocker: error.code ?? 'mail_srs_configuration_not_ready' });
      }
      throw new MailConfigurationError('mail_srs_configuration_unavailable', 'Managed SRS state could not be materialized', 503);
    }
    if (!privateSrs || privateSrs.serverId !== tlsIdentity.serverId
      || privateSrs.srsDomain !== publicSrs.srsDomain
      || privateSrs.mailServiceIdentityRevision !== publicSrs.mailServiceIdentityRevision
      || privateSrs.srsSecretRevision !== publicSrs.srsSecretRevision
      || !privateSrs.secretArtifact || privateSrs.secretArtifact.path !== mailSrsTemplatePolicy.secretPath
      || !SHA256_PATTERN.test(privateSrs.secretArtifact.sha256 ?? '')
      || typeof privateSrs.secretContent !== 'string'
      || createHash('sha256').update(privateSrs.secretContent).digest('hex') !== privateSrs.secretArtifact.sha256) {
      throw new MailConfigurationError('mail_srs_configuration_inconsistent', 'Managed SRS state changed while preparing mail configuration', 409);
    }
    return Object.freeze({ public: publicSrs, private: privateSrs });
  }

  async function materializeConfiguration(resolved) {
    const domainSet = new Set(resolved.domains);
    const publicMailboxes = (await mailboxRegistry.listMailboxes())
      .filter((mailbox) => mailbox.enabled && domainSet.has(normalizeMailboxAddress(mailbox.address).domain))
      .sort((left, right) => left.address.localeCompare(right.address));
    const privateAccounts = (await mailboxRegistry.materializeEnabledAccounts())
      .filter((account) => domainSet.has(normalizeMailboxAddress(account.address).domain))
      .sort((left, right) => left.address.localeCompare(right.address));
    const aliases = (await mailAliasRegistry.materializeEnabledAliases())
      .filter((alias) => domainSet.has(normalizeMailboxAddress(alias.source).domain))
      .sort((left, right) => left.source.localeCompare(right.source));
    const quotaByMailboxId = new Map((await mailboxQuotaRegistry.listQuotas())
      .map((policy) => [policy.mailboxId, policy.quotaBytes]));
    const enabledMailboxById = new Map(publicMailboxes.map((mailbox) => [mailbox.id, mailbox]));
    const forwardings = (await mailboxForwardingRegistry.materializeEnabledForwardings())
      .filter((policy) => enabledMailboxById.has(policy.mailboxId))
      .map((policy) => {
        const owner = enabledMailboxById.get(policy.mailboxId);
        const source = normalizeMailboxAddress(policy.source).address;
        if (source !== owner.address) {
          throw new MailConfigurationError(
            'mail_configuration_forwarding_mismatch',
            'Mailbox forwarding state is inconsistent with enabled mailbox state',
            409,
          );
        }
        return Object.freeze({
          source,
          mode: policy.mode,
          destinations: Object.freeze([...policy.destinations]),
        });
      })
      .sort((left, right) => left.source.localeCompare(right.source));

    if (publicMailboxes.length !== privateAccounts.length
      || publicMailboxes.some((mailbox, index) => mailbox.address !== privateAccounts[index]?.address)) {
      throw new MailConfigurationError('mail_configuration_account_mismatch', 'Mailbox registry public and protected account state is inconsistent', 409);
    }

    if (resolved.domains.length === 0) {
      return Object.freeze({
        ready: true,
        blockers: Object.freeze([]),
        preview: enableManagedMailSubmission(
          secureManagedMailPreview(previewManagedMailEmptyConfiguration()),
          [],
        ),
        accounts: Object.freeze([]),
        srs: null,
      });
    }
    if (privateAccounts.length === 0) {
      return Object.freeze({
        ready: false,
        blockers: Object.freeze(['mail_postmaster_mailbox_required']),
        preview: null,
        accounts: Object.freeze([]),
        srs: null,
      });
    }

    const tlsIdentity = await resolveTlsIdentity(resolved);
    if (tlsIdentity.blocker) {
      return Object.freeze({
        ready: false,
        blockers: Object.freeze([tlsIdentity.blocker]),
        preview: null,
        accounts: Object.freeze([]),
        srs: null,
      });
    }
    const srs = await materializeSrs(resolved, forwardings, tlsIdentity);
    if (srs?.blocker || srs?.blockers) {
      return Object.freeze({
        ready: false,
        blockers: srs.blockers ?? Object.freeze([srs.blocker]),
        preview: null,
        accounts: Object.freeze([]),
        srs: null,
      });
    }

    const accounts = Object.freeze(privateAccounts.map((account, index) => Object.freeze({
      ...account,
      quotaBytes: quotaByMailboxId.get(publicMailboxes[index].id) ?? null,
    })));
    const postmasterAddress = accounts[0].address;
    let preview;
    try {
      preview = previewManagedMailSubmissionConfiguration({
        domains: resolved.domains,
        mailboxes: accounts.map((account) => account.address),
        aliases,
        accounts,
        postmasterAddress,
        forwardings,
      });
      if (srs?.private) {
        preview = enableManagedMailSrs(preview, {
          domains: resolved.domains,
          forwardings,
          srsDomain: srs.private.srsDomain,
          secretRevision: srs.private.srsSecretRevision,
          secretSha256: srs.private.secretArtifact.sha256,
        });
      }
      if (tlsIdentity.identity) preview = bindManagedMailTlsIdentity(preview, tlsIdentity.identity);
    } catch (error) {
      if (error instanceof MailTemplateError
        || error instanceof MailQuotaTemplateError
        || error instanceof MailForwardingTemplateError
        || error instanceof MailSecurityTemplateError
        || error instanceof MailSrsTemplateError
        || error instanceof MailSubmissionTemplateError
        || error instanceof MailTlsIdentityTemplateError) {
        throw new MailConfigurationError(
          'mail_configuration_state_invalid',
          'Managed mail identity state is inconsistent and cannot be applied',
          409,
        );
      }
      throw error;
    }
    return Object.freeze({
      ready: true,
      blockers: Object.freeze([]),
      preview,
      accounts,
      srs: srs?.private ?? null,
    });
  }

  async function previewTransition(input) {
    const resolved = await resolveTransition(input);
    const materialized = await materializeConfiguration(resolved);
    return transitionPreview(resolved, materialized);
  }

  async function materializeTransition(input, { expectedPreviewDigest, expectedConfigurationSha256 } = {}) {
    if (typeof expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(expectedPreviewDigest)
      || typeof expectedConfigurationSha256 !== 'string' || !SHA256_PATTERN.test(expectedConfigurationSha256)) {
      throw new MailConfigurationError('mail_configuration_identity_invalid', 'Current mail configuration digests are required', 409);
    }
    const resolved = await resolveTransition(input);
    const materialized = await materializeConfiguration(resolved);
    if (!materialized.ready || !materialized.preview) {
      throw new MailConfigurationError('mail_configuration_not_ready', 'Managed mail configuration is not ready to apply', 409);
    }
    const publicPreview = transitionPreview(resolved, materialized);
    if (publicPreview.previewDigest !== expectedPreviewDigest
      || materialized.preview.sha256 !== expectedConfigurationSha256
      || publicPreview.configuration?.sha256 !== expectedConfigurationSha256) {
      throw new MailConfigurationError('mail_configuration_preview_stale', 'Managed mail configuration changed after preview', 409);
    }
    const passwd = renderDovecotQuotaPasswdFile({
      domains: resolved.domains,
      accounts: materialized.accounts,
    });
    const passwdArtifact = materialized.preview.artifacts.find(
      (artifact) => artifact.path === mailTemplatePolicy.dovecotPasswdFilePath,
    );
    if (!passwdArtifact || passwdArtifact.sha256 !== createHash('sha256').update(passwd).digest('hex')) {
      throw new MailConfigurationError('mail_configuration_sensitive_digest_mismatch', 'Protected mail configuration material is inconsistent', 409);
    }
    const sensitiveArtifacts = [Object.freeze({
      path: mailTemplatePolicy.dovecotPasswdFilePath,
      content: passwd,
    })];
    if (materialized.srs) {
      const srsArtifact = materialized.preview.artifacts.find(
        (artifact) => artifact.path === mailSrsTemplatePolicy.secretPath,
      );
      if (!srsArtifact || srsArtifact.sha256 !== materialized.srs.secretArtifact.sha256
        || createHash('sha256').update(materialized.srs.secretContent).digest('hex') !== srsArtifact.sha256) {
        throw new MailConfigurationError('mail_configuration_sensitive_digest_mismatch', 'Protected SRS material is inconsistent', 409);
      }
      sensitiveArtifacts.push(Object.freeze({
        path: mailSrsTemplatePolicy.secretPath,
        content: materialized.srs.secretContent,
      }));
    }
    return Object.freeze({
      preview: materialized.preview,
      sensitiveArtifacts: Object.freeze(sensitiveArtifacts),
    });
  }

  return Object.freeze({
    previewTransition,
    materializeTransition,
  });
}

export const mailConfigurationInternals = Object.freeze({
  transitionInput,
  externalForwardingRequired,
  publicPostfixParameter,
  publicConfigurationPreview,
  transitionPreview,
});