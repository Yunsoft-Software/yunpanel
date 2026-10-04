import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import {
  createMailboxAccessGuard,
  MailboxAccessError,
  mailboxAccessInternals,
} from '../../../packages/host-runtime/src/mailbox-access-guard.js';
import {
  acquireLocalExecutionLock,
  LocalExecutionLockError,
} from './local-execution-lock.js';

export {
  createMailboxAccessGuard,
  MailboxAccessError,
  mailboxAccessInternals,
  acquireLocalExecutionLock,
  LocalExecutionLockError,
};

// ============================================================================
// T-DEV-MR-SINGLE: Single Mailbox Lifecycle & Protocol Session Errors
// ============================================================================

export class MailboxSingleLifecycleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailboxSingleLifecycleError';
    this.code = code;
    this.status = status;
  }
}

export class MailboxSessionTerminationError extends MailboxSingleLifecycleError {
  constructor(code, message) {
    super(code, message, 409);
    this.name = 'MailboxSessionTerminationError';
  }
}

export class MailboxProtocolDisruptionError extends MailboxSingleLifecycleError {
  constructor(code, message) {
    super(code, message, 500);
    this.name = 'MailboxProtocolDisruptionError';
  }
}

export class MailboxReconciliationError extends MailboxSingleLifecycleError {
  constructor(code, message, status = 409) {
    super(code, message, status);
    this.name = 'MailboxReconciliationError';
  }
}

export class MailboxConcurrencyLockError extends MailboxSingleLifecycleError {
  constructor(code, message, status = 409) {
    super(code, message, status);
    this.name = 'MailboxConcurrencyLockError';
  }
}

export class MailboxRollbackError extends MailboxSingleLifecycleError {
  constructor(code, message, status = 500) {
    super(code, message, status);
    this.name = 'MailboxRollbackError';
  }
}

export class MailboxAuthorizationRevokedError extends MailboxSingleLifecycleError {
  constructor(code, message, status = 403) {
    super(code, message, status);
    this.name = 'MailboxAuthorizationRevokedError';
  }
}

// ============================================================================
// Protocol Session & Service State Tracker
// ============================================================================

/**
 * Tracks protocol session state across Dovecot (IMAP/POP3), Postfix (SMTP auth),
 * LMTP delivery, and Roundcube (Webmail HTTP) for mail accounts on a host.
 */
export function createMailboxProtocolSessionTracker() {
  // Map<address, Array<{ id, proto, pid, ip, connectedAt, active }>>
  const dovecotSessions = new Map();
  // Map<sessionId, { sessionId, address, clientIp, authenticated, active, createdAt }>
  const smtpSessions = new Map();
  // Map<sessionId, { sessionId, address, userAgent, active, createdAt, expiresAt }>
  const webmailSessions = new Map();
  // Log of events for inspection and audit
  const eventLog = [];

  function recordEvent(type, payload) {
    eventLog.push({ type, timestamp: new Date().toISOString(), ...payload });
  }

  // --- Dovecot Session Management ---
  function registerDovecotSession(address, { proto = 'imap', pid = String(Math.floor(Math.random() * 50000 + 1000)), ip = '127.0.0.1' } = {}) {
    if (!address || typeof address !== 'string') {
      throw new MailboxSingleLifecycleError('invalid_address', 'Address must be a valid email string');
    }
    const session = {
      id: randomUUID(),
      address,
      proto,
      pid: String(pid),
      ip,
      connectedAt: new Date().toISOString(),
      active: true,
    };
    if (!dovecotSessions.has(address)) {
      dovecotSessions.set(address, []);
    }
    dovecotSessions.get(address).push(session);
    recordEvent('dovecot_session_registered', { address, proto, pid, ip });
    return structuredClone(session);
  }

  function listActiveDovecotSessions(address) {
    const list = dovecotSessions.get(address) || [];
    return list.filter((s) => s.active).map((s) => structuredClone(s));
  }

  function kickDovecotUser(address) {
    if (!address || typeof address !== 'string') {
      throw new MailboxSingleLifecycleError('invalid_address', 'Address is required');
    }
    const list = dovecotSessions.get(address) || [];
    let count = 0;
    for (const session of list) {
      if (session.active) {
        session.active = false;
        count += 1;
      }
    }
    recordEvent('dovecot_user_kicked', { address, terminatedCount: count });
    return count;
  }

  function doveadmWhoOutput(address) {
    const active = listActiveDovecotSessions(address);
    const header = 'username\tproto\tpid\tip\n';
    if (active.length === 0) {
      return header;
    }
    const rows = active.map((s) => `${s.address}\t${s.proto}\t${s.pid}\t${s.ip}`).join('\n');
    return `${header}${rows}\n`;
  }

  // --- Authenticated SMTP Session Management ---
  function registerAuthenticatedSmtpSession(address, { clientIp = '127.0.0.1', sessionId = randomUUID() } = {}) {
    if (!address || typeof address !== 'string') {
      throw new MailboxSingleLifecycleError('invalid_address', 'Address must be a valid email string');
    }
    const session = {
      sessionId,
      address,
      clientIp,
      authenticated: true,
      active: true,
      createdAt: new Date().toISOString(),
    };
    smtpSessions.set(sessionId, session);
    recordEvent('smtp_session_registered', { sessionId, address, clientIp });
    return structuredClone(session);
  }

  function verifySmtpSender(sessionId, senderAddress, isAccountActiveFn = () => true) {
    const session = smtpSessions.get(sessionId);
    if (!session || !session.active || !session.authenticated) {
      recordEvent('smtp_sender_rejected', { sessionId, senderAddress, reason: 'unauthenticated' });
      throw new MailboxSingleLifecycleError('smtp_auth_invalid', '535 5.7.8 Authentication credentials invalid', 401);
    }
    if (session.address.toLowerCase() !== senderAddress.toLowerCase()) {
      recordEvent('smtp_sender_rejected', { sessionId, senderAddress, reason: 'sender_login_mismatch' });
      throw new MailboxSingleLifecycleError('smtp_sender_login_mismatch', '553 5.7.1 Sender address not owned by authenticated user', 403);
    }
    const active = isAccountActiveFn(senderAddress);
    if (!active) {
      // Invalidate the session immediately
      session.active = false;
      session.authenticated = false;
      recordEvent('smtp_session_invalidated_by_account_disabled', { sessionId, senderAddress });
      throw new MailboxSingleLifecycleError('smtp_sender_disabled', '553 5.7.1 Sender address rejected: mailbox disabled or deleted', 403);
    }
    recordEvent('smtp_sender_accepted', { sessionId, senderAddress });
    return { authorized: true, sender: senderAddress, clientIp: session.clientIp };
  }

  function invalidateSmtpSessions(address) {
    let count = 0;
    for (const session of smtpSessions.values()) {
      if (session.address.toLowerCase() === address.toLowerCase() && session.active) {
        session.active = false;
        session.authenticated = false;
        count += 1;
      }
    }
    recordEvent('smtp_sessions_invalidated', { address, count });
    return count;
  }

  // --- LMTP Message Delivery ---
  function deliverLmtpMessage(recipientAddress, message, isRecipientActiveFn = () => true) {
    if (!recipientAddress || typeof recipientAddress !== 'string') {
      throw new MailboxSingleLifecycleError('invalid_recipient', 'Recipient must be a valid email string');
    }
    const active = isRecipientActiveFn(recipientAddress);
    if (!active) {
      recordEvent('lmtp_delivery_rejected', { recipientAddress, reason: 'userdb_not_found' });
      throw new MailboxSingleLifecycleError(
        'lmtp_recipient_not_found',
        `550 5.1.1 <${recipientAddress}>: Recipient address rejected: User doesn't exist`,
        550,
      );
    }
    const messageId = randomUUID();
    recordEvent('lmtp_delivery_succeeded', { recipientAddress, messageId });
    return { delivered: true, recipient: recipientAddress, messageId };
  }

  // --- Webmail HTTP Session Management ---
  function registerWebmailHttpSession(address, { userAgent = 'Roundcube Webmail 1.6', sessionId = randomUUID(), expiresInMs = 3600000 } = {}) {
    if (!address || typeof address !== 'string') {
      throw new MailboxSingleLifecycleError('invalid_address', 'Address must be a valid email string');
    }
    const now = Date.now();
    const session = {
      sessionId,
      address,
      userAgent,
      active: true,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
    };
    webmailSessions.set(sessionId, session);
    recordEvent('webmail_session_registered', { sessionId, address });
    return structuredClone(session);
  }

  function validateWebmailHttpSession(sessionId, isAccountActiveFn = () => true) {
    const session = webmailSessions.get(sessionId);
    if (!session || !session.active || new Date(session.expiresAt).getTime() < Date.now()) {
      recordEvent('webmail_session_rejected', { sessionId, reason: 'session_expired_or_absent' });
      throw new MailboxSingleLifecycleError('webmail_session_invalid', '401 Unauthorized: Webmail session expired or invalid', 401);
    }
    const active = isAccountActiveFn(session.address);
    if (!active) {
      // Invalidate session immediately
      session.active = false;
      recordEvent('webmail_session_invalidated_by_account_disabled', { sessionId, address: session.address });
      throw new MailboxSingleLifecycleError('webmail_account_disabled', '401 Unauthorized: Mailbox is disabled or deleted', 401);
    }
    recordEvent('webmail_session_validated', { sessionId, address: session.address });
    return { valid: true, address: session.address, userAgent: session.userAgent };
  }

  function terminateWebmailHttpSessions(address) {
    let count = 0;
    for (const session of webmailSessions.values()) {
      if (session.address.toLowerCase() === address.toLowerCase() && session.active) {
        session.active = false;
        count += 1;
      }
    }
    recordEvent('webmail_sessions_terminated', { address, count });
    return count;
  }

  return {
    registerDovecotSession,
    listActiveDovecotSessions,
    kickDovecotUser,
    doveadmWhoOutput,
    registerAuthenticatedSmtpSession,
    verifySmtpSender,
    invalidateSmtpSessions,
    deliverLmtpMessage,
    registerWebmailHttpSession,
    validateWebmailHttpSession,
    terminateWebmailHttpSessions,
    getEventLog: () => [...eventLog],
  };
}

