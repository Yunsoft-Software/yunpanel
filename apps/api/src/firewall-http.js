import { requirePanelRouteAccess } from './panel-http-guard.js';
import { FirewallServiceError } from './firewall-service.js';
import { NftablesManagerError } from '@yunpanel/host-runtime';

export class FirewallHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'FirewallHttpError';
    this.code = code;
    this.status = status;
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      return await handler(request, response);
    } catch (error) {
      if (error instanceof FirewallServiceError || error instanceof NftablesManagerError || error instanceof FirewallHttpError) {
        return response.status(error.status ?? 400).json({
          error: {
            code: error.code ?? 'firewall_error',
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
      }
      return next(error);
    }
  };
}

function requireOwnerRole(request, response, next) {
  const user = request.auth?.user;
  if (!user || user.role !== 'owner') {
    return response.status(403).json({
      error: { code: 'forbidden', message: 'Owner permissions required for firewall operations.' },
    });
  }
  return next();
}

function requireReadAccess(request, response, next) {
  const user = request.auth?.user;
  if (!user) {
    return response.status(401).json({
      error: { code: 'unauthorized', message: 'Authentication required.' },
    });
  }
  if (user.role === 'owner' || user.role === 'read_only') {
    return next();
  }
  return response.status(403).json({
    error: { code: 'forbidden', message: 'Site-scoped role cannot access firewall management.' },
  });
}

async function resolveServer(registry, serverId, localServerId) {
  const targetId = (!serverId || serverId === 'local') ? (localServerId || 'local') : serverId;
  if (!registry || typeof registry.getServer !== 'function') {
    return { id: targetId };
  }
  try {
    const server = await registry.getServer(targetId);
    if (server) return server;
  } catch {
    // fallback if lookup fails
  }
  return { id: targetId };
}

export function mountFirewallRoutes(app, {
  firewallService,
  registry = null,
  localServerId = null,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('Express application is required');
  }
  if (!firewallService || typeof firewallService.getStatus !== 'function') {
    throw new TypeError('Firewall service is required');
  }

  // --- Handlers ---

  async function handleGetStatus(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const status = await firewallService.getStatus({ serverId: server.id });
    return response.json({ data: status });
  }

  async function handlePreview(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { candidateRuleset, allowedSshPorts, sshPorts, sshPort, renderOptions, enabled } = request.body ?? {};

    const preview = await firewallService.previewMutation({
      candidateRuleset,
      allowedSshPorts,
      sshPorts,
      sshPort,
      renderOptions,
      enabled,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: preview });
  }

  async function handleApply(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const {
      candidateRuleset,
      allowedSshPorts,
      sshPorts,
      sshPort,
      timeoutSeconds,
      renderOptions,
      enabled,
      skipConfirmation,
    } = request.body ?? {};

    const result = await firewallService.applyMutation({
      candidateRuleset,
      allowedSshPorts,
      sshPorts,
      sshPort,
      timeoutSeconds,
      renderOptions,
      enabled,
      skipConfirmation,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleVerifyConnection(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { pendingId, host, port, timeoutMs, clientEvidence } = request.body ?? {};

    const result = await firewallService.verifyNewConnection({
      pendingId,
      host,
      port,
      timeoutMs,
      clientEvidence,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleConfirm(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { pendingId, confirmationToken, clientEvidence, verifyConnection } = request.body ?? {};

    if (!pendingId || !confirmationToken) {
      throw new FirewallHttpError('missing_confirmation_parameters', 'pendingId and confirmationToken are required', 400);
    }

    const result = await firewallService.confirmMutation({
      pendingId,
      confirmationToken,
      clientEvidence,
      verifyConnection,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleRollback(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { pendingId, snapshotId, reason } = request.body ?? {};

    const result = await firewallService.rollbackMutation({
      pendingId,
      snapshotId,
      reason: reason || 'manual_rollback',
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleEnable(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { allowedSshPorts, sshPorts, renderOptions } = request.body ?? {};

    const result = await firewallService.enableFirewall({
      allowedSshPorts,
      sshPorts,
      renderOptions,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleDisable(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;

    const result = await firewallService.disableFirewall({
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleListSnapshots(request, response) {
    const snapshots = firewallService.listSnapshots();
    return response.json({ data: snapshots });
  }

  async function handleGetSnapshot(request, response) {
    const snapshot = firewallService.getSnapshot(request.params.snapshotId);
    if (!snapshot) {
      throw new FirewallHttpError('snapshot_not_found', `Snapshot not found: ${request.params.snapshotId}`, 404);
    }
    return response.json({ data: snapshot });
  }

  // --- Route Registrations ---

  // Server-scoped routes: /api/servers/:serverId/firewall/*
  app.get('/api/servers/:serverId/firewall/status', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleGetStatus));
  app.post('/api/servers/:serverId/firewall/preview', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handlePreview));
  app.post('/api/servers/:serverId/firewall/apply', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleApply));
  app.post('/api/servers/:serverId/firewall/verify-connection', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleVerifyConnection));
  app.post('/api/servers/:serverId/firewall/confirm', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleConfirm));
  app.post('/api/servers/:serverId/firewall/rollback', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRollback));
  app.post('/api/servers/:serverId/firewall/enable', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleEnable));
  app.post('/api/servers/:serverId/firewall/disable', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleDisable));
  app.get('/api/servers/:serverId/firewall/snapshots', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListSnapshots));
  app.get('/api/servers/:serverId/firewall/snapshots/:snapshotId', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleGetSnapshot));

  // Global / local shortcuts: /api/firewall/*
  app.get('/api/firewall/status', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleGetStatus));
  app.post('/api/firewall/preview', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handlePreview));
  app.post('/api/firewall/apply', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleApply));
  app.post('/api/firewall/verify-connection', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleVerifyConnection));
  app.post('/api/firewall/confirm', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleConfirm));
  app.post('/api/firewall/rollback', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRollback));
  app.post('/api/firewall/enable', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleEnable));
  app.post('/api/firewall/disable', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleDisable));
  app.get('/api/firewall/snapshots', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListSnapshots));
  app.get('/api/firewall/snapshots/:snapshotId', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleGetSnapshot));
}

export const firewallHttpInternals = Object.freeze({
  requireOwnerRole,
  requireReadAccess,
  resolveServer,
});
