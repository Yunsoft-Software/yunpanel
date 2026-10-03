import { normalizeMailboxAddress } from '@yunpanel/config-templates';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import {
  createMailDeliveryDiagnosticsService,
  MailDeliveryDiagnosticsError,
  MAIL_PROTOCOLS,
  MAIL_PORTS_SUMMARY,
  MAIL_PORT_TLS_REQUIREMENTS,
} from './mail-delivery-diagnostics-service.js';

export class MailDiagnosticsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDiagnosticsHttpError';
    this.code = code;
    this.status = status;
  }
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailDiagnosticsHttpError(
      'mail_diagnostics_query_invalid',
      'Mail diagnostics does not accept query parameters',
    );
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof MailDeliveryDiagnosticsError) {
        return next(new MailDiagnosticsHttpError(error.code, error.message, error.status));
      }
      return next(error);
    }
  };
}

async function scopedMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId, allowExternal = false }) {
  const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!mailDomain) throw new MailDiagnosticsHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  if (!allowExternal && mailDomain.managementMode !== 'local') {
    throw new MailDiagnosticsHttpError(
      'mail_diagnostics_local_domain_required',
      'Mail diagnostics requires a locally managed mail domain',
      409,
    );
  }
  if (!mailDomain.webDomainId) {
    throw new MailDiagnosticsHttpError(
      'mail_domain_server_unavailable',
      'Mail domain is not bound to a local web domain',
      409,
    );
  }
  const domain = await domainRegistry.getDomain(mailDomain.webDomainId);
  if (!domain || domain.primaryDomain !== mailDomain.domainName
    || (localServerId !== null && domain.serverId !== localServerId)) {
    throw new MailDiagnosticsHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  }
  return Object.freeze({ mailDomain, domain });
}

async function scopedLocalMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId }) {
  return scopedMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId, allowExternal: false });
}

async function scopedMailbox({ mailboxRegistry, mailDomainRegistry, domainRegistry, mailboxId, localServerId, allowExternal = false }) {
  const mailbox = typeof mailboxRegistry.getMailbox === 'function'
    ? await mailboxRegistry.getMailbox(mailboxId)
    : (await mailboxRegistry.listMailboxes({})).find((m) => m && m.id === mailboxId) ?? null;
  if (!mailbox) throw new MailDiagnosticsHttpError('mailbox_not_found', 'Mailbox was not found', 404);
  const { mailDomain, domain } = await scopedMailDomain({
    mailDomainRegistry,
    domainRegistry,
    mailDomainId: mailbox.mailDomainId,
    localServerId,
    allowExternal,
  });
  return Object.freeze({ mailbox, mailDomain, domain });
}

function requireManagement(request) {
  if (!request.auth?.security?.managementAllowed) {
    throw new MailDiagnosticsHttpError('forbidden', 'Management permission is required to trigger mail delivery tests', 403);
  }
}

function requireOwner(request) {
  if (request.auth?.user?.role !== 'owner' || !request.auth?.security?.managementAllowed) {
    throw new MailDiagnosticsHttpError('forbidden', 'Only Owner can access server-wide mail diagnostics', 403);
  }
}

function forwardingDiagnostic({
  state,
  externalDestinationCount,
  srsReady,
  deliveryAssurance,
  reasonCode = null,
  action = null,
}) {
  return Object.freeze({
    state,
    externalDestinationCount,
    srsReady,
    deliveryAssurance,
    reasonCode,
    action,
  });
}

