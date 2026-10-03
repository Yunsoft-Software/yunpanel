import { randomUUID } from 'node:crypto';
import { validateEmail } from './auth-mailer.js';
import { maskSecrets, maskSecretsInString } from './secret-masker.js';

export class MailDeliveryDiagnosticsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDeliveryDiagnosticsError';
    this.code = code;
    this.status = status;
  }
}

export const MAIL_PROTOCOLS = Object.freeze({
  incoming: Object.freeze([
    Object.freeze({
      id: 'imaps',
      protocol: 'IMAP',
      port: 993,
      socketType: 'SSL/TLS',
      tlsRequirement: 'SSL/TLS',
      recommended: true,
      description: 'IMAPS (IMAP over direct SSL/TLS encryption)',
    }),
    Object.freeze({
      id: 'imap',
      protocol: 'IMAP',
      port: 143,
      socketType: 'STARTTLS',
      tlsRequirement: 'STARTTLS',
      recommended: false,
      description: 'IMAP with STARTTLS encryption',
    }),
  ]),
  outgoing: Object.freeze([
    Object.freeze({
      id: 'submission',
      protocol: 'SMTP',
      port: 587,
      socketType: 'STARTTLS',
      tlsRequirement: 'STARTTLS',
      recommended: true,
      description: 'Submission port with mandatory STARTTLS encryption',
    }),
    Object.freeze({
      id: 'submissions',
      protocol: 'SMTP',
      port: 465,
      socketType: 'SSL/TLS',
      tlsRequirement: 'SSL/TLS',
      recommended: false,
      description: 'SMTPS port with implicit SSL/TLS encryption',
    }),
    Object.freeze({
      id: 'smtp',
      protocol: 'SMTP',
      port: 25,
      socketType: 'STARTTLS',
      tlsRequirement: 'STARTTLS',
      recommended: false,
      description: 'Standard SMTP relay with opportunistic STARTTLS',
    }),
  ]),
});

export const MAIL_PORT_TLS_REQUIREMENTS = Object.freeze({
  25: 'STARTTLS',
  587: 'STARTTLS',
  465: 'SSL/TLS',
  143: 'STARTTLS',
  993: 'SSL/TLS',
});

export const MAIL_PORTS_SUMMARY = Object.freeze({
  smtp: Object.freeze([25, 587, 465]),
  imap: Object.freeze([143, 993]),
});

function classifyRecipientRouting(address, localDomainSet) {
  if (typeof address !== 'string') return 'external';
  const parts = address.split('@');
  if (parts.length !== 2) return 'external';
  const domain = parts[1].toLowerCase().replace(/\.$/, '');
  return localDomainSet.has(domain) ? 'local' : 'external';
}

function classifyQueueMessageRouting(entry, localDomainSet) {
  const recipients = Array.isArray(entry.recipients) ? entry.recipients : [];
  if (recipients.length === 0) return 'external';
  let localCount = 0;
  let externalCount = 0;
  for (const recipient of recipients) {
    const routing = classifyRecipientRouting(recipient.address, localDomainSet);
    if (routing === 'local') localCount += 1;
    else externalCount += 1;
  }
  if (localCount > 0 && externalCount > 0) return 'mixed';
  if (localCount > 0) return 'local';
  return 'external';
}

function classifyLogRouting(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.includes('postfix/smtp[') || /relay=[^,\s]+:\d+/.test(text)) {
    return 'external';
  }
  if (text.includes('postfix/lmtp[') || text.includes('postfix/virtual[') || text.includes('postfix/local[') || text.includes('dovecot:')) {
    return 'local';
  }
  if (text.includes('postfix/submission') || text.includes('postfix/smtpd[')) {
    return 'submission';
  }
  return 'internal';
}

