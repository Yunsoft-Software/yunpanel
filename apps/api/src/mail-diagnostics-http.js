import { normalizeMailboxAddress } from '@yunpanel/config-templates';
import { requirePanelRouteAccess } from './panel-http-guard.js';

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
    catch (error) { return next(error); }
  };
}

async function scopedLocalMailDomain({ mailDomainRegistry, domainRegistry, mailDomainId, localServerId }) {
  const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
  if (!mailDomain) throw new MailDiagnosticsHttpError('mail_domain_not_found', 'Mail domain was not found', 404);
  if (mailDomain.managementMode !== 'local') {
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

export function mountMailDiagnosticsRoutes(app, {
  mailDiagnosticsInspector,
  mailDkimRegistry,
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailboxForwardingRegistry,
  mailSrsConfigurationService = null,
  localServerId = null,
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
    return response.json({
      data: appendForwardingDiagnostic(diagnostics, forwardingDeliverability),
    });
  }));
}

export const mailDiagnosticsHttpInternals = Object.freeze({
  emptyQuery,
  scopedLocalMailDomain,
  inspectForwardingDeliverability,
  appendForwardingDiagnostic,
});
