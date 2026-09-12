import { MailboxForwardingRegistryError } from './mailbox-forwarding-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const SET_FIELDS = new Set(['expectedRevision', 'mode', 'destinations', 'enabled']);
const CLEAR_FIELDS = new Set(['expectedRevision', 'confirmation']);

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailboxForwardingRegistryError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailboxForwardingRegistryError(
      'mailbox_forwarding_query_invalid',
      'Mailbox forwarding operation does not accept query parameters',
    );
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

export function mountMailboxForwardingRoutes(app, {
  mailboxForwardingRegistry,
  mailboxRegistry,
  mailDomainRegistry,
  domainRegistry,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.put !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailboxForwardingRegistry || typeof mailboxForwardingRegistry.getForwarding !== 'function'
    || typeof mailboxForwardingRegistry.setForwarding !== 'function'
    || typeof mailboxForwardingRegistry.clearForwarding !== 'function') {
    throw new Error('Mailbox forwarding registry is required');
  }
  if (!mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function') {
    throw new Error('Mailbox forwarding scope dependencies are required');
  }

  async function scopedMailbox(mailboxId) {
    const mailbox = await mailboxRegistry.getMailbox(mailboxId);
    if (!mailbox) {
      throw new MailboxForwardingRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
    }
    const mailDomain = await mailDomainRegistry.getMailDomain(mailbox.mailDomainId);
    if (!mailDomain || mailDomain.managementMode !== 'local') {
      throw new MailboxForwardingRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
    }
    if (localServerId !== null) {
      const domain = mailDomain.webDomainId ? await domainRegistry.getDomain(mailDomain.webDomainId) : null;
      if (!domain || domain.serverId !== localServerId) {
        throw new MailboxForwardingRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      }
    }
    return Object.freeze({ mailbox, mailDomain });
  }

  app.get('/api/mailboxes/:mailboxId/forwarding', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await scopedMailbox(request.params.mailboxId);
    return response.json({ data: await mailboxForwardingRegistry.getForwarding(request.params.mailboxId) });
  }));

  app.put('/api/mailboxes/:mailboxId/forwarding', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, SET_FIELDS, 'mailbox_forwarding_set_input_invalid');
    await scopedMailbox(request.params.mailboxId);
    const policy = await mailboxForwardingRegistry.setForwarding(request.params.mailboxId, body);
    return response.json({ data: policy, sideEffects: policySideEffects });
  }));

  app.delete('/api/mailboxes/:mailboxId/forwarding', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, CLEAR_FIELDS, 'mailbox_forwarding_clear_input_invalid');
    await scopedMailbox(request.params.mailboxId);
    await mailboxForwardingRegistry.clearForwarding(request.params.mailboxId, body);
    return response.json({
      data: { mailboxId: request.params.mailboxId, forwardingConfigured: false },
      sideEffects: policySideEffects,
    });
  }));
}

export const mailboxForwardingHttpInternals = Object.freeze({
  exactBody,
  emptyQuery,
  policySideEffects,
});