export function createMailDeliveryDiagnosticsService({
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailDkimRegistry = null,
  mailDiagnosticsInspector = null,
  mailProtocolHealthInspector = null,
  mailQueueInspector = null,
  journalLogReader = null,
  authMailer = null,
  mailboxQuotaRegistry = null,
  localServerId = null,
  transport = null,
  now = () => Date.now(),
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.listMailboxes !== 'function') {
    throw new MailDeliveryDiagnosticsError('mail_delivery_dependencies_invalid', 'Required dependencies are missing', 500);
  }

  async function getLocalDomainSet() {
    const list = await mailDomainRegistry.listMailDomains();
    return new Set(
      list
        .filter((d) => d && d.managementMode === 'local' && d.status === 'enabled')
        .map((d) => String(d.domainName).toLowerCase().replace(/\.$/, ''))
    );
  }

  async function resolveManagedHostname(mailDomain) {
    if (mailDomain?.mailHostname) return mailDomain.mailHostname;
    return `mail.${mailDomain.domainName}`;
  }

  async function getConnectionSettings({ mailDomain, mailbox = null }) {
    if (!mailDomain) throw new MailDeliveryDiagnosticsError('mail_domain_required', 'Mail domain is required', 400);

    const managementMode = mailDomain.managementMode ?? 'local';
    const isLocal = managementMode === 'local';

    if (!isLocal) {
      return Object.freeze({
        domainName: mailDomain.domainName,
        managementMode: 'external',
        routing: 'external',
        description: 'Mail routing is managed by an external provider.',
        hostnames: Object.freeze({
          incoming: 'external-mail-provider',
          outgoing: 'external-mail-provider',
        }),
        ports: Object.freeze([]),
        note: 'Client port configuration and local TLS certificates are managed by your external email provider.',
      });
    }

    const mailHostname = await resolveManagedHostname(mailDomain);

    let protocolListeners = null;
    if (mailProtocolHealthInspector && typeof mailProtocolHealthInspector.inspect === 'function') {
      try {
        const health = await mailProtocolHealthInspector.inspect();
        protocolListeners = health?.protocols ?? null;
      } catch {
        protocolListeners = null;
      }
    }

    const username = mailbox?.address ?? `user@${mailDomain.domainName}`;

    return Object.freeze({
      domainName: mailDomain.domainName,
      managementMode: 'local',
      routing: 'local',
      mailHostname,
      username,
      account: mailbox ? Object.freeze({
        address: mailbox.address,
        username: mailbox.address,
        enabled: mailbox.enabled,
      }) : null,
      incoming: Object.freeze({
        hostname: mailHostname,
        protocols: MAIL_PROTOCOLS.incoming.map((p) => {
          const listener = protocolListeners?.find((l) => l.port === p.port);
          return Object.freeze({
            ...p,
            listening: listener ? listener.satisfied : null,
          });
        }),
        username,
        authentication: 'password-cleartext',
      }),
      outgoing: Object.freeze({
        hostname: mailHostname,
        protocols: MAIL_PROTOCOLS.outgoing.map((p) => {
          const listener = protocolListeners?.find((l) => l.port === p.port);
          return Object.freeze({
            ...p,
            listening: listener ? listener.satisfied : null,
          });
        }),
        username,
        authentication: 'password-cleartext',
      }),
      portsSummary: MAIL_PORTS_SUMMARY,
      tlsRequirements: MAIL_PORT_TLS_REQUIREMENTS,
      hostname: mailHostname,
      smtp: Object.freeze({
        host: mailHostname,
        ports: Object.freeze([465, 587, 25]),
        tls: 'SSL/TLS (Port 465) / STARTTLS (Port 587, 25)',
      }),
      imap: Object.freeze({
        host: mailHostname,
        ports: Object.freeze([993, 143]),
        tls: 'SSL/TLS (Port 993) / STARTTLS (Port 143)',
      }),
      authentication: 'Password (PLAIN, LOGIN)',
    });
  }

  async function getDnsRequirements({ mailDomain }) {
    if (!mailDomain) throw new MailDeliveryDiagnosticsError('mail_domain_required', 'Mail domain is required', 400);

    let dkim = null;
    if (mailDkimRegistry && typeof mailDkimRegistry.getKey === 'function') {
      try {
        dkim = await mailDkimRegistry.getKey(mailDomain.id);
      } catch {
        dkim = null;
      }
    }

    if (!mailDiagnosticsInspector || typeof mailDiagnosticsInspector.inspect !== 'function') {
      return Object.freeze({
        domainName: mailDomain.domainName,
        status: 'uninspected',
        issues: Object.freeze([]),
      });
    }

    const inspected = await mailDiagnosticsInspector.inspect(mailDomain.domainName, { dkim });
    const diagnostics = inspected?.diagnostics ?? {};

    const mxStatus = diagnostics.mx?.state ?? 'unknown';
    const spfStatus = diagnostics.spf?.state ?? 'unknown';
    const dkimStatus = diagnostics.dkim?.state ?? 'not_configured';
    const dmarcStatus = diagnostics.dmarc?.state ?? 'unknown';
    const ptrStatus = diagnostics.ptr?.state ?? 'unknown';

    const isMxReady = mxStatus === 'ready' || mxStatus === 'pass';
    const isSpfReady = spfStatus === 'present' || spfStatus === 'pass';
    const isDkimReady = dkimStatus === 'ready' || dkimStatus === 'pass';
    const isDmarcReady = dmarcStatus === 'present' || dmarcStatus === 'pass';

    const allDnsReady = isMxReady && isSpfReady && isDkimReady && isDmarcReady;

    return Object.freeze({
      domainName: mailDomain.domainName,
      managementMode: mailDomain.managementMode,
      observedAt: inspected.observedAt ?? new Date(now()).toISOString(),
      mx: diagnostics.mx ?? null,
      spf: diagnostics.spf ?? null,
      dkim: diagnostics.dkim ?? null,
      dmarc: diagnostics.dmarc ?? null,
      ptr: diagnostics.ptr ?? null,
      allReady: allDnsReady,
      attentionRequired: inspected.attentionRequired ?? !allDnsReady,
      issues: inspected.issues ?? Object.freeze([]),
    });
  }

  async function getQueueStatus({ mailDomain = null, limit = 100, search = null, queueName = null } = {}) {
    if (!mailQueueInspector || typeof mailQueueInspector.query !== 'function') {
      return Object.freeze({
        entries: Object.freeze([]),
        summary: Object.freeze({ totalCount: 0, localCount: 0, externalCount: 0, mixedCount: 0, queues: Object.freeze({}) }),
        sideEffects: false,
      });
    }

    const localDomainSet = await getLocalDomainSet();
    const queryResult = await mailQueueInspector.query({ limit, search, queueName });
    const rawEntries = queryResult?.entries ?? [];

    const scopedDomain = mailDomain?.domainName ? mailDomain.domainName.toLowerCase().replace(/\.$/, '') : null;

    const filtered = [];
    let localCount = 0;
    let externalCount = 0;
    let mixedCount = 0;
    const queueCounts = { active: 0, deferred: 0, hold: 0, incoming: 0 };

    for (const entry of rawEntries) {
      const routing = classifyQueueMessageRouting(entry, localDomainSet);

      if (scopedDomain) {
        const senderDomain = entry.sender ? entry.sender.split('@')[1]?.toLowerCase().replace(/\.$/, '') : null;
        const recipientMatch = entry.recipients?.some((r) => {
          const rDomain = r.address ? r.address.split('@')[1]?.toLowerCase().replace(/\.$/, '') : null;
          return rDomain === scopedDomain;
        });
        if (senderDomain !== scopedDomain && !recipientMatch) {
          continue;
        }
      }

      if (routing === 'local') localCount += 1;
      else if (routing === 'external') externalCount += 1;
      else mixedCount += 1;

      if (entry.queueName in queueCounts) {
        queueCounts[entry.queueName] += 1;
      }

      filtered.push(Object.freeze({
        ...maskSecrets(entry),
        routing,
      }));
    }

    return Object.freeze({
      entries: Object.freeze(filtered),
      summary: Object.freeze({
        totalCount: filtered.length,
        localCount,
        externalCount,
        mixedCount,
        queues: Object.freeze(queueCounts),
      }),
      sideEffects: false,
    });
  }

  async function getDeliveryLogs({ mailDomain = null, service = 'postfix', limit = 100, search = null } = {}) {
    if (!journalLogReader || (typeof journalLogReader.query !== 'function' && typeof journalLogReader.readServiceLogs !== 'function')) {
      return Object.freeze({
        entries: Object.freeze([]),
        total: 0,
        sideEffects: false,
      });
    }

    const serviceUnit = service === 'dovecot' ? 'dovecot.service'
      : service === 'rspamd' ? 'rspamd.service'
        : 'postfix.service';

    const result = typeof journalLogReader.query === 'function'
      ? await journalLogReader.query({ unit: serviceUnit, limit, search })
      : await journalLogReader.readServiceLogs({ service, limit, search });

    const entries = result?.entries ?? [];
    const scopedDomain = mailDomain?.domainName ? mailDomain.domainName.toLowerCase() : null;

    const processed = [];
    for (const entry of entries) {
      const maskedMessage = maskSecretsInString(entry.message ?? '');
      if (scopedDomain && !maskedMessage.toLowerCase().includes(scopedDomain)) {
        continue;
      }
      const routing = classifyLogRouting(maskedMessage);
      processed.push(Object.freeze({
        timestamp: entry.timestamp,
        level: entry.level ?? 'info',
        service,
        routing,
        message: maskedMessage,
      }));
    }

    return Object.freeze({
      entries: Object.freeze(processed),
      total: processed.length,
      sideEffects: false,
    });
  }

  async function sendTestEmail({
    mailDomain,
    mailbox = null,
    to,
    from = null,
    subject = null,
    text = null,
    customTransport = null,
  }) {
    if (!mailDomain) throw new MailDeliveryDiagnosticsError('mail_domain_required', 'Mail domain is required', 400);

    if (mailDomain.managementMode === 'external') {
      return Object.freeze({
        success: false,
        status: 'external_routing_not_managed',
        error: 'Mail domain is managed externally; local MTA test sending is not applicable',
        routing: 'external',
        timestamp: new Date(now()).toISOString(),
      });
    }

    const validatedTo = validateEmail(to);

    let fromAddress;
    if (from) {
      fromAddress = validateEmail(from);
      const fromDomain = fromAddress.split('@')[1];
      if (fromDomain !== mailDomain.domainName.toLowerCase()) {
        throw new MailDeliveryDiagnosticsError(
          'mail_test_from_domain_mismatch',
          `Sender address domain (${fromDomain}) does not match mail domain (${mailDomain.domainName})`,
          400
        );
      }
    } else if (mailbox) {
      fromAddress = mailbox.address;
    } else {
      fromAddress = `postmaster@${mailDomain.domainName}`;
    }

    const localDomainSet = await getLocalDomainSet();
    const routing = classifyRecipientRouting(validatedTo, localDomainSet);

    const testSubject = subject ?? `YunPanel Test Mail Delivery · ${new Date(now()).toISOString()}`;
    const testText = text ?? [
      'This is an authentic mail delivery test sent from YunPanel.',
      `Sender: ${fromAddress}`,
      `Recipient: ${validatedTo}`,
      `Routing: ${routing}`,
      `Time: ${new Date(now()).toISOString()}`,
      `Domain: ${mailDomain.domainName}`,
    ].join('\n');

    const activeTransport = customTransport ?? transport ?? authMailer;

    if (!activeTransport) {
      return Object.freeze({
        success: false,
        delivered: false,
        status: 'delivery_failed',
        errorCode: 'smtp_transport_unavailable',
        errorMessage: 'SMTP delivery transport is not configured',
        error: 'SMTP delivery transport is not configured',
        routing,
        recipient: validatedTo,
        from: fromAddress,
        to: validatedTo,
        timestamp: new Date(now()).toISOString(),
      });
    }

    try {
      let sendResult;
      if (typeof activeTransport.sendMail === 'function') {
        sendResult = await activeTransport.sendMail({
          from: fromAddress,
          fromAddress,
          to: validatedTo,
          subject: testSubject,
          text: testText,
        });
      } else if (typeof activeTransport === 'function') {
        sendResult = await activeTransport({
          from: fromAddress,
          fromAddress,
          to: validatedTo,
          subject: testSubject,
          text: testText,
        });
      } else {
        throw new Error('Invalid transport provided');
      }

      return Object.freeze(maskSecrets({
        success: true,
        delivered: true,
        status: 'sent',
        messageId: sendResult?.messageId ?? `<${randomUUID()}@${mailDomain.domainName}>`,
        accepted: sendResult?.accepted ?? [validatedTo],
        response: sendResult?.response ?? '250 2.0.0 Ok: queued',
        routing,
        recipient: validatedTo,
        from: fromAddress,
        to: validatedTo,
        subject: testSubject,
        timestamp: new Date(now()).toISOString(),
      }));
    } catch (failure) {
      return Object.freeze(maskSecrets({
        success: false,
        delivered: false,
        status: 'delivery_failed',
        errorCode: failure?.code ?? 'smtp_delivery_failed',
        errorMessage: maskSecretsInString(failure?.message ?? 'SMTP delivery failed'),
        error: maskSecretsInString(failure?.message ?? 'SMTP delivery failed'),
        routing,
        recipient: validatedTo,
        from: fromAddress,
        to: validatedTo,
        subject: testSubject,
        timestamp: new Date(now()).toISOString(),
      }));
    }
  }

  async function verifyMailboxReception({ mailbox, mailDomain }) {
    if (!mailbox) throw new MailDeliveryDiagnosticsError('mailbox_required', 'Mailbox is required', 400);
    if (!mailDomain) throw new MailDeliveryDiagnosticsError('mail_domain_required', 'Mail domain is required', 400);

    if (mailDomain.managementMode === 'external') {
      return Object.freeze({
        success: false,
        canReceive: false,
        enabled: Boolean(mailbox.enabled),
        status: 'external_routing',
        reason: 'external_routing',
        error: 'Mail domain is configured with external routing; local reception is not managed by this server',
        address: mailbox.address,
        routing: 'external',
        timestamp: new Date(now()).toISOString(),
      });
    }

    if (!mailbox.enabled) {
      return Object.freeze({
        success: false,
        canReceive: false,
        enabled: false,
        status: 'mailbox_disabled',
        reason: 'mailbox_disabled',
        error: 'Mailbox is disabled and will reject incoming delivery',
        address: mailbox.address,
        routing: 'local',
        timestamp: new Date(now()).toISOString(),
      });
    }

    if (mailboxQuotaRegistry && typeof mailboxQuotaRegistry.getQuota === 'function') {
      try {
        const quota = await mailboxQuotaRegistry.getQuota(mailbox.id);
        if (quota && Number.isFinite(quota.quotaBytes) && quota.quotaBytes > 0
          && Number.isFinite(quota.usedBytes) && quota.usedBytes >= quota.quotaBytes) {
          return Object.freeze({
            success: false,
            canReceive: false,
            enabled: true,
            status: 'quota_exceeded',
            reason: 'quota_exceeded',
            error: 'Mailbox storage quota exceeded; incoming messages will be deferred or rejected',
            address: mailbox.address,
            quota: Object.freeze({ usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes }),
            routing: 'local',
            timestamp: new Date(now()).toISOString(),
          });
        }
      } catch {}
    }

    return Object.freeze({
      success: true,
      canReceive: true,
      enabled: true,
      status: 'receptive',
      address: mailbox.address,
      routing: 'local',
      timestamp: new Date(now()).toISOString(),
    });
  }

  async function getMailboxDiagnostics({ mailboxId }) {
    const mailbox = typeof mailboxRegistry.getMailbox === 'function'
      ? await mailboxRegistry.getMailbox(mailboxId)
      : (await mailboxRegistry.listMailboxes({})).find((m) => m && m.id === mailboxId) ?? null;
    if (!mailbox) throw new MailDeliveryDiagnosticsError('mailbox_not_found', 'Mailbox was not found', 404);

    const mailDomain = await mailDomainRegistry.getMailDomain(mailbox.mailDomainId);
    if (!mailDomain) throw new MailDeliveryDiagnosticsError('mail_domain_not_found', 'Mail domain was not found', 404);

    const [connectionSettings, reception, dnsRequirements, queue] = await Promise.all([
      getConnectionSettings({ mailDomain, mailbox }),
      verifyMailboxReception({ mailbox, mailDomain }),
      getDnsRequirements({ mailDomain }),
      getQueueStatus({ mailDomain, search: mailbox.address }),
    ]);

    return Object.freeze({
      mailbox: Object.freeze({
        id: mailbox.id,
        address: mailbox.address,
        enabled: mailbox.enabled,
        revision: mailbox.revision,
      }),
      mailDomain: Object.freeze({
        id: mailDomain.id,
        domainName: mailDomain.domainName,
        managementMode: mailDomain.managementMode,
      }),
      connectionSettings,
      reception,
      dnsRequirements,
      queue,
    });
  }

  async function getMailDomainDeliveryDiagnostics({ mailDomainId }) {
    const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
    if (!mailDomain) throw new MailDeliveryDiagnosticsError('mail_domain_not_found', 'Mail domain was not found', 404);

    const [connectionSettings, dnsRequirements, queue, deliveryLogs] = await Promise.all([
      getConnectionSettings({ mailDomain }),
      getDnsRequirements({ mailDomain }),
      getQueueStatus({ mailDomain }),
      getDeliveryLogs({ mailDomain }),
    ]);

    return Object.freeze({
      domainName: mailDomain.domainName,
      mailDomainId: mailDomain.id,
      managementMode: mailDomain.managementMode,
      routing: mailDomain.managementMode === 'local' ? 'local' : 'external',
      status: mailDomain.status,
      connectionSettings,
      dnsRequirements,
      queue,
      deliveryLogs,
      attentionRequired: dnsRequirements.attentionRequired,
      issues: dnsRequirements.issues,
    });
  }

  async function getServiceDiagnostics({ serverId }) {
    if (localServerId !== null && serverId !== localServerId) {
      throw new MailDeliveryDiagnosticsError('server_not_found', 'Server not found', 404);
    }

    let protocolHealth = null;
    if (mailProtocolHealthInspector && typeof mailProtocolHealthInspector.inspect === 'function') {
      try {
        protocolHealth = await mailProtocolHealthInspector.inspect();
      } catch {
        protocolHealth = null;
      }
    }

    const [queue, deliveryLogs] = await Promise.all([
      getQueueStatus(),
      getDeliveryLogs(),
    ]);

    return Object.freeze({
      serverId,
      protocolHealth,
      protocols: protocolHealth,
      portsSummary: MAIL_PORTS_SUMMARY,
      tlsRequirements: MAIL_PORT_TLS_REQUIREMENTS,
      connectionSettings: Object.freeze({
        smtp: Object.freeze({
          ports: Object.freeze([465, 587, 25]),
          tls: 'SSL/TLS (Port 465) / STARTTLS (Port 587, 25)',
        }),
        imap: Object.freeze({
          ports: Object.freeze([993, 143]),
          tls: 'SSL/TLS (Port 993) / STARTTLS (Port 143)',
        }),
        authentication: 'Password (PLAIN, LOGIN)',
        tlsRequirements: MAIL_PORT_TLS_REQUIREMENTS,
        portsSummary: MAIL_PORTS_SUMMARY,
      }),
      queue,
      deliveryLogs,
    });
  }

  return Object.freeze({
    getConnectionSettings,
    getDnsRequirements,
    getQueueStatus,
    getDeliveryLogs,
    sendTestEmail,
    verifyMailboxReception,
    getMailboxDiagnostics,
    getMailDomainDeliveryDiagnostics,
    getServiceDiagnostics,
  });
}
