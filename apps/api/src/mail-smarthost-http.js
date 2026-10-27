import { MailTemplateError, renderSmarthost } from '@yunpanel/config-templates';
import { currentAuditActorId } from './audit-request-context.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

// Owner-only: a server-wide outbound relay. requirePanelRouteAccess lets site-scoped
// roles through most routes, so ownership is enforced here explicitly.
const APPLY_CONFIRMATION = 'smarthost-apply';

function requireOwner(request, response, next) {
  const auth = request.auth;
  if (auth?.user?.role === 'owner' && auth.access?.mode === 'management') return next();
  return response.status(403).json({ error: { code: 'forbidden', message: 'Only the Owner can manage the mail relay.' } });
}
const DISABLE_CONFIRMATION = 'smarthost-disable';

export class MailSmarthostHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailSmarthostHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof MailTemplateError) error.status = 400;
      return next(error);
    }
  };
}

export function mountMailSmarthostRoutes(app, { registry, smarthostRegistry, smarthostManager, localServerId = null, audit = null } = {}) {
  if (!app || !registry || !smarthostRegistry || !smarthostManager) throw new Error('Mail smarthost routes require their registries and manager');
  let queue = Promise.resolve();
  // Applies are serialized: two operators saving at once must not interleave postconf writes.
  const exclusive = (operation) => { const run = queue.then(operation, operation); queue = run.catch(() => {}); return run; };

  async function localServer(serverId) {
    const server = await registry.getServer(serverId);
    if (!server) throw new MailSmarthostHttpError('server_not_found', 'Server not found', 404);
    if (!localServerId || server.id !== localServerId || server.executionMode !== 'local') {
      throw new MailSmarthostHttpError('remote_mail_unavailable', 'Relay settings are available only for this panel\'s local server', 409);
    }
    return server;
  }

  async function record(action, serverId, outcome, code = null) {
    if (!audit || typeof audit.record !== 'function') return;
    await audit.record({ actorId: currentAuditActorId() ?? 'unknown', action, resourceType: 'mail_smarthost', resourceId: serverId, outcome, code });
  }

  app.get('/api/servers/:serverId/mail/smarthost', requirePanelRouteAccess, requireOwner, asyncRoute(async (request, response) => {
    const server = await localServer(request.params.serverId);
    response.setHeader('cache-control', 'no-store');
    return response.json({ data: { ...(await smarthostRegistry.get(server.id)), live: await smarthostManager.status() } });
  }));

  app.put('/api/servers/:serverId/mail/smarthost', requirePanelRouteAccess, requireOwner, asyncRoute(async (request, response) => {
    const server = await localServer(request.params.serverId);
    const { confirmation, password = '', ...fields } = request.body ?? {};
    if (confirmation !== APPLY_CONFIRMATION) throw new MailSmarthostHttpError('smarthost_confirmation_required', 'Confirm the relay change to apply it');
    const result = await exclusive(async () => {
      // An empty password keeps the stored one; the UI can never read it back.
      const secret = password || await smarthostRegistry.password(server.id);
      if (!secret) throw new MailSmarthostHttpError('smarthost_password_required', 'A relay password is required');
      const plan = renderSmarthost({ ...fields, password: secret });
      try { await smarthostManager.apply(plan); }
      catch (error) { await record('mail.smarthost.apply', server.id, 'failure', error?.code ?? 'smarthost_apply_failed'); throw error; }
      const saved = await smarthostRegistry.save(server.id, { host: fields.host.toLowerCase(), port: fields.port, username: fields.username, password: secret });
      await record('mail.smarthost.apply', server.id, 'success');
      return saved;
    });
    return response.json({ data: result });
  }));

  app.delete('/api/servers/:serverId/mail/smarthost', requirePanelRouteAccess, requireOwner, asyncRoute(async (request, response) => {
    const server = await localServer(request.params.serverId);
    if (request.body?.confirmation !== DISABLE_CONFIRMATION) throw new MailSmarthostHttpError('smarthost_confirmation_required', 'Confirm turning off the relay');
    await exclusive(async () => {
      try { await smarthostManager.disable(); }
      catch (error) { await record('mail.smarthost.disable', server.id, 'failure', error?.code ?? 'smarthost_disable_failed'); throw error; }
      await smarthostRegistry.remove(server.id);
      await record('mail.smarthost.disable', server.id, 'success');
    });
    return response.json({ data: { configured: false } });
  }));
}

export const mailSmarthostHttpInternals = Object.freeze({ APPLY_CONFIRMATION, DISABLE_CONFIRMATION });