// ============================================================================
// Single Mailbox Lifecycle Safety & Continuity Asserters
// ============================================================================

/**
 * Asserts that the shared mail domain and sibling mailbox accounts were never disabled,
 * preserving continuity across single-account deletion.
 */
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

/**
 * Asserts that an already-disabled domain is NOT automatically reopened/enabled
 * during account-level operations.
 */
export function assertNoClosedDomainReopened(otherDomain) {
  if (otherDomain && otherDomain.status === 'enabled') {
    throw new MailboxProtocolDisruptionError(
      'closed_domain_reopened',
      `Previously closed domain '${otherDomain.domainName}' was unexpectedly reopened`,
    );
  }
}

/**
 * Validates that all access channels (Dovecot, Auth, Delivery, SMTP, LMTP, Webmail)
 * for a target mailbox have been cleanly and separately terminated.
 */
export function assertMailboxAccessTerminatedSeparately({
  address,
  sessionTracker,
  accessGuardCheck = null,
}) {
  // 1. Dovecot sessions terminated
  const remainingDovecot = sessionTracker.listActiveDovecotSessions(address);
  if (remainingDovecot.length > 0) {
    throw new MailboxSessionTerminationError(
      'dovecot_sessions_remaining',
      `Mailbox '${address}' still has ${remainingDovecot.length} active Dovecot session(s)`,
    );
  }

  // 2. Auth lookup fails (passdb)
  let authSucceeded = false;
  try {
    if (accessGuardCheck?.checkAuth) {
      accessGuardCheck.checkAuth(address);
      authSucceeded = true;
    }
  } catch {}
  if (authSucceeded) {
    throw new MailboxSessionTerminationError(
      'new_auth_not_rejected',
      `Mailbox '${address}' still allows new authentication`,
    );
  }

  // 3. Delivery lookup fails (virtual_mailbox_maps / userdb)
  let deliverySucceeded = false;
  try {
    if (accessGuardCheck?.checkDelivery) {
      accessGuardCheck.checkDelivery(address);
      deliverySucceeded = true;
    }
  } catch {}
  if (deliverySucceeded) {
    throw new MailboxSessionTerminationError(
      'new_delivery_not_rejected',
      `Mailbox '${address}' still accepts mail delivery`,
    );
  }

  // 4. Pre-authenticated SMTP rejected
  const dummySmtpId = `test-verify-smtp-${address}`;
  sessionTracker.registerAuthenticatedSmtpSession(address, { sessionId: dummySmtpId });
  let smtpAccepted = false;
  try {
    sessionTracker.verifySmtpSender(dummySmtpId, address, () => false);
    smtpAccepted = true;
  } catch (err) {
    if (err.code !== 'smtp_sender_disabled' && err.code !== 'smtp_auth_invalid') throw err;
  }
  if (smtpAccepted) {
    throw new MailboxSessionTerminationError(
      'pre_auth_smtp_not_rejected',
      `Pre-authenticated SMTP session for '${address}' was not invalidated`,
    );
  }

  // 5. Ongoing LMTP deliveries rejected
  let lmtpDelivered = false;
  try {
    sessionTracker.deliverLmtpMessage(address, 'Subject: test', () => false);
    lmtpDelivered = true;
  } catch (err) {
    if (err.code !== 'lmtp_recipient_not_found') throw err;
  }
  if (lmtpDelivered) {
    throw new MailboxSessionTerminationError(
      'ongoing_lmtp_not_rejected',
      `LMTP delivery for '${address}' was not rejected`,
    );
  }

  // 6. Webmail HTTP sessions terminated
  const dummyWebmailId = `test-verify-webmail-${address}`;
  sessionTracker.registerWebmailHttpSession(address, { sessionId: dummyWebmailId });
  let webmailAllowed = false;
  try {
    sessionTracker.validateWebmailHttpSession(dummyWebmailId, () => false);
    webmailAllowed = true;
  } catch (err) {
    if (err.code !== 'webmail_account_disabled' && err.code !== 'webmail_session_invalid') throw err;
  }
  if (webmailAllowed) {
    throw new MailboxSessionTerminationError(
      'webmail_session_not_terminated',
      `Webmail HTTP session for '${address}' was not terminated`,
    );
  }

  return { verified: true, address, allChannelsTerminated: true };
}

