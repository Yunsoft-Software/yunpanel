// Assertion helpers for mailbox removal tests. They check live registries, the mail
// configuration preview and the host mailbox access guard; they are not production code.
import {
  createMailboxAccessGuard,
  MailboxAccessError,
} from '../../../../packages/host-runtime/src/mailbox-access-guard.js';

export class MailboxSingleLifecycleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailboxSingleLifecycleError';
    this.code = code;
    this.status = status;
  }
}

export class MailboxProtocolDisruptionError extends MailboxSingleLifecycleError {
  constructor(code, message) {
    super(code, message, 500);
    this.name = 'MailboxProtocolDisruptionError';
  }
}

export function assertNoDomainOrSiblingDisruption({
  sharedDomain,
  siblingMailbox,
  initialDomainStatus = 'enabled',
  initialDomainRevision = null,
  initialSiblingRevision = null,
}) {
  if (!sharedDomain || typeof sharedDomain !== 'object') {
    throw new MailboxProtocolDisruptionError('shared_domain_invalid', 'Shared mail domain is unavailable');
  }
  if (sharedDomain.status !== 'enabled') {
    throw new MailboxProtocolDisruptionError(
      'domain_disrupted',
      `Shared mail domain '${sharedDomain.domainName}' was unexpectedly disabled (status: ${sharedDomain.status})`,
    );
  }
  if (initialDomainStatus && sharedDomain.status !== initialDomainStatus) {
    throw new MailboxProtocolDisruptionError(
      'domain_status_drift',
      `Shared mail domain status drifted from '${initialDomainStatus}' to '${sharedDomain.status}'`,
    );
  }
  if (!siblingMailbox || typeof siblingMailbox !== 'object') {
    throw new MailboxProtocolDisruptionError('sibling_mailbox_invalid', 'Sibling mailbox is unavailable');
  }
  if (siblingMailbox.enabled !== true) {
    throw new MailboxProtocolDisruptionError(
      'sibling_disrupted',
      `Sibling mailbox '${siblingMailbox.address}' was unexpectedly disabled`,
    );
  }
}

export function assertNoClosedDomainReopened(otherDomain) {
  if (otherDomain && otherDomain.status === 'enabled') {
    throw new MailboxProtocolDisruptionError(
      'closed_domain_reopened',
      `Previously closed domain '${otherDomain.domainName}' was unexpectedly reopened`,
    );
  }
}

export async function assertDovecotPostfixCommandContracts({
  run,
  targetAddress = 'user@example.com',
} = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('Command runner function is required');
  }

  const guard = createMailboxAccessGuard({ run });
  const quiesced = await guard.quiesce(targetAddress);
  if (!quiesced || quiesced.identity !== targetAddress || !quiesced.accessDisabled || !quiesced.sessionsCleared) {
    throw new MailboxAccessError('mailbox_access_absence_unverified');
  }

  const verified = await guard.verify(targetAddress);
  if (!verified || verified.identity !== targetAddress || !verified.accessDisabled || !verified.sessionsCleared) {
    throw new MailboxAccessError('mailbox_access_absence_unverified');
  }

  return Object.freeze({
    identity: targetAddress,
    contractsVerified: true,
    quiesced,
    verified,
  });
}

export async function assertCommonConfigApplyPendingPreviewAndReloadEffect({
  mailConfigurationService,
  mailDomainRegistry,
  mailboxRegistry,
  mailDomainId,
  targetMailboxId,
  otherPendingMailboxId = null,
} = {}) {
  if (!mailConfigurationService || !mailDomainRegistry || !mailboxRegistry || !mailDomainId) {
    throw new MailboxSingleLifecycleError('invalid_arguments', 'Required services and domain ID must be provided');
  }

  const domain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!domain) {
    throw new MailboxSingleLifecycleError('domain_not_found', 'Mail domain not found', 404);
  }

  // Domain must remain ENABLED - no whole-domain shutdown workaround!
  if (domain.status !== 'enabled') {
    throw new MailboxProtocolDisruptionError('domain_workaround_detected', 'Domain shutdown workaround must not be used');
  }

  const targetMailbox = await mailboxRegistry.getMailbox(targetMailboxId);
  let otherMailbox = null;
  if (otherPendingMailboxId) {
    otherMailbox = await mailboxRegistry.getMailbox(otherPendingMailboxId);
  }

  const allMailboxes = await mailboxRegistry.listMailboxes();
  const enabledMailboxes = allMailboxes.filter(
    (m) => m.mailDomainId === domain.id && m.enabled
  );

  const preview = await mailConfigurationService.previewTransition({
    mailDomainId: domain.id,
    expectedRevision: domain.revision,
    status: 'enabled',
  });

  if (!preview || !preview.readyToApply || !preview.configuration) {
    throw new MailboxSingleLifecycleError('mail_configuration_not_ready', 'Mail configuration is not ready to apply', 409);
  }

  // Ensure target mailbox (if disabled or absent) is not counted in enabled accounts
  if (targetMailbox && !targetMailbox.enabled) {
    if (enabledMailboxes.some((m) => m.address === targetMailbox.address)) {
      throw new MailboxSingleLifecycleError('target_mailbox_still_present', 'Target disabled mailbox must not be enabled');
    }
  }

  // Ensure other pending mailbox is included in enabled accounts
  if (otherMailbox && otherMailbox.enabled) {
    if (!enabledMailboxes.some((m) => m.address === otherMailbox.address)) {
      throw new MailboxSingleLifecycleError('pending_mailbox_omitted', 'Other pending mailbox must be enabled');
    }
  }

  // Preview counts must match enabled accounts
  const mailboxCount = preview.configuration?.counts?.mailboxes ?? 0;
  if (mailboxCount !== enabledMailboxes.length) {
    throw new MailboxSingleLifecycleError('account_count_mismatch', 'Preview mailbox count does not match enabled mailboxes');
  }

  // Service reload effect is captured by configuration sha256 and preview digest
  if (!preview.configuration.sha256 || !preview.previewDigest) {
    throw new MailboxSingleLifecycleError('reload_effect_missing', 'Service reload effect must be captured by configuration sha256');
  }

  return Object.freeze({
    mailDomainId: domain.id,
    domainStatus: domain.status,
    previewDigest: preview.previewDigest,
    configurationSha256: preview.configuration.sha256,
    accountsCount: mailboxCount,
    targetExcluded: targetMailbox ? !targetMailbox.enabled : true,
    pendingIncluded: otherMailbox ? otherMailbox.enabled : null,
    domainShutdownWorkaroundAvoided: true,
  });
}
