import path from 'node:path';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { TerminalCapabilityError } from './terminal-capability-registry.js';

const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const SITE_ROOTS = ['/var/www/yunpanel/apps/', '/var/lib/yunpanel/apps/'];

function exactBody(body, fields) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === fields.length
    && Object.keys(body).every((key) => fields.includes(key));
}

function localTarget(serverId, localServerId) {
  if (typeof localServerId !== 'string' || !localServerId) {
    throw new TerminalCapabilityError('terminal_local_runtime_required', 'Terminal is available only on the active local server', 503);
  }
  if (serverId !== localServerId) {
    throw new TerminalCapabilityError('terminal_remote_server_unsupported', 'Remote server terminal is not supported', 409);
  }
}

function managedSiteCwd(website) {
  if (!['static', 'node', 'php'].includes(website.runtimeType)
    || !APP_USER_PATTERN.test(website.unixUser ?? '')) {
    throw new TerminalCapabilityError('site_terminal_unsupported', 'This Website does not have an isolated site user', 409);
  }
  const documentRoot = path.posix.normalize(website.documentRoot ?? '');
  if (!SITE_ROOTS.some((root) => documentRoot.startsWith(root))) {
    throw new TerminalCapabilityError('site_terminal_target_invalid', 'Website terminal directory is outside managed application storage', 409);
  }
  const cwd = website.runtimeType === 'php'
    ? (documentRoot.endsWith('/current/public') ? path.posix.dirname(documentRoot) : null)
    : (documentRoot.endsWith('/current') ? documentRoot : null);
  if (!cwd || !cwd.endsWith('/current')) {
    throw new TerminalCapabilityError('site_terminal_target_invalid', 'Website terminal directory is outside managed application storage', 409);
  }
  return cwd;
}

export function mountTerminalCapabilityRoutes(app, {
  terminalCapabilityRegistry,
  serverRegistry,
  websiteRegistry,
  localServerId,
} = {}) {
  if (!terminalCapabilityRegistry) return;
  if (!serverRegistry || !websiteRegistry || typeof terminalCapabilityRegistry.issue !== 'function') {
    throw new TypeError('Terminal capability HTTP dependencies are required');
  }

  app.post('/api/terminal/capabilities', requirePanelRouteAccess, async (request, response) => {
    const auth = request.auth;
    if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string' || !['owner', 'site_manager'].includes(auth.user.role)) {
      throw new TerminalCapabilityError('terminal_session_invalid', 'Terminal requires an authenticated session', 401);
    }
    let target;
    if (request.body?.scope === 'server' && exactBody(request.body, ['scope', 'serverId'])) {
      if (auth.user.role !== 'owner') {
        throw new TerminalCapabilityError('terminal_server_forbidden', 'Only server owner can access root terminal', 403);
      }
      const server = await serverRegistry.getServer(request.body.serverId);
      if (!server) throw new TerminalCapabilityError('server_not_found', 'Server not found', 404);
      localTarget(server.id, localServerId);
      target = { scope: 'server', serverId: server.id, user: 'root', cwd: '/root' };
    } else if (request.body?.scope === 'site' && exactBody(request.body, ['scope', 'websiteId'])) {
      if (auth.user.role === 'site_manager' && (!Array.isArray(auth.user.websiteIds) || !auth.user.websiteIds.includes(request.body.websiteId))) {
        throw new TerminalCapabilityError('terminal_site_forbidden', 'You do not have access to this website terminal', 403);
      }
      const website = await websiteRegistry.getWebsite(request.body.websiteId);
      if (!website) throw new TerminalCapabilityError('website_not_found', 'Website not found', 404);
      localTarget(website.serverId, localServerId);
      target = {
        scope: 'site',
        serverId: website.serverId,
        websiteId: website.id,
        user: website.unixUser,
        cwd: managedSiteCwd(website),
      };
    } else {
      throw new TerminalCapabilityError('terminal_capability_request_invalid', 'Choose exactly one local Server or Website terminal target');
    }

    return response.status(201).json({
      data: terminalCapabilityRegistry.issue({ sessionId: auth.id, userId: auth.user.id, target }),
    });
  });
}

export const terminalCapabilityHttpInternals = Object.freeze({ managedSiteCwd, localTarget });