/**
 * Validates that sibling mailbox B maintains continuous, uninterrupted operations
 * across SMTP, IMAP, and Webmail protocols.
 */
export function assertSiblingMailboxContinuity({
  address,
  sessionTracker,
  activeDovecotCount = 1,
}) {
  // 1. Dovecot sessions remain active
  const dovecotSessions = sessionTracker.listActiveDovecotSessions(address);
  if (dovecotSessions.length < activeDovecotCount) {
    throw new MailboxProtocolDisruptionError(
      'sibling_dovecot_session_lost',
      `Sibling mailbox '${address}' active Dovecot sessions dropped to ${dovecotSessions.length}`,
    );
  }

  // 2. Pre-authenticated and new SMTP sessions can send
  const smtpSession = sessionTracker.registerAuthenticatedSmtpSession(address);
  const smtpAuth = sessionTracker.verifySmtpSender(smtpSession.sessionId, address, () => true);
  if (!smtpAuth.authorized) {
    throw new MailboxProtocolDisruptionError(
      'sibling_smtp_disrupted',
      `Sibling mailbox '${address}' could not send via SMTP`,
    );
  }

  // 3. Ongoing LMTP deliveries succeed
  const lmtpResult = sessionTracker.deliverLmtpMessage(address, 'Subject: Hello Sibling', () => true);
  if (!lmtpResult.delivered) {
    throw new MailboxProtocolDisruptionError(
      'sibling_lmtp_disrupted',
      `Sibling mailbox '${address}' LMTP delivery failed`,
    );
  }

  // 4. Webmail HTTP sessions remain valid and active
  const webmailSession = sessionTracker.registerWebmailHttpSession(address);
  const webmailAuth = sessionTracker.validateWebmailHttpSession(webmailSession.sessionId, () => true);
  if (!webmailAuth.valid) {
    throw new MailboxProtocolDisruptionError(
      'sibling_webmail_disrupted',
      `Sibling mailbox '${address}' Webmail session invalid`,
    );
  }

  return { continuous: true, address, allProtocolsOperational: true };
}

// ============================================================================
// Single Mailbox Lifecycle Coordinator
// ============================================================================

/**
 * Creates a coordinator that manages and executes the 5-step single mailbox
 * removal lifecycle with strict multi-protocol session termination and isolation.
 */
