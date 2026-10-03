import { requirePanelRouteAccess } from './panel-http-guard.js';
import { FirewallServiceError } from './firewall-service.js';
import { NftablesManagerError, CrowdsecManagerError } from '@yunpanel/host-runtime';

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
      if (
        error instanceof FirewallServiceError
        || error instanceof NftablesManagerError
        || error instanceof FirewallHttpError
        || error instanceof CrowdsecManagerError
      ) {
        const status = error.status ?? (
          ['invalid_ip', 'invalid_duration', 'missing_identifier', 'missing_port', 'missing_ip', 'invalid_port', 'invalid_protocol', 'invalid_cidr', 'service_profile_inactive', 'lockout_risk_detected'].includes(error.code)
            ? 400
            : (error.code === 'unauthorized_test_target' ? 403 : (error.code === 'snapshot_not_found' || error.code === 'decision_not_found' ? 404 : 400))
        );
        return response.status(status).json({
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


  async function handleListPorts(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const result = await firewallService.listPorts({ serverId: server.id });
    return response.json({ data: result });
  }

  async function handleAddPort(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { port, protocol, source, policy, serviceProfile, skipApply } = request.body ?? {};

    if (port === undefined || port === null) {
      throw new FirewallHttpError('missing_port', 'port is required', 400);
    }

    const result = await firewallService.addPortRule({
      port: Number(port),
      protocol: protocol ?? 'tcp',
      source: source ?? '0.0.0.0/0',
      policy: policy ?? 'allow',
      serviceProfile: serviceProfile ?? 'custom',
      skipApply: Boolean(skipApply),
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleRemovePort(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const port = Number(request.params.port);
    const protocol = request.query?.protocol ?? 'tcp';
    const skipApply = request.query?.skipApply === 'true';

    const result = await firewallService.removePortRule({
      port,
      protocol,
      skipApply,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleGetServiceProfiles(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const result = firewallService.getServiceProfiles();
    return response.json({ data: { serviceProfiles: result, ...result } });
  }

  async function handleUpdateServiceProfiles(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const body = request.body ?? {};
    const profiles = body.profiles ?? body;
    const skipApply = Boolean(body.skipApply);

    const result = await firewallService.updateServiceProfiles({
      profiles: profiles ?? {},
      skipApply,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: { serviceProfiles: result, ...result } });
  }

  async function handleScanPort(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { host, port, protocol, timeoutMs, target } = request.body ?? {};

    if (port === undefined || port === null) {
      throw new FirewallHttpError('missing_port', 'port is required for scanning', 400);
    }

    const effectiveHost = target ?? host ?? '127.0.0.1';

    const result = await firewallService.scanPortReachability({
      host: effectiveHost,
      port: Number(port),
      protocol: protocol ?? 'tcp',
      timeoutMs: timeoutMs ? Number(timeoutMs) : 3000,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleListBans(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const result = await firewallService.listBans();
    return response.json({ data: result });
  }

  async function handleAddBan(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { ip, duration, reason, type } = request.body ?? {};

    if (!ip) {
      throw new FirewallHttpError('missing_ip', 'ip is required', 400);
    }

    const result = await firewallService.addBan({
      ip,
      duration: duration ?? '4h',
      reason: reason ?? 'Manual ban from YunPanel',
      type: type ?? 'ban',
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
  }

  async function handleRemoveBan(request, response) {
    const server = await resolveServer(registry, request.params.serverId, localServerId);
    const actorId = request.auth?.user?.id ?? null;
    const { ip, id } = request.body ?? {};
    const targetId = id ?? request.params?.id ?? null;
    const targetIp = ip ?? (request.query?.ip ?? null);

    const result = await firewallService.removeBan({
      ip: targetIp,
      id: targetId,
      actorId,
      serverId: server.id,
    });
    return response.json({ data: result });
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

  // Server-scoped PROD-05 Port & Service Profile routes
  app.get('/api/servers/:serverId/firewall/ports', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListPorts));
  app.post('/api/servers/:serverId/firewall/ports', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleAddPort));
  app.delete('/api/servers/:serverId/firewall/ports/:port', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemovePort));
  app.get('/api/servers/:serverId/firewall/service-profiles', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleGetServiceProfiles));
  app.put('/api/servers/:serverId/firewall/service-profiles', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleUpdateServiceProfiles));
  app.post('/api/servers/:serverId/firewall/service-profiles', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleUpdateServiceProfiles));
  app.post('/api/servers/:serverId/firewall/scan', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleScanPort));

  // Server-scoped CrowdSec routes
  app.get('/api/servers/:serverId/firewall/bans', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListBans));
  app.post('/api/servers/:serverId/firewall/bans', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleAddBan));
  app.post('/api/servers/:serverId/firewall/unban', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemoveBan));
  app.delete('/api/servers/:serverId/firewall/bans/:id', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemoveBan));
  app.get('/api/servers/:serverId/firewall/crowdsec/decisions', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListBans));
  app.post('/api/servers/:serverId/firewall/crowdsec/ban', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleAddBan));
  app.post('/api/servers/:serverId/firewall/crowdsec/unban', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemoveBan));

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

  // Global PROD-05 Port & Service Profile routes
  app.get('/api/firewall/ports', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListPorts));
  app.post('/api/firewall/ports', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleAddPort));
  app.delete('/api/firewall/ports/:port', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemovePort));
  app.get('/api/firewall/service-profiles', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleGetServiceProfiles));
  app.put('/api/firewall/service-profiles', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleUpdateServiceProfiles));
  app.post('/api/firewall/service-profiles', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleUpdateServiceProfiles));
  app.post('/api/firewall/scan', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleScanPort));

  // Global CrowdSec routes
  app.get('/api/firewall/bans', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListBans));
  app.post('/api/firewall/bans', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleAddBan));
  app.post('/api/firewall/unban', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemoveBan));
  app.delete('/api/firewall/bans/:id', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemoveBan));
  app.get('/api/firewall/crowdsec/decisions', requireReadAccess, requirePanelRouteAccess, asyncRoute(handleListBans));
  app.post('/api/firewall/crowdsec/ban', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleAddBan));
  app.post('/api/firewall/crowdsec/unban', requireOwnerRole, requirePanelRouteAccess, asyncRoute(handleRemoveBan));
}

export const firewallHttpInternals = Object.freeze({
  requireOwnerRole,
  requireReadAccess,
  resolveServer,
});
