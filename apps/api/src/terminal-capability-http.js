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
  if (!['static', 'node'].includes(website.runtimeType) || !APP_USER_PATTERN.test(website.unixUser ?? '')) {
    throw new TerminalCapabilityError('site_terminal_unsupported', 'This Website does not have an isolated site user', 409);
  }
  const cwd = path.posix.normalize(website.documentRoot ?? '');
  if (!SITE_ROOTS.some((root) => cwd.startsWith(root)) || !cwd.endsWith('/current')) {
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
    if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string' || auth.user.role !== 'owner') {
      throw new TerminalCapabilityError('terminal_session_invalid', 'Terminal requires an authenticated Owner session', 401);
    }
    let target;
    if (request.body?.scope === 'server' && exactBody(request.body, ['scope', 'serverId'])) {
      const server = await serverRegistry.getServer(request.body.serverId);
      if (!server) throw new TerminalCapabilityError('server_not_found', 'Server not found', 404);
      localTarget(server.id, localServerId);
      target = { scope: 'server', serverId: server.id, user: 'root', cwd: '/root' };
    } else if (request.body?.scope === 'site' && exactBody(request.body, ['scope', 'websiteId'])) {
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