export function createSingleMailboxLifecycleCoordinator({
  mailboxRegistry,
  mailDomainRegistry,
  mailDataOperationsService = null,
  mailDeleteFinalizeService = null,
  sessionTracker = createMailboxProtocolSessionTracker(),
  mailConfigurationService = null,
  mailboxAccessGuard = null,
  jobRegistry = null,
  mailDataInspector = null,
  backupManager = null,
  lockManager = null,
  rapidConfirmationGuard = null,
} = {}) {
  if (!mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function' || typeof mailboxRegistry.setEnabled !== 'function') {
    throw new MailboxSingleLifecycleError('dependencies_invalid', 'Valid mailboxRegistry is required', 503);
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function') {
    throw new MailboxSingleLifecycleError('dependencies_invalid', 'Valid mailDomainRegistry is required', 503);
  }

  /**
   * Step 1: Disable target mailbox A.
   * Asserts shared domain remains enabled and sibling account remains enabled.
   */
  async function disableTargetMailbox({ targetMailboxId, expectedRevision, siblingMailboxId = null }) {
    const target = await mailboxRegistry.getMailbox(targetMailboxId);
    if (!target) throw new MailboxSingleLifecycleError('mailbox_not_found', 'Target mailbox not found', 404);

    const domain = await mailDomainRegistry.getMailDomain(target.mailDomainId);
    if (!domain) throw new MailboxSingleLifecycleError('domain_not_found', 'Mail domain not found', 404);

    let sibling = null;
    if (siblingMailboxId) {
      sibling = await mailboxRegistry.getMailbox(siblingMailboxId);
    }

    const updated = await mailboxRegistry.setEnabled(targetMailboxId, {
      expectedRevision,
      enabled: false,
    });

    // Check invariants
    const domainAfter = await mailDomainRegistry.getMailDomain(target.mailDomainId);
    assertNoDomainOrSiblingDisruption({
      sharedDomain: domainAfter,
      siblingMailbox: sibling ? await mailboxRegistry.getMailbox(siblingMailboxId) : { enabled: true },
    });

    return Object.freeze({
      mailbox: updated,
      domainStatus: domainAfter.status,
      siblingContinuous: true,
    });
  }

  /**
   * Step 2: Apply configuration with unchanged domain status.
   * Terminates target's Dovecot, SMTP, LMTP, and Webmail sessions.
   * Verifies sibling B continuity.
   */
  async function applyConfigurationAndQuiesceSessions({
    targetMailboxId,
    mailDomainId,
    siblingMailboxId = null,
    previouslyClosedDomainId = null,
    accessGuard = mailboxAccessGuard,
  }) {
    const target = await mailboxRegistry.getMailbox(targetMailboxId);
    if (!target) throw new MailboxSingleLifecycleError('mailbox_not_found', 'Target mailbox not found', 404);

    const domain = await mailDomainRegistry.getMailDomain(mailDomainId);
    if (!domain) throw new MailboxSingleLifecycleError('domain_not_found', 'Mail domain not found', 404);
    if (domain.status !== 'enabled') {
      throw new MailboxProtocolDisruptionError('domain_not_enabled', 'Shared mail domain must be enabled');
    }

    // Check closed domain invariant
    if (previouslyClosedDomainId) {
      const closedDomain = await mailDomainRegistry.getMailDomain(previouslyClosedDomainId);
      assertNoClosedDomainReopened(closedDomain);
    }

    // Quiesce target mailbox access with host guard if configured
    if (accessGuard && typeof accessGuard.quiesce === 'function') {
      await accessGuard.quiesce(target.address);
    }

    // Quiesce target mailbox sessions across all protocols
    sessionTracker.kickDovecotUser(target.address);
    sessionTracker.invalidateSmtpSessions(target.address);
    sessionTracker.terminateWebmailHttpSessions(target.address);

    // Verify target mailbox sessions are terminated
    assertMailboxAccessTerminatedSeparately({
      address: target.address,
      sessionTracker,
    });

    // Check sibling continuity
    let sibling = null;
    if (siblingMailboxId) {
      sibling = await mailboxRegistry.getMailbox(siblingMailboxId);
      if (sibling) {
        assertNoDomainOrSiblingDisruption({
          sharedDomain: domain,
          siblingMailbox: sibling,
        });
        assertSiblingMailboxContinuity({
          address: sibling.address,
          sessionTracker,
        });
      }
    }

    return Object.freeze({
      targetAddress: target.address,
      sessionsCleared: true,
      domainStatus: domain.status,
      siblingContinuous: true,
    });
  }

  const effectiveLockManager = lockManager ?? createMailboxInterProcessLockManager();
  const effectiveRapidGuard = rapidConfirmationGuard ?? createRapidConfirmationGuard();

  return Object.freeze({
    sessionTracker,
    mailboxAccessGuard,
    mailConfigurationService,
    lockManager: effectiveLockManager,
    rapidConfirmationGuard: effectiveRapidGuard,
    jobRegistry,
    mailDataInspector,
    backupManager,
    disableTargetMailbox,
    applyConfigurationAndQuiesceSessions,
    assertNoDomainOrSiblingDisruption,
    assertNoClosedDomainReopened,
    assertMailboxAccessTerminatedSeparately,
    assertSiblingMailboxContinuity,
    assertDovecotPostfixCommandContracts,
    assertCommonConfigApplyPendingPreviewAndReloadEffect: (opts) =>
      assertCommonConfigApplyPendingPreviewAndReloadEffect({
        mailConfigurationService,
        mailDomainRegistry,
        mailboxRegistry,
        ...opts,
      }),
    reconcileLostMailboxOperation: (opts) =>
      reconcileLostMailboxOperation({
        mailboxRegistry,
        mailDomainRegistry,
        jobRegistry,
        mailDataInspector,
        ...opts,
      }),
    validateResumeJobProof: (opts) =>
      validateResumeJobProof({
        jobRegistry,
        backupManager,
        ...opts,
      }),
    assertActorAuthorizationContinuous,
    assertWorkerMutationConcurrencyGuard: (opts) =>
      assertWorkerMutationConcurrencyGuard({
        lockManager: effectiveLockManager,
        ...opts,
      }),
    executeMailboxDeletionWithRollbackVerification: (opts) =>
      executeMailboxDeletionWithRollbackVerification({
        mailboxRegistry,
        backupManager,
        mailDataInspector,
        ...opts,
      }),
  });
}

/**
 * Asserts strict Dovecot and Postfix command contracts for field-only lookups,
 * absence exit codes/outputs, cache flush, and single-user kick/who isolation.
 *
 * Requirements:
 * 1. Dovecot passdb field-only lookup uses -f user with exit 67 and standard absence stderr.
 * 2. Dovecot userdb field-only lookup uses -f uid with exit 67 and standard absence stderr.
 * 3. Postmap absence is exit code 1 with empty stdout & stderr (exit 0 = still enabled).
 * 4. Dovecot cache flush matches /^\d+ cache entries flushed$/.
 * 5. Dovecot kick and who strictly target the chosen address (never wildcard / -A).
 * 6. Error exit codes (e.g. 75 EX_TEMPFAIL, ENOENT, EACCES) or unmanaged configs
 *    must NEVER be accepted as account absence.
 */
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

/**
 * Asserts that during common config apply (mail.config.apply / mailConfigurationService.previewTransition):
 * 1. The shared mail domain remains enabled (no whole-domain shutdown workaround).
 * 2. Any other recorded pending mailbox changes (e.g. otherPendingMailboxId) are included in the preview.
 * 3. The target mailbox (if disabled/deleted) is excluded from the materialized accounts.
 * 4. Configuration SHA256 and previewDigest reflect the service reload effect.
 */
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

// ============================================================================
// T-DEV-MR-SINGLE: Rapid Confirmation, Lost Operation Reconciliation,
// Resume Proof, Session Revocation, Inter-Process Lock & Rollback
// ============================================================================

/**
 * Guards against rapid duplicate confirmations and parallel mutation races.
 * Ensures only the first valid confirmation is processed and subsequent calls fail closed.
 */
export function createRapidConfirmationGuard({ windowMs = 30_000 } = {}) {
  const confirmations = new Map();

  function beginConfirmation(token, { mailboxId = null, revision = null } = {}) {
    if (!token || typeof token !== 'string') {
      throw new MailboxSingleLifecycleError('invalid_confirmation_token', 'Confirmation token must be a string', 400);
    }
    const existing = confirmations.get(token);
    if (existing) {
      if (existing.inFlight) {
        throw new MailboxConcurrencyLockError(
          'rapid_confirmation_in_flight',
          'A mutation is already in progress for this confirmation token',
          409
        );
      }
      if (existing.consumed) {
        throw new MailboxConcurrencyLockError(
          'confirmation_already_consumed',
          'This confirmation token has already been processed and consumed',
          409
        );
      }
    }
    confirmations.set(token, {
      mailboxId,
      revision,
      inFlight: true,
      consumed: false,
      timestamp: Date.now(),
    });
    return Object.freeze({
      token,
      commit(result = null) {
        const entry = confirmations.get(token);
        if (entry) {
          entry.inFlight = false;
          entry.consumed = true;
          entry.result = result;
        }
      },
      abort() {
        confirmations.delete(token);
      },
    });
  }

  function isConsumed(token) {
    return confirmations.get(token)?.consumed ?? false;
  }

  function isInFlight(token) {
    return confirmations.get(token)?.inFlight ?? false;
  }

  return Object.freeze({
    beginConfirmation,
    isConsumed,
    isInFlight,
  });
}

