import { createHash } from 'node:crypto';
import {
  MailQuotaTemplateError,
  MailTemplateError,
  mailTemplatePolicy,
  normalizeMailboxAddress,
  previewManagedMailEmptyConfiguration,
  previewManagedMailQuotaConfiguration,
  renderDovecotQuotaPasswdFile,
} from '@yunpanel/config-templates';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_STATUSES = new Set(['disabled', 'enabled']);
const EMPTY_QUOTA_REGISTRY = Object.freeze({ listQuotas: async () => [] });

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
    postfixParameters: preview.postfixParameters,
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
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.listMailboxes !== 'function'
    || typeof mailboxRegistry.materializeEnabledAccounts !== 'function'
    || !mailAliasRegistry || typeof mailAliasRegistry.materializeEnabledAliases !== 'function'
    || !mailboxQuotaRegistry || typeof mailboxQuotaRegistry.listQuotas !== 'function') {
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

    if (publicMailboxes.length !== privateAccounts.length
      || publicMailboxes.some((mailbox, index) => mailbox.address !== privateAccounts[index]?.address)) {
      throw new MailConfigurationError('mail_configuration_account_mismatch', 'Mailbox registry public and protected account state is inconsistent', 409);
    }

    if (resolved.domains.length === 0) {
      return Object.freeze({
        ready: true,
        blockers: Object.freeze([]),
        preview: previewManagedMailEmptyConfiguration(),
        accounts: Object.freeze([]),
      });
    }
    if (privateAccounts.length === 0) {
      return Object.freeze({
        ready: false,
        blockers: Object.freeze(['mail_postmaster_mailbox_required']),
        preview: null,
        accounts: Object.freeze([]),
      });
    }

    const accounts = Object.freeze(privateAccounts.map((account, index) => Object.freeze({
      ...account,
      quotaBytes: quotaByMailboxId.get(publicMailboxes[index].id) ?? null,
    })));
    const postmasterAddress = accounts[0].address;
    let preview;
    try {
      preview = previewManagedMailQuotaConfiguration({
        domains: resolved.domains,
        mailboxes: accounts.map((account) => account.address),
        aliases,
        accounts,
        postmasterAddress,
      });
    } catch (error) {
      if (error instanceof MailTemplateError || error instanceof MailQuotaTemplateError) {
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
    const sensitiveArtifact = materialized.preview.artifacts.find(
      (artifact) => artifact.path === mailTemplatePolicy.dovecotPasswdFilePath,
    );
    if (!sensitiveArtifact || sensitiveArtifact.sha256 !== createHash('sha256').update(passwd).digest('hex')) {
      throw new MailConfigurationError('mail_configuration_sensitive_digest_mismatch', 'Protected mail configuration material is inconsistent', 409);
    }
    return Object.freeze({
      preview: materialized.preview,
      sensitiveArtifacts: Object.freeze([Object.freeze({
        path: mailTemplatePolicy.dovecotPasswdFilePath,
        content: passwd,
      })]),
    });
  }

  return Object.freeze({
    previewTransition,
    materializeTransition,
  });
}

export const mailConfigurationInternals = Object.freeze({
  transitionInput,
  publicConfigurationPreview,
  transitionPreview,
});