async function inspectForwardingDeliverability({
  mailDomain,
  domain,
  mailDomainRegistry,
  mailboxRegistry,
  mailboxForwardingRegistry,
  mailSrsConfigurationService,
}) {
  const [mailboxes, mailDomains, forwardings] = await Promise.all([
    mailboxRegistry.listMailboxes({ mailDomainId: mailDomain.id }),
    mailDomainRegistry.listMailDomains(),
    mailboxForwardingRegistry.materializeEnabledForwardings(),
  ]);
  const enabledMailboxIds = new Set(mailboxes.filter((mailbox) => mailbox.enabled).map((mailbox) => mailbox.id));
  const localEnabledDomains = new Set(mailDomains
    .filter((candidate) => candidate.managementMode === 'local' && candidate.status === 'enabled')
    .map((candidate) => candidate.domainName));
  let externalDestinationCount = 0;
  for (const policy of forwardings) {
    if (!enabledMailboxIds.has(policy.mailboxId)) continue;
    for (const destination of policy.destinations) {
      if (!localEnabledDomains.has(normalizeMailboxAddress(destination).domain)) externalDestinationCount += 1;
    }
  }

  if (externalDestinationCount === 0) {
    return forwardingDiagnostic({
      state: 'not_applicable',
      externalDestinationCount: 0,
      srsReady: null,
      deliveryAssurance: 'not_claimed',
    });
  }
  if (!mailSrsConfigurationService) {
    return forwardingDiagnostic({
      state: 'action_required',
      externalDestinationCount,
      srsReady: false,
      deliveryAssurance: 'not_guaranteed',
      reasonCode: 'mail_forwarding_srs_unavailable',
      action: 'configure_mail_srs',
    });
  }

  let srs;
  try { srs = await mailSrsConfigurationService.previewForServer(domain.serverId); }
  catch {
    return forwardingDiagnostic({
      state: 'inspection_error',
      externalDestinationCount,
      srsReady: false,
      deliveryAssurance: 'not_guaranteed',
      reasonCode: 'mail_forwarding_srs_inspection_failed',
      action: 'retry_mail_dns_diagnostics',
    });
  }
  if (srs?.ready !== true) {
    return forwardingDiagnostic({
      state: 'action_required',
      externalDestinationCount,
      srsReady: false,
      deliveryAssurance: 'not_guaranteed',
      reasonCode: 'mail_forwarding_srs_not_ready',
      action: 'prepare_mail_srs',
    });
  }
  return forwardingDiagnostic({
    state: 'srs_ready',
    externalDestinationCount,
    srsReady: true,
    deliveryAssurance: 'not_guaranteed',
  });
}

function appendForwardingDiagnostic(result, forwardingDeliverability) {
  const diagnostics = Object.freeze({
    ...(result?.diagnostics ?? {}),
    forwardingDeliverability,
  });
  const issues = Array.isArray(result?.issues) ? [...result.issues] : [];
  if (forwardingDeliverability.reasonCode !== null) {
    issues.push(Object.freeze({
      kind: 'forwardingDeliverability',
      reasonCode: forwardingDeliverability.reasonCode,
      action: forwardingDeliverability.action,
    }));
  }
  return Object.freeze({
    ...result,
    diagnostics,
    attentionRequired: issues.length > 0,
    issues: Object.freeze(issues),
  });
}

function appendAntivirusDiagnostic(result, antivirusHealth) {
  if (!antivirusHealth) return result;
  const diagnostics = Object.freeze({
    ...(result?.diagnostics ?? {}),
    antivirus: antivirusHealth,
  });
  const issues = Array.isArray(result?.issues) ? [...result.issues] : [];
  if (antivirusHealth.enabled && !antivirusHealth.active) {
    issues.push(Object.freeze({
      kind: 'antivirus',
      reasonCode: 'mail_antivirus_unhealthy',
      action: 'check_clamav_service',
    }));
  }
  return Object.freeze({
    ...result,
    diagnostics,
    attentionRequired: issues.length > 0,
    issues: Object.freeze(issues),
  });
}