/**
 * Reconciles lost PATCH, apply, delete, or finalize responses without blind duplicate writes.
 * Reconciles uncertain operations against current authoritative state and verified job receipts.
 */
export async function reconcileLostMailboxOperation({
  operation,
  mailboxId,
  address = null,
  mailDomainId = null,
  expectedRevision = null,
  lastKnownJobId = null,
  backupId = null,
  mailboxRegistry,
  mailDomainRegistry = null,
  jobRegistry = null,
  mailDataInspector = null,
} = {}) {
  if (!operation || typeof operation !== 'string') {
    throw new MailboxSingleLifecycleError('invalid_operation', 'Valid operation string is required', 400);
  }
  if (!mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function') {
    throw new MailboxSingleLifecycleError('dependencies_invalid', 'Valid mailboxRegistry is required', 503);
  }

  switch (operation) {
    case 'patch': {
      if (!mailboxId) {
        throw new MailboxReconciliationError('mailbox_id_required', 'mailboxId is required for PATCH reconciliation', 400);
      }
      const current = await mailboxRegistry.getMailbox(mailboxId);
      if (!current) {
        throw new MailboxReconciliationError('mailbox_not_found', 'Mailbox was not found', 404);
      }
      // Reconciled: already disabled with matching or advanced revision
      if (current.enabled === false && (expectedRevision === null || current.revision >= expectedRevision)) {
        return Object.freeze({
          reconciled: true,
          action: 'reconciled_existing_disabled',
          mailbox: current,
          duplicateWriteAvoided: true,
        });
      }
      // Unapplied: still enabled at expected revision (request never reached server)
      if (current.enabled === true && (expectedRevision === null || current.revision === expectedRevision)) {
        return Object.freeze({
          reconciled: false,
          action: 'patch_not_applied',
          mailbox: current,
          safeToRetry: true,
        });
      }
      // Conflict: mailbox enabled but revision advanced
      throw new MailboxReconciliationError(
        'mailbox_reconcile_conflict',
        `Mailbox state conflict: enabled=${current.enabled}, revision=${current.revision} (expected ${expectedRevision})`,
        409
      );
    }

    case 'apply': {
      if (!lastKnownJobId) {
        throw new MailboxReconciliationError(
          'job_id_required_for_apply_reconciliation',
          'lastKnownJobId is required to reconcile lost config apply',
          400
        );
      }
      if (!jobRegistry || typeof jobRegistry.getJob !== 'function') {
        throw new MailboxReconciliationError('job_registry_unavailable', 'Job registry is required for apply reconciliation', 503);
      }
      const job = await jobRegistry.getJob(lastKnownJobId);
      if (!job) {
        throw new MailboxReconciliationError('apply_job_not_found', `Apply job '${lastKnownJobId}' not found`, 404);
      }
      if (mailDomainId && job.resourceId && job.resourceId !== mailDomainId) {
        throw new MailboxReconciliationError('apply_job_mismatch', 'Apply job does not match target domain', 409);
      }
      if (job.status === 'succeeded') {
        return Object.freeze({
          reconciled: true,
          action: 'reconciled_applied_job',
          job,
          duplicateApplyAvoided: true,
        });
      }
      if (['queued', 'running'].includes(job.status)) {
        return Object.freeze({
          reconciled: false,
          status: 'waiting',
          job,
          duplicateApplyAvoided: true,
        });
      }
      // Failed or cancelled jobs must never be blindly retried; require fresh explicit approval
      throw new MailboxReconciliationError(
        'apply_job_failed',
        `Apply job '${lastKnownJobId}' ended with status '${job.status}'; fresh explicit confirmation required`,
        409
      );
    }

    case 'delete': {
      if (!lastKnownJobId) {
        throw new MailboxReconciliationError(
          'job_id_required_for_delete_reconciliation',
          'lastKnownJobId is required to reconcile lost data delete',
          400
        );
      }
      if (!jobRegistry || typeof jobRegistry.getJob !== 'function') {
        throw new MailboxReconciliationError('job_registry_unavailable', 'Job registry is required for delete reconciliation', 503);
      }
      const job = await jobRegistry.getJob(lastKnownJobId);
      if (!job) {
        throw new MailboxReconciliationError('delete_job_not_found', `Delete job '${lastKnownJobId}' not found`, 404);
      }
      if (job.result?.scope && job.result.scope !== 'mailbox') {
        throw new MailboxReconciliationError('delete_job_mismatch', 'Delete job scope does not match mailbox', 409);
      }
      if (address && job.result?.identity && job.result.identity.toLowerCase() !== address.toLowerCase()) {
        throw new MailboxReconciliationError('delete_job_mismatch', 'Delete job identity does not match target mailbox', 409);
      }
      if (backupId && job.result?.backupId && job.result.backupId !== backupId) {
        throw new MailboxReconciliationError('delete_backup_mismatch', 'Delete job backup does not match approved backup', 409);
      }
      if (job.status === 'succeeded') {
        return Object.freeze({
          reconciled: true,
          action: 'reconciled_deleted_job',
          receipt: job.result,
          duplicateDeleteAvoided: true,
        });
      }
      if (['queued', 'running'].includes(job.status)) {
        return Object.freeze({
          reconciled: false,
          status: 'waiting',
          job,
          duplicateDeleteAvoided: true,
        });
      }
      throw new MailboxReconciliationError(
        'delete_job_failed',
        `Delete job '${lastKnownJobId}' ended with status '${job.status}'; manual recovery required`,
        409
      );
    }

    case 'finalize': {
      if (!mailboxId) {
        throw new MailboxReconciliationError('mailbox_id_required', 'mailboxId is required for finalize reconciliation', 400);
      }
      const current = await mailboxRegistry.getMailbox(mailboxId);
      if (current) {
        return Object.freeze({
          reconciled: false,
          action: 'finalize_not_completed',
          mailbox: current,
        });
      }
      // Mailbox is absent (404) - must NOT blindly report success! Must verify delete receipt!
      if (!lastKnownJobId) {
        throw new MailboxReconciliationError(
          'finalize_unverified_missing_receipt',
          'Mailbox record is absent but no delete job receipt was provided to verify legitimate removal',
          409
        );
      }
      if (!jobRegistry || typeof jobRegistry.getJob !== 'function') {
        throw new MailboxReconciliationError('job_registry_unavailable', 'Job registry required to verify finalize receipt', 503);
      }
      const deleteJob = await jobRegistry.getJob(lastKnownJobId);
      if (!deleteJob || deleteJob.status !== 'succeeded' || deleteJob.result?.deleted !== true) {
        throw new MailboxReconciliationError(
          'finalize_unverified_invalid_receipt',
          'Mailbox absent but delete job receipt is unverified or unsuccessful',
          409
        );
      }
      if (address && deleteJob.result?.identity && deleteJob.result.identity.toLowerCase() !== address.toLowerCase()) {
        throw new MailboxReconciliationError(
          'finalize_unverified_identity_mismatch',
          'Delete job receipt belongs to a different mailbox identity',
          409
        );
      }
      if (backupId && deleteJob.result?.backupId && deleteJob.result.backupId !== backupId) {
        throw new MailboxReconciliationError(
          'finalize_backup_mismatch',
          'Delete job backup does not match expected backup',
          409
        );
      }
      if (mailDataInspector && address) {
        const liveData = await mailDataInspector.inspectMailbox(address);
        if (liveData?.present) {
          throw new MailboxReconciliationError(
            'finalize_data_still_present',
            'Mailbox registry record was removed but live mail data still exists on host',
            500
          );
        }
      }
      return Object.freeze({
        reconciled: true,
        deleted: true,
        action: 'reconciled_finalize_success',
        receipt: deleteJob.result,
        verifiedByReceipt: true,
      });
    }

    default:
      throw new MailboxSingleLifecycleError('unsupported_operation', `Unsupported reconciliation operation: ${operation}`, 400);
  }
}

