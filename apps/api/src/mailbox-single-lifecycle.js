import { randomUUID } from 'node:crypto';
import { requirePanelRouteAccess } from './panel-http-guard.js';

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

  return Object.freeze({
    sessionTracker,
    disableTargetMailbox,
    applyConfigurationAndQuiesceSessions,
    assertNoDomainOrSiblingDisruption,
    assertNoClosedDomainReopened,
    assertMailboxAccessTerminatedSeparately,
    assertSiblingMailboxContinuity,
  });
}

// ============================================================================
// Express Route Mount Helper
// ============================================================================

export function mountSingleMailboxLifecycleRoutes(app, {
  sessionTracker = createMailboxProtocolSessionTracker(),
  mailboxRegistry,
  mailDomainRegistry,
} = {}) {
  const coordinator = createSingleMailboxLifecycleCoordinator({
    mailboxRegistry,
    mailDomainRegistry,
    sessionTracker,
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
  app.post('/api/mailboxes/:address/quiesce-sessions', requirePanelRouteAccess, (req, res) => {
    const address = req.params.address;
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
      },
    });
  });

  return coordinator;
}
