import { normalizeMailboxAddress } from '@yunpanel/config-templates';
import { MailboxRegistryError } from './mailbox-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['mailDomainId', 'address', 'password']);
const ROTATE_FIELDS = new Set(['expectedRevision', 'password']);
const UPDATE_FIELDS = new Set(['expectedRevision', 'enabled']);
const DELETE_FIELDS = new Set(['expectedRevision', 'confirmation']);
const FINALIZE_DELETE_FIELDS = new Set(['expectedRevision', 'deleteJobId', 'confirmation']);

function exactBody(body, fields, code) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((field) => !fields.has(field))) {
    throw new MailboxRegistryError(code, `Request must contain exactly ${[...fields].join(', ')}`);
  }
  return body;
}

function listFilter(query) {
  if (Object.keys(query ?? {}).some((field) => field !== 'mailDomainId') || Array.isArray(query?.mailDomainId)) {
    throw new MailboxRegistryError('mailbox_query_invalid', 'Mailbox list accepts only one mailDomainId filter');
  }
  return { mailDomainId: query?.mailDomainId || null };
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new MailboxRegistryError('mailbox_query_invalid', 'Mailbox operation does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

const noHostSideEffects = Object.freeze({ mailConfigurationChanged: false, mailDataChanged: false });

export function mountMailboxRoutes(app, {
  mailboxRegistry,
  mailAliasRegistry = null,
  mailboxQuotaRegistry = null,
  mailboxForwardingRegistry = null,
  mailDomainRegistry = null,
  domainRegistry = null,
  mailDeleteFinalizeService = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || typeof app.patch !== 'function' || typeof app.delete !== 'function') {
    throw new Error('Express application is required');
  }
  if (!mailboxRegistry || typeof mailboxRegistry.createMailbox !== 'function'
    || typeof mailboxRegistry.listMailboxes !== 'function' || typeof mailboxRegistry.getMailbox !== 'function'
    || typeof mailboxRegistry.rotatePassword !== 'function' || typeof mailboxRegistry.setEnabled !== 'function'
    || typeof mailboxRegistry.deleteMailbox !== 'function') {
    throw new Error('Mailbox registry is required');
  }
  if (mailAliasRegistry !== null && typeof mailAliasRegistry.listAliases !== 'function') {
    throw new Error('Mail alias registry is invalid');
  }
  if (mailboxQuotaRegistry !== null && typeof mailboxQuotaRegistry.getQuota !== 'function') {
    throw new Error('Mailbox quota registry is invalid');
  }
  if (mailboxForwardingRegistry !== null && typeof mailboxForwardingRegistry.getForwarding !== 'function') {
    throw new Error('Mailbox forwarding registry is invalid');
  }
  if (mailDeleteFinalizeService !== null && typeof mailDeleteFinalizeService.finalizeMailbox !== 'function') {
    throw new Error('Mailbox delete finalizer is invalid');
  }
  if (localServerId !== null && (!mailDomainRegistry || !domainRegistry)) {
    throw new Error('Local mailbox scope dependencies are required');
  }
  if (localServerId !== null && !mailDeleteFinalizeService) {
    throw new Error('Local mailbox deletion requires the guarded mail data finalizer');
  }

  async function localMailDomain(mailDomainId) {
    const mailDomain = await mailDomainRegistry?.getMailDomain(mailDomainId);
    const domain = mailDomain?.webDomainId ? await domainRegistry?.getDomain(mailDomain.webDomainId) : null;
    if (localServerId !== null && domain?.serverId !== localServerId) {
      throw new MailboxRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    }
    return mailDomain;
  }

  async function localMailbox(mailboxId) {
    const mailbox = await mailboxRegistry.getMailbox(mailboxId);
    if (!mailbox) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
    await localMailDomain(mailbox.mailDomainId);
    return mailbox;
  }

  async function assertAliasSourceAvailable(mailDomainId, requestedAddress) {
    if (!mailAliasRegistry) return;
    let canonical;
    try { canonical = normalizeMailboxAddress(requestedAddress).address; }
    catch { return; }
    let aliases;
    try { aliases = await mailAliasRegistry.listAliases({ mailDomainId }); }
    catch {
      throw new MailboxRegistryError('mail_alias_state_unavailable', 'Mail alias state could not be verified', 503);
    }
    if (!Array.isArray(aliases)) {
      throw new MailboxRegistryError('mail_alias_state_unavailable', 'Mail alias state could not be verified', 503);
    }
    if (aliases.some((alias) => alias?.source === canonical)) {
      throw new MailboxRegistryError(
        'mailbox_alias_conflict',
        'An address cannot be both a mailbox and a mail alias source',
        409,
      );
    }
  }

  async function assertDeleteDependenciesCleared(mailboxId) {
    if (mailboxQuotaRegistry && await mailboxQuotaRegistry.getQuota(mailboxId)) {
      throw new MailboxRegistryError(
        'mailbox_delete_quota_configured',
        'Mailbox quota must be cleared before deleting the mailbox',
        409,
      );
    }
    if (mailboxForwardingRegistry && await mailboxForwardingRegistry.getForwarding(mailboxId)) {
      throw new MailboxRegistryError(
        'mailbox_delete_forwarding_configured',
        'Mailbox forwarding must be cleared before deleting the mailbox',
        409,
      );
    }
  }

  app.get('/api/mailboxes', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const filter = listFilter(request.query);
    if (localServerId !== null && filter.mailDomainId) await localMailDomain(filter.mailDomainId);
    const mailboxes = await mailboxRegistry.listMailboxes(filter);
    if (localServerId === null) return response.json({ data: mailboxes });
    const local = await Promise.all(mailboxes.map(async (mailbox) => {
      const mailDomain = await mailDomainRegistry.getMailDomain(mailbox.mailDomainId);
      const domain = mailDomain?.webDomainId ? await domainRegistry.getDomain(mailDomain.webDomainId) : null;
      return domain?.serverId === localServerId ? mailbox : null;
    }));
    return response.json({ data: local.filter(Boolean) });
  }));

  app.get('/api/mailboxes/:mailboxId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await localMailbox(request.params.mailboxId) });
  }));

  app.post('/api/mailboxes', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, CREATE_FIELDS, 'mailbox_create_input_invalid');
    await localMailDomain(body.mailDomainId);
    await assertAliasSourceAvailable(body.mailDomainId, body.address);
    const mailbox = await mailboxRegistry.createMailbox(body);
    return response.status(201).json({ data: mailbox, sideEffects: noHostSideEffects });
  }));

  app.post('/api/mailboxes/:mailboxId/password', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, ROTATE_FIELDS, 'mailbox_password_input_invalid');
    await localMailbox(request.params.mailboxId);
    const mailbox = await mailboxRegistry.rotatePassword(request.params.mailboxId, body);
    return response.json({ data: mailbox, sideEffects: noHostSideEffects });
  }));

  app.patch('/api/mailboxes/:mailboxId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const body = exactBody(request.body, UPDATE_FIELDS, 'mailbox_update_input_invalid');
    await localMailbox(request.params.mailboxId);
    const mailbox = await mailboxRegistry.setEnabled(request.params.mailboxId, body);
    return response.json({ data: mailbox, sideEffects: noHostSideEffects });
  }));

  app.delete('/api/mailboxes/:mailboxId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    await localMailbox(request.params.mailboxId);
    if (mailDeleteFinalizeService) {
      const body = exactBody(request.body, FINALIZE_DELETE_FIELDS, 'mailbox_delete_input_invalid');
      const result = await mailDeleteFinalizeService.finalizeMailbox({ mailboxId: request.params.mailboxId, ...body });
      return response.json({ data: result, sideEffects: noHostSideEffects });
    }
    const body = exactBody(request.body, DELETE_FIELDS, 'mailbox_delete_input_invalid');
    await assertDeleteDependenciesCleared(request.params.mailboxId);
    await mailboxRegistry.deleteMailbox(request.params.mailboxId, body);
    return response.json({
      data: { id: request.params.mailboxId, deleted: true },
      sideEffects: noHostSideEffects,
    });
  }));
}

export const mailboxHttpInternals = Object.freeze({
  exactBody,
  listFilter,
  emptyQuery,
  noHostSideEffects,
  finalizeDeleteFields: Object.freeze([...FINALIZE_DELETE_FIELDS]),
});