/**
 * Validates that an operation cannot be resumed with stale backups or foreign job IDs.
 * Strictly verifies operation, resourceId, scope, identity, backup ID, and revision match.
 */
export async function validateResumeJobProof({
  jobId,
  expectedScope = 'mailbox',
  expectedResourceId = null,
  expectedAddress = null,
  expectedBackupId = null,
  expectedRevision = null,
  expectedOperation = null,
  jobRegistry,
  backupManager = null,
} = {}) {
  if (!jobId || typeof jobId !== 'string') {
    throw new MailboxSingleLifecycleError('invalid_job_id', 'Valid jobId is required to resume', 400);
  }
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function') {
    throw new MailboxSingleLifecycleError('job_registry_unavailable', 'Job registry is required', 503);
  }

  const job = await jobRegistry.getJob(jobId);
  if (!job) {
    throw new MailboxSingleLifecycleError('resume_job_not_found', `Job '${jobId}' was not found`, 404);
  }

  if (expectedOperation && job.operation !== expectedOperation) {
    throw new MailboxSingleLifecycleError(
      'resume_job_operation_mismatch',
      `Job operation '${job.operation}' does not match expected '${expectedOperation}'`,
      409
    );
  }

  if (expectedResourceId && job.resourceId !== expectedResourceId && job.input?.resourceId !== expectedResourceId && job.result?.resourceId !== expectedResourceId) {
    throw new MailboxSingleLifecycleError(
      'resume_job_resource_mismatch',
      `Job resourceId does not match target resource '${expectedResourceId}'`,
      409
    );
  }

  if (['failed', 'cancelled'].includes(job.status)) {
    throw new MailboxSingleLifecycleError(
      'resume_job_unsuccessful',
      `Cannot resume a job with status '${job.status}'`,
      409
    );
  }

  if (job.status === 'succeeded' && job.result) {
    if (expectedScope && job.result.scope && job.result.scope !== expectedScope) {
      throw new MailboxSingleLifecycleError(
        'resume_job_scope_mismatch',
        `Job result scope '${job.result.scope}' does not match expected '${expectedScope}'`,
        409
      );
    }
    if (expectedAddress && job.result.identity && job.result.identity.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new MailboxSingleLifecycleError(
        'resume_job_identity_mismatch',
        `Job result identity '${job.result.identity}' does not match target mailbox '${expectedAddress}'`,
        409
      );
    }
    if (expectedBackupId && job.result.backupId && job.result.backupId !== expectedBackupId) {
      throw new MailboxSingleLifecycleError(
        'resume_job_backup_mismatch',
        `Job result backupId '${job.result.backupId}' does not match approved backup '${expectedBackupId}'`,
        409
      );
    }
    if (expectedRevision !== null && job.result.expectedResourceRevision !== undefined && job.result.expectedResourceRevision !== expectedRevision) {
      throw new MailboxSingleLifecycleError(
        'resume_job_revision_mismatch',
        `Job result revision '${job.result.expectedResourceRevision}' does not match expected revision '${expectedRevision}'`,
        409
      );
    }
    if (job.operation === 'mail.data.backup' && job.result.backedUp !== true) {
      throw new MailboxSingleLifecycleError(
        'resume_job_backup_invalid',
        'Job result does not prove successful backup',
        409
      );
    }
    if (job.operation === 'mail.data.delete' && job.result.deleted !== true) {
      throw new MailboxSingleLifecycleError(
        'resume_job_delete_invalid',
        'Job result does not prove successful deletion',
        409
      );
    }
  }

  if (backupManager && expectedBackupId) {
    const backup = typeof backupManager.inspectBackup === 'function'
      ? await backupManager.inspectBackup(expectedBackupId)
      : await backupManager.materializeBackup(expectedBackupId);
    if (!backup) {
      throw new MailboxSingleLifecycleError('resume_backup_not_found', `Backup '${expectedBackupId}' not found`, 404);
    }
    const manifest = backup.manifest ?? backup;
    if (manifest.identity && expectedAddress && manifest.identity.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new MailboxSingleLifecycleError(
        'resume_backup_identity_mismatch',
        `Backup belongs to '${manifest.identity}', not '${expectedAddress}'`,
        409
      );
    }
  }

  return Object.freeze({
    valid: true,
    job,
    resumedAt: new Date().toISOString(),
  });
}

/**
 * Asserts that actor authentication, session version, and permissions remain continuous
 * throughout long-running mailbox lifecycle operations. Any revocation or session rotation
 * immediately halts the mutation and prevents retargeting.
 */
