import { MailboxQuotaRegistryError } from './mailbox-quota-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const SET_FIELDS = new Set(['expectedRevision', 'quotaBytes']);
const CLEAR_FIELDS = new Set(['expectedRevision', 'confirmation']);

export class MailboxQuotaHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailboxQuotaHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailboxQuotaRegistryError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailboxQuotaRegistryError('mailbox_quota_query_invalid', 'Mailbox quota operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

const policySideEffects = Object.freeze({
  mailConfigurationChanged: false,
  mailDataChanged: false,
  requiresConfigurationApply: true,
});

export function mountMailboxQuotaRoutes(app, {
  mailboxQuotaRegistry,
  mailboxQuotaInspector,
  mailboxRegistry,
  mailDomainRegistry,
  domainRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.put !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailboxQuotaRegistry || typeof mailboxQuotaRegistry.getQuota !== 'function'
    || typeof mailboxQuotaRegistry.setQuota !== 'function' || typeof mailboxQuotaRegistry.clearQuota !== 'function') {
    throw new Error('Mailbox quota registry is required');
  }
  if (!mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function') {
    throw new Error('Mailbox quota scope dependencies are required');
  }
  if (!mailboxQuotaInspector || typeof mailboxQuotaInspector.inspect !== 'function') {
    throw new Error('Mailbox quota usage inspector is required');
  }

  async function scopedMailbox(mailboxId) {
    const mailbox = await mailboxRegistry.getMailbox(mailboxId);
    if (!mailbox) throw new MailboxQuotaRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
    const mailDomain = await mailDomainRegistry.getMailDomain(mailbox.mailDomainId);
    if (!mailDomain || mailDomain.managementMode !== 'local') {
      throw new MailboxQuotaRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
    }
    if (localServerId !== null) {
      const domain = mailDomain.webDomainId ? await domainRegistry.getDomain(mailDomain.webDomainId) : null;
      if (!domain || domain.serverId !== localServerId) {
        throw new MailboxQuotaRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      }
    }
    return Object.freeze({ mailbox, mailDomain });
  }

  app.get('/api/mailboxes/:mailboxId/quota', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await scopedMailbox(request.params.mailboxId);
    return response.json({ data: await mailboxQuotaRegistry.getQuota(request.params.mailboxId) });
  }));

  app.put('/api/mailboxes/:mailboxId/quota', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, SET_FIELDS, 'mailbox_quota_set_input_invalid');
    await scopedMailbox(request.params.mailboxId);
    const policy = await mailboxQuotaRegistry.setQuota(request.params.mailboxId, body);
    return response.json({ data: policy, sideEffects: policySideEffects });
  }));

  app.delete('/api/mailboxes/:mailboxId/quota', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, CLEAR_FIELDS, 'mailbox_quota_clear_input_invalid');
    await scopedMailbox(request.params.mailboxId);
    await mailboxQuotaRegistry.clearQuota(request.params.mailboxId, body);
    return response.json({
      data: { mailboxId: request.params.mailboxId, quotaConfigured: false },
      sideEffects: policySideEffects,
    });
  }));

  app.get('/api/mailboxes/:mailboxId/usage', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const { mailbox, mailDomain } = await scopedMailbox(request.params.mailboxId);
    if (!mailbox.enabled || mailDomain.status !== 'enabled') {
      throw new MailboxQuotaHttpError(
        'mailbox_quota_usage_unavailable',
        'Mailbox quota usage is available only while the mailbox and local mail domain are enabled',
        409,
      );
    }
    try {
      return response.json({ data: await mailboxQuotaInspector.inspect(mailbox.address) });
    } catch {
      throw new MailboxQuotaHttpError(
        'mailbox_quota_usage_unavailable',
        'Mailbox quota usage could not be read from Dovecot',
        503,
      );
    }
  }));
}

export const mailboxQuotaHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  policySideEffects,
});