export function mountMailDiagnosticsRoutes(app, {
  mailDiagnosticsInspector,
  mailDkimRegistry,
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailboxForwardingRegistry,
  mailSrsConfigurationService = null,
  mailAntivirusHealthInspector = null,
  panelSettingsRegistry = null,
  localServerId = null,
  mailQueueInspector = null,
  mailProtocolHealthInspector = null,
  journalLogReader = null,
  authMailer = null,
  mailboxQuotaRegistry = null,
  transport = null,
  mailDeliveryDiagnosticsService = null,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('Express application is required');
  if (!mailDiagnosticsInspector || typeof mailDiagnosticsInspector.inspect !== 'function') {
    throw new Error('Mail diagnostics inspector is required');
  }
  if (!mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function') {
    throw new Error('Managed DKIM registry is required');
  }
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.listMailDomains !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.listMailboxes !== 'function'
    || !mailboxForwardingRegistry || typeof mailboxForwardingRegistry.materializeEnabledForwardings !== 'function'
    || (mailSrsConfigurationService !== null && typeof mailSrsConfigurationService.previewForServer !== 'function')) {
    throw new Error('Mail diagnostics scope dependencies are required');
  }

  const deliveryService = mailDeliveryDiagnosticsService ?? createMailDeliveryDiagnosticsService({
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailDkimRegistry,
    mailDiagnosticsInspector,
    mailProtocolHealthInspector,
    mailQueueInspector,
    journalLogReader,
    authMailer,
    mailboxQuotaRegistry,
    localServerId,
    transport,
  });

  app.get('/api/mail-domains/:mailDomainId/diagnostics', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailDomain, domain } = await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const [dkim, forwardingDeliverability] = await Promise.all([
      mailDkimRegistry.getKey(mailDomain.id),
      inspectForwardingDeliverability({
        mailDomain,
        domain,
        mailDomainRegistry,
        mailboxRegistry,
        mailboxForwardingRegistry,
        mailSrsConfigurationService,
      }),
    ]);
    const diagnostics = await mailDiagnosticsInspector.inspect(mailDomain.domainName, { dkim });

    let antivirusHealth = null;
    if (mailAntivirusHealthInspector) {
      let profile = 'disabled';
      if (panelSettingsRegistry && typeof panelSettingsRegistry.getSettings === 'function') {
        try {
          const settings = await panelSettingsRegistry.getSettings();
          profile = settings.mailSecurity?.antivirusProfile ?? 'disabled';
        } catch {
          profile = 'disabled';
        }
      }
      antivirusHealth = await mailAntivirusHealthInspector.inspect({ profile });
    }

    const withForwarding = appendForwardingDiagnostic(diagnostics, forwardingDeliverability);
    const withAntivirus = appendAntivirusDiagnostic(withForwarding, antivirusHealth);
    const connectionSettings = await deliveryService.getConnectionSettings({ mailDomain });

    return response.json({
      data: Object.freeze({
        ...withAntivirus,
        connectionSettings,
      }),
    });
  }));

  app.get('/api/mail-domains/:mailDomainId/delivery-diagnostics', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailDomain } = await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
      allowExternal: true,
    });
    const result = await deliveryService.getMailDomainDeliveryDiagnostics({ mailDomainId: mailDomain.id });
    return response.json({ data: result });
  }));

  app.get('/api/mail-domains/:mailDomainId/connection-settings', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailDomain } = await scopedMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
      allowExternal: true,
    });
    const result = await deliveryService.getConnectionSettings({ mailDomain });
    return response.json({ data: result });
  }));

  app.get('/api/mail-domains/:mailDomainId/queue', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { mailDomain } = await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 100;
    const result = await deliveryService.getQueueStatus({
      mailDomain,
      limit: Number.isSafeInteger(limit) && limit >= 1 && limit <= 200 ? limit : 100,
      search: request.query.q ?? null,
      queueName: request.query.queue ?? null,
    });
    return response.json({ data: result });
  }));

  app.get('/api/mail-domains/:mailDomainId/delivery-logs', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const { mailDomain } = await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 100;
    const service = ['postfix', 'dovecot', 'rspamd'].includes(request.query.service) ? request.query.service : 'postfix';
    const result = await deliveryService.getDeliveryLogs({
      mailDomain,
      service,
      limit: Number.isSafeInteger(limit) && limit >= 1 && limit <= 200 ? limit : 100,
      search: request.query.q ?? null,
    });
    return response.json({ data: result });
  }));

  app.post('/api/mail-domains/:mailDomainId/test-delivery', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireManagement(request);
    const { mailDomain } = await scopedLocalMailDomain({
      mailDomainRegistry,
      domainRegistry,
      mailDomainId: request.params.mailDomainId,
      localServerId,
    });
    const body = request.body ?? {};
    const to = body.recipient ?? body.to;
    if (!to) throw new MailDiagnosticsHttpError('invalid_test_delivery_input', 'Recipient address (recipient or to) is required', 400);
    const result = await deliveryService.sendTestEmail({
      mailDomain,
      to,
      from: body.sender ?? body.from ?? null,
      subject: body.subject ?? null,
      text: body.text ?? null,
      customTransport: body.transport ?? null,
    });
    return response.json({ data: result });
  }));

  app.get('/api/mailboxes/:mailboxId/delivery-diagnostics', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailbox } = await scopedMailbox({
      mailboxRegistry,
      mailDomainRegistry,
      domainRegistry,
      mailboxId: request.params.mailboxId,
      localServerId,
      allowExternal: true,
    });
    const result = await deliveryService.getMailboxDiagnostics({ mailboxId: mailbox.id });
    return response.json({ data: result });
  }));

  app.get('/api/mailboxes/:mailboxId/diagnostics', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailbox } = await scopedMailbox({
      mailboxRegistry,
      mailDomainRegistry,
      domainRegistry,
      mailboxId: request.params.mailboxId,
      localServerId,
      allowExternal: true,
    });
    const result = await deliveryService.getMailboxDiagnostics({ mailboxId: mailbox.id });
    return response.json({ data: result });
  }));

  app.get('/api/mailboxes/:mailboxId/connection-settings', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailbox, mailDomain } = await scopedMailbox({
      mailboxRegistry,
      mailDomainRegistry,
      domainRegistry,
      mailboxId: request.params.mailboxId,
      localServerId,
      allowExternal: true,
    });
    const result = await deliveryService.getConnectionSettings({ mailDomain, mailbox });
    return response.json({ data: result });
  }));

  app.post('/api/mailboxes/:mailboxId/test-delivery', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireManagement(request);
    const { mailbox, mailDomain } = await scopedMailbox({
      mailboxRegistry,
      mailDomainRegistry,
      domainRegistry,
      mailboxId: request.params.mailboxId,
      localServerId,
      allowExternal: false,
    });
    const body = request.body ?? {};
    const to = body.recipient ?? body.to;
    if (!to) throw new MailDiagnosticsHttpError('invalid_test_delivery_input', 'Recipient address (recipient or to) is required', 400);
    const result = await deliveryService.sendTestEmail({
      mailDomain,
      mailbox,
      to,
      from: body.sender ?? body.from ?? mailbox.address,
      subject: body.subject ?? null,
      text: body.text ?? null,
      customTransport: body.transport ?? null,
    });
    return response.json({ data: result });
  }));

  app.get('/api/servers/:serverId/mail/delivery-diagnostics', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireOwner(request);
    const result = await deliveryService.getServiceDiagnostics({ serverId: request.params.serverId });
    return response.json({ data: result });
  }));

  app.get('/api/servers/:serverId/mail/connection-settings', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireOwner(request);
    const result = await deliveryService.getServiceDiagnostics({ serverId: request.params.serverId });
    return response.json({ data: result });
  }));

  app.post('/api/servers/:serverId/mail/test-delivery', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireOwner(request);
    const body = request.body ?? {};
    const to = body.recipient ?? body.to;
    if (!to) {
      throw new MailDiagnosticsHttpError('invalid_test_delivery_input', 'Recipient address (recipient or to) is required', 400);
    }
    let mailDomain = null;
    if (body.mailDomainId) {
      const scoped = await scopedLocalMailDomain({
        mailDomainRegistry,
        domainRegistry,
        mailDomainId: body.mailDomainId,
        localServerId,
      });
      mailDomain = scoped.mailDomain;
    } else {
      const all = await mailDomainRegistry.listMailDomains();
      mailDomain = all.find((d) => d && d.managementMode === 'local' && d.status === 'enabled') ?? null;
      if (!mailDomain) throw new MailDiagnosticsHttpError('no_local_mail_domain', 'At least one local mail domain is required for test delivery', 400);
    }
    const result = await deliveryService.sendTestEmail({
      mailDomain,
      to,
      from: body.sender ?? body.from ?? null,
      subject: body.subject ?? null,
      text: body.text ?? null,
      customTransport: body.transport ?? null,
    });
    return response.json({ data: result });
  }));
}

export const mailDiagnosticsHttpInternals = Object.freeze({
  emptyQuery,
  scopedLocalMailDomain,
  scopedMailDomain,
  scopedMailbox,
  inspectForwardingDeliverability,
  appendForwardingDiagnostic,
  appendAntivirusDiagnostic,
  MAIL_PROTOCOLS,
  MAIL_PORTS_SUMMARY,
  MAIL_PORT_TLS_REQUIREMENTS,
});