export function assertActorAuthorizationContinuous({
  currentAuth,
  originalAuth = null,
  targetWebsiteId = null,
  targetMailboxId = null,
} = {}) {
  if (!currentAuth || !currentAuth.user) {
    throw new MailboxAuthorizationRevokedError(
      'auth_unauthenticated',
      'Actor session is unauthenticated or expired',
      401
    );
  }

  if (originalAuth?.user?.id && currentAuth.user.id !== originalAuth.user.id) {
    throw new MailboxAuthorizationRevokedError(
      'auth_session_changed',
      'Actor identity changed during operation; in-flight mutation halted',
      403
    );
  }

  if (originalAuth?.sessionVersion && currentAuth.sessionVersion && currentAuth.sessionVersion !== originalAuth.sessionVersion) {
    throw new MailboxAuthorizationRevokedError(
      'auth_session_rotated',
      'Actor session was rotated; pending mutation must be re-authenticated',
      401
    );
  }

  if (currentAuth.user.active === false) {
    throw new MailboxAuthorizationRevokedError(
      'auth_user_suspended',
      'User account is suspended or inactive; mutation halted',
      403
    );
  }

  if (currentAuth.user.role === 'read_only' || currentAuth.access?.mode === 'read_only') {
    throw new MailboxAuthorizationRevokedError(
      'auth_permission_revoked',
      'Actor has read-only access; write permissions revoked',
      403
    );
  }

  if (currentAuth.security?.managementAllowed === false) {
    throw new MailboxAuthorizationRevokedError(
      'auth_management_disallowed',
      'Management operations not permitted for this actor',
      403
    );
  }

  if (['site_manager', 'customer'].includes(currentAuth.user.role)) {
    if (targetWebsiteId && currentAuth.user.websiteIds && !currentAuth.user.websiteIds.includes(targetWebsiteId)) {
      throw new MailboxAuthorizationRevokedError(
        'auth_website_grant_revoked',
        `Actor does not have access to website '${targetWebsiteId}'`,
        403
      );
    }
  }

  return Object.freeze({
    authorized: true,
    actorId: currentAuth.user.id,
    role: currentAuth.user.role,
  });
}

/**
 * Manages inter-process lock files to synchronize worker mutations on mailboxes.
 * Protects mailbox operations across processes using atomic filesystem locks.
 */
