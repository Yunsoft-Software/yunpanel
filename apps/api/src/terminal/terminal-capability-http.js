import path from 'node:path';
import { DockerContainerConsoleInspectorError } from '@yunpanel/host-runtime';
import { dockerComposeApiRequestContext } from '../docker/docker-compose-api-handler.js';
import { requirePanelRouteAccess } from '../http/panel-http-guard.js';
import { TerminalCapabilityError } from './terminal-capability-registry.js';

const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const SITE_ROOTS = ['/var/www/yunpanel/apps/', '/var/lib/yunpanel/apps/'];

function projectScopedVolumeKeys(project) {
  const details = Array.isArray(project?.volumeDetails) ? project.volumeDetails : null;
  if (details) {
    return details
      .filter((entry) => entry && entry.external !== true && entry.scope === 'project'
        && typeof entry.name === 'string' && entry.runtimeName === `${project.projectName}_${entry.name}`)
      .map((entry) => entry.name);
  }
  return Array.isArray(project?.volumes) ? project.volumes.filter((name) => typeof name === 'string') : [];
}

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
  dockerComposeProjectRegistry = null,
  dockerContainerConsoleInspector = null,
  localServerId,
  licenseEntitlementService = null,
} = {}) {
  if (!terminalCapabilityRegistry) return;
  if (!serverRegistry || !websiteRegistry || typeof terminalCapabilityRegistry.issue !== 'function') {
    throw new TypeError('Terminal capability HTTP dependencies are required');
  }

  app.post('/api/terminal/capabilities', requirePanelRouteAccess, async (request, response) => {
    const auth = request.auth;
    const siteCapable = ['owner', 'site_manager', 'reseller', 'customer'].includes(auth?.user?.role)
      || auth?.user?.hosting?.kind === 'reseller'
      || auth?.user?.hosting?.kind === 'customer';
    if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string' || !siteCapable) {
      throw new TerminalCapabilityError('terminal_session_invalid', 'Terminal requires an authenticated session', 401);
    }
    if (auth.user.active === false || auth.user.active === 0) {
      throw new TerminalCapabilityError('tenant_actor_inactive', 'Inactive account cannot access terminal', 403);
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
      const isOwner = auth.user.role === 'owner';
      if (!isOwner && (!Array.isArray(auth.user.websiteIds) || !auth.user.websiteIds.includes(request.body.websiteId))) {
        throw new TerminalCapabilityError('terminal_site_forbidden', 'You do not have access to this website terminal', 403);
      }
      if (!isOwner && licenseEntitlementService) {
        const isReseller = auth.user.role === 'reseller' || auth.user.hosting?.kind === 'reseller';
        if (isReseller) {
          licenseEntitlementService.requireCapability(
            'resellerAccounts',
            'Reseller panel terminal access requires an active YunPanel Premium license.',
          );
        }
        licenseEntitlementService.requireCapability(
          'perSiteIsolatedUsers',
          'Separate customer and site-user panel terminal access requires an active YunPanel Premium license.',
        );
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
    } else if (request.body?.scope === 'docker_container'
      && exactBody(request.body, ['scope', 'dockerProjectId', 'containerId'])) {
      const isOwnerManagement = auth.user.role === 'owner'
        && auth.access?.mode === 'management'
        && auth.security?.managementAllowed === true
        && Array.isArray(auth.access?.permissions)
        && auth.access.permissions.includes('*');
      if (!isOwnerManagement) {
        throw new TerminalCapabilityError(
          'terminal_docker_container_forbidden',
          'Only server owner can access container console',
          403,
        );
      }
      const resolvedProjectRegistry = request[dockerComposeApiRequestContext]?.projectRegistry ?? dockerComposeProjectRegistry;
      const resolvedConsoleInspector = request[dockerComposeApiRequestContext]?.containerConsoleInspector ?? dockerContainerConsoleInspector;
      if (!resolvedProjectRegistry || typeof resolvedProjectRegistry.getProject !== 'function'
        || !resolvedConsoleInspector || typeof resolvedConsoleInspector.inspectContainer !== 'function') {
        throw new TerminalCapabilityError(
          'terminal_docker_console_unavailable',
          'Container console is not available on this server',
          503,
        );
      }
      if (typeof request.body.containerId !== 'string' || !CONTAINER_ID_PATTERN.test(request.body.containerId)) {
        throw new TerminalCapabilityError(
          'container_console_id_invalid',
          'Docker container ID must be a 64-character hex identifier',
          400,
        );
      }
      let project;
      try {
        project = await resolvedProjectRegistry.getProject(request.body.dockerProjectId);
      } catch {
        throw new TerminalCapabilityError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
      }
      if (!project) {
        throw new TerminalCapabilityError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
      }
      localTarget(project.serverId, localServerId);
      let inspected;
      try {
        inspected = await resolvedConsoleInspector.inspectContainer({
          projectId: project.id,
          projectName: project.projectName,
          allowedServices: (project.services ?? []).map((service) => service.name),
          allowedVolumes: projectScopedVolumeKeys(project),
          containerId: request.body.containerId,
          probeShell: true,
        });
      } catch (error) {
        if (error instanceof DockerContainerConsoleInspectorError) {
          throw new TerminalCapabilityError(error.code, error.message, error.status ?? 409);
        }
        throw error;
      }
      target = {
        scope: 'docker_container',
        serverId: project.serverId,
        dockerProjectId: project.id,
        projectName: inspected.projectName,
        serviceName: inspected.serviceName,
        containerId: inspected.containerId,
        containerName: inspected.containerName,
        user: inspected.user,
        uid: inspected.uid,
        gid: inspected.gid,
        cwd: inspected.cwd,
        shell: inspected.shell,
      };
    } else {
      throw new TerminalCapabilityError('terminal_capability_request_invalid', 'Choose exactly one local Server, Website or Container terminal target');
    }

    return response.status(201).json({
      data: terminalCapabilityRegistry.issue({ sessionId: auth.id, userId: auth.user.id, target }),
    });
  });
}

export const terminalCapabilityHttpInternals = Object.freeze({ managedSiteCwd, localTarget, projectScopedVolumeKeys });