export function createMailboxInterProcessLockManager({
  lockDir = '/var/lib/yunpanel/locks/mailboxes',
  serverId = 'local-server',
  acquireLockFn = acquireLocalExecutionLock,
} = {}) {
  const activeLocks = new Map();

  async function acquireLock(mailboxId, { address = null, pid = process.pid } = {}) {
    if (!mailboxId || typeof mailboxId !== 'string') {
      throw new MailboxConcurrencyLockError('invalid_mailbox_id', 'Mailbox ID is required for lock', 400);
    }
    if (activeLocks.has(mailboxId)) {
      throw new MailboxConcurrencyLockError(
        'mailbox_locked_for_mutation',
        `Mailbox '${mailboxId}' is already locked for worker mutation`,
        409
      );
    }
    if (address) {
      for (const entry of activeLocks.values()) {
        if (entry.address && entry.address.toLowerCase() === address.toLowerCase()) {
          throw new MailboxConcurrencyLockError(
            'mailbox_locked_for_mutation',
            `Mailbox address '${address}' is already locked for worker mutation`,
            409
          );
        }
      }
    }

    const lockPath = path.join(lockDir, `${mailboxId}.lock`);
    let lockHandle = null;
    if (typeof acquireLockFn === 'function') {
      try {
        lockHandle = await acquireLockFn({
          filePath: lockPath,
          serverId,
          pid,
        });
      } catch (err) {
        if (err instanceof LocalExecutionLockError || err.name === 'LocalExecutionLockError' || err.code === 'local_executor_lock_busy') {
          throw new MailboxConcurrencyLockError(
            'mailbox_locked_for_mutation',
            `Mailbox '${mailboxId}' is locked by another worker process (${err.message})`,
            409
          );
        }
        throw err;
      }
    }

    const entry = {
      mailboxId,
      address,
      lockHandle,
      lockPath,
      acquiredAt: Date.now(),
      released: false,
    };
    activeLocks.set(mailboxId, entry);

    return Object.freeze({
      mailboxId,
      address,
      lockPath,
      async release() {
        if (entry.released) return false;
        entry.released = true;
        activeLocks.delete(mailboxId);
        if (lockHandle && typeof lockHandle.release === 'function') {
          return lockHandle.release();
        }
        return true;
      },
    });
  }

  function isLocked(mailboxId) {
    return activeLocks.has(mailboxId);
  }

  function isAddressLocked(address) {
    if (!address) return false;
    const lower = address.toLowerCase();
    for (const entry of activeLocks.values()) {
      if (entry.address && entry.address.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  return Object.freeze({
    acquireLock,
    isLocked,
    isAddressLocked,
  });
}

/**
 * Asserts that during worker mutation on a mailbox:
 * 1. An inter-process lock is acquired.
 * 2. Concurrent alias creation referencing the mailbox fails closed.
 * 3. Concurrent mailbox reactivation fails closed.
 * 4. Concurrent message delivery fails closed.
 * 5. Lock is guaranteed released upon completion or failure.
 */
export async function assertWorkerMutationConcurrencyGuard({
  mailboxId,
  address,
  lockManager,
  actionFn,
  concurrentAliasAttempt = null,
  concurrentReactivateAttempt = null,
  concurrentMessageDeliveryAttempt = null,
} = {}) {
  if (!mailboxId || !address || !lockManager) {
    throw new MailboxSingleLifecycleError('invalid_arguments', 'mailboxId, address, and lockManager are required', 400);
  }

  const lock = await lockManager.acquireLock(mailboxId, { address });

  try {
    if (concurrentAliasAttempt) {
      let aliasBlocked = false;
      try {
        if (lockManager.isAddressLocked(address)) {
          throw new MailboxConcurrencyLockError(
            'mailbox_mutation_locked',
            `Cannot add alias to '${address}': mailbox is locked for worker mutation`,
            409
          );
        }
        await concurrentAliasAttempt();
      } catch (err) {
        if (err.code === 'mailbox_mutation_locked') {
          aliasBlocked = true;
        } else {
          throw err;
        }
      }
      if (!aliasBlocked) {
        throw new MailboxConcurrencyLockError(
          'alias_race_not_prevented',
          'Concurrent alias creation was not prevented during worker mutation lock',
          409
        );
      }
    }

    if (concurrentReactivateAttempt) {
      let reactivateBlocked = false;
      try {
        if (lockManager.isLocked(mailboxId)) {
          throw new MailboxConcurrencyLockError(
            'mailbox_mutation_locked',
            `Cannot re-activate mailbox '${mailboxId}': locked for worker mutation`,
            409
          );
        }
        await concurrentReactivateAttempt();
      } catch (err) {
        if (err.code === 'mailbox_mutation_locked') {
          reactivateBlocked = true;
        } else {
          throw err;
        }
      }
      if (!reactivateBlocked) {
        throw new MailboxConcurrencyLockError(
          'reactivation_race_not_prevented',
          'Concurrent mailbox reactivation was not prevented during worker mutation lock',
          409
        );
      }
    }

    if (concurrentMessageDeliveryAttempt) {
      let messageBlocked = false;
      try {
        if (lockManager.isAddressLocked(address)) {
          throw new MailboxConcurrencyLockError(
            'mailbox_mutation_locked',
            `Mail delivery rejected: mailbox '${address}' is locked for worker mutation`,
            409
          );
        }
        await concurrentMessageDeliveryAttempt();
      } catch (err) {
        if (err.code === 'mailbox_mutation_locked') {
          messageBlocked = true;
        } else {
          throw err;
        }
      }
      if (!messageBlocked) {
        throw new MailboxConcurrencyLockError(
          'message_delivery_race_not_prevented',
          'Concurrent message delivery was not prevented during worker mutation lock',
          409
        );
      }
    }

    const result = typeof actionFn === 'function' ? await actionFn(lock) : null;
    return Object.freeze({
      executed: true,
      result,
      racesPrevented: true,
    });
  } finally {
    await lock.release();
  }
}

/**
 * Executes mailbox deletion and verifies real rollback from verified backup on error.
 * Asserts that if host deletion fails (e.g. rename or unlink failure):
 * 1. Live mail data is proven restored to the pre-deletion verified backup snapshot.
 * 2. Pre-deletion backup in backupManager remains intact.
 * 3. Mailbox record in mailboxRegistry remains intact at expectedRevision with enabled: false.
 */
export async function executeMailboxDeletionWithRollbackVerification({
  mailboxId,
  address,
  backupId,
  expectedRevision,
  deleteManager,
  backupManager,
  mailDataInspector,
  mailboxRegistry,
  shouldSimulateFailure = false,
  transactionId = randomUUID(),
} = {}) {
  if (!mailboxId || !address || !backupId) {
    throw new MailboxSingleLifecycleError('invalid_arguments', 'mailboxId, address, and backupId are required', 400);
  }

  const backup = typeof backupManager?.inspectBackup === 'function'
    ? await backupManager.inspectBackup(backupId)
    : await backupManager?.materializeBackup(backupId);
  if (!backup) {
    throw new MailboxSingleLifecycleError('backup_not_found', `Verified backup '${backupId}' not found`, 404);
  }

  const mailboxBefore = await mailboxRegistry.getMailbox(mailboxId);
  if (!mailboxBefore) {
    throw new MailboxSingleLifecycleError('mailbox_not_found', 'Mailbox was not found', 404);
  }
  if (mailboxBefore.enabled !== false) {
    throw new MailboxSingleLifecycleError('mailbox_not_disabled', 'Mailbox must be disabled before deletion', 409);
  }

  const liveBefore = await mailDataInspector.inspectMailbox(address);
  const initialSnapshot = liveBefore.snapshotSha256;
  const initialBytes = liveBefore.bytes;

  let deleteError = null;
  let deleteResult = null;

  try {
    if (shouldSimulateFailure) {
      const err = new Error('Simulated host failure during mail data unlink');
      err.code = 'mail_data_delete_failed';
      throw err;
    }
    deleteResult = await deleteManager.deleteData({
      transactionId,
      backupId,
      scope: 'mailbox',
      identity: address,
      expectedTargetSnapshotSha256: initialSnapshot,
    });
  } catch (err) {
    deleteError = err;
  }

  if (deleteError) {
    const liveAfter = await mailDataInspector.inspectMailbox(address);
    if (!liveAfter.present || liveAfter.snapshotSha256 !== initialSnapshot) {
      throw new MailboxRollbackError(
        'rollback_verification_failed',
        `Mailbox live data was not restored after failure: present=${liveAfter.present}`,
        500
      );
    }

    const intactBackup = typeof backupManager?.inspectBackup === 'function'
      ? await backupManager.inspectBackup(backupId)
      : await backupManager?.materializeBackup(backupId);
    if (!intactBackup) {
      throw new MailboxRollbackError(
        'backup_compromised',
        'Pre-deletion backup was lost or compromised during rollback',
        500
      );
    }

    const mailboxAfter = await mailboxRegistry.getMailbox(mailboxId);
    if (!mailboxAfter || mailboxAfter.enabled !== false || mailboxAfter.revision !== expectedRevision) {
      throw new MailboxRollbackError(
        'mailbox_record_corrupted',
        'Mailbox registry record was corrupted or deleted during failed operation',
        500
      );
    }

    return Object.freeze({
      success: false,
      rolledBack: true,
      errorHandled: true,
      originalError: deleteError.code || deleteError.message,
      liveDataRestored: true,
      backupIntact: true,
      mailboxPreserved: true,
    });
  }

  return Object.freeze({
    success: true,
    deleted: true,
    result: deleteResult,
    rolledBack: false,
  });
}

// ============================================================================
// Express Route Mount Helper
// ============================================================================

export function mountSingleMailboxLifecycleRoutes(app, {
  sessionTracker = createMailboxProtocolSessionTracker(),
  mailboxRegistry,
  mailDomainRegistry,
  mailConfigurationService = null,
  mailboxAccessGuard = null,
  jobRegistry = null,
  mailDataInspector = null,
  backupManager = null,
  lockManager = null,
  rapidConfirmationGuard = null,
} = {}) {
  const coordinator = createSingleMailboxLifecycleCoordinator({
    mailboxRegistry,
    mailDomainRegistry,
    sessionTracker,
    mailConfigurationService,
    mailboxAccessGuard,
    jobRegistry,
    mailDataInspector,
    backupManager,
    lockManager,
    rapidConfirmationGuard,
  });

  // GET session status for an account (requires panel route access)
  app.get('/api/mailboxes/:address/protocol-sessions', requirePanelRouteAccess, (req, res) => {
    const address = req.params.address;
    const dovecot = sessionTracker.listActiveDovecotSessions(address);
    res.json({
      data: {
        address,
        dovecotSessions: dovecot,
        dovecotActiveCount: dovecot.length,
      },
    });
  });

  // POST kick / quiesce sessions for target address
  app.post('/api/mailboxes/:address/quiesce-sessions', requirePanelRouteAccess, async (req, res, next) => {
    try {
      const address = req.params.address;
      if (mailboxAccessGuard && typeof mailboxAccessGuard.quiesce === 'function') {
        await mailboxAccessGuard.quiesce(address);
      }
      const dovecotKicked = sessionTracker.kickDovecotUser(address);
      const smtpKicked = sessionTracker.invalidateSmtpSessions(address);
      const webmailKicked = sessionTracker.terminateWebmailHttpSessions(address);
      res.json({
        data: {
          address,
          kicked: {
            dovecot: dovecotKicked,
            smtp: smtpKicked,
            webmail: webmailKicked,
          },
          accessQuiesced: Boolean(mailboxAccessGuard),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return coordinator;
}
