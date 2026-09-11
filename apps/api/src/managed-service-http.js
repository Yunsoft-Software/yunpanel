import {
  MANAGED_SERVICE_ACTIONS,
  MANAGED_SERVICE_CONTROL_IDS,
  MANAGED_SERVICE_IDS,
  OPERATIONS,
} from '@yunpanel/protocol';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { RegistryError } from './server-registry.js';

const SERVICE_IDS = new Set(MANAGED_SERVICE_IDS);
const CONTROL_SERVICE_IDS = new Set(MANAGED_SERVICE_CONTROL_IDS);
const SERVICE_ACTIONS = new Set(MANAGED_SERVICE_ACTIONS);

export class ManagedServiceHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ManagedServiceHttpError';
    this.code = code;
    this.status = status;
  }
}

function requireServiceId(value) {
  if (typeof value !== 'string' || !SERVICE_IDS.has(value)) {
    throw new ManagedServiceHttpError('unsupported_managed_service', 'Managed service is not supported');
  }
  return value;
}

function requireAction(value) {
  if (typeof value !== 'string' || !SERVICE_ACTIONS.has(value)) {
    throw new ManagedServiceHttpError('unsupported_managed_service_action', 'Managed service action is not supported');
  }
  return value;
}

function requireControlServiceId(value) {
  const serviceId = requireServiceId(value);
  if (!CONTROL_SERVICE_IDS.has(serviceId)) {
    throw new ManagedServiceHttpError('managed_service_not_controllable', 'Managed application does not expose a systemd service control');
  }
  return serviceId;
}

async function requireServer(registry, serverId) {
  const server = await registry.getServer(serverId);
  if (!server) throw new RegistryError('server_not_found', 'Server not found', 404);
  return server;
}

async function ensureSystemIdle(jobRegistry, serverId) {
  const jobs = await jobRegistry.listJobs({ resourceType: 'system', resourceId: serverId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new JobRegistryError('system_job_conflict', 'Another server system operation is already queued or running', 409);
  }
}

function jobCompletedAt(job) {
  const value = Date.parse(job?.finishedAt ?? job?.createdAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function isCompleteServiceInventory(value) {
  if (!Array.isArray(value) || value.length !== MANAGED_SERVICE_IDS.length) return false;
  const ids = new Set(value.map((entry) => entry?.id));
  return ids.size === MANAGED_SERVICE_IDS.length && MANAGED_SERVICE_IDS.every((id) => ids.has(id));
}

async function latestServiceSnapshot(jobRegistry, serverId) {
  const jobs = await jobRegistry.listJobs({
    serverId,
    resourceType: 'system',
    resourceId: serverId,
    status: 'succeeded',
  });
  const relevant = jobs
    .filter((job) => [
      OPERATIONS.SYSTEM_SERVICES_INSPECT,
      OPERATIONS.SYSTEM_SERVICE_INSTALL,
      OPERATIONS.SYSTEM_SERVICE_CONTROL,
    ].includes(job.operation))
    .sort((left, right) => jobCompletedAt(left) - jobCompletedAt(right));

  let services = null;
  let snapshotJob = null;
  for (const job of relevant) {
    if (job.operation === OPERATIONS.SYSTEM_SERVICES_INSPECT && isCompleteServiceInventory(job.result)) {
      services = job.result.map((service) => ({ ...service }));
      snapshotJob = job;
      continue;
    }
    if (!services || !job.result || typeof job.result !== 'object' || Array.isArray(job.result)) continue;
    if (!SERVICE_IDS.has(job.result.id)) continue;
    const index = services.findIndex((service) => service.id === job.result.id);
    if (index < 0) continue;
    services[index] = { ...job.result };
    snapshotJob = job;
  }

  return services && snapshotJob ? { services, job: snapshotJob } : null;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountManagedServiceRoutes(app, { registry, jobRegistry }) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!registry || typeof registry.getServer !== 'function') throw new Error('Server registry is required');
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') throw new Error('Job registry is required');

  app.get('/api/servers/:serverId/services', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const latest = await latestServiceSnapshot(jobRegistry, server.id);
    return response.json({ data: {
      services: latest?.services ?? null,
      snapshot: latest ? { jobId: latest.job.id, refreshedAt: latest.job.finishedAt ?? latest.job.createdAt } : null,
    } });
  }));

  app.post('/api/servers/:serverId/services/inspect', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    await ensureSystemIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.SYSTEM_SERVICES_INSPECT,
      operation: OPERATIONS.SYSTEM_SERVICES_INSPECT,
      payload: {},
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  }));

  app.post('/api/servers/:serverId/services/:serviceId/install', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serviceId = requireServiceId(request.params.serviceId);
    const server = await requireServer(registry, request.params.serverId);
    if (request.body?.confirmation !== `install:${serviceId}`) {
      throw new ManagedServiceHttpError('managed_service_confirmation_required', `Confirm installation with install:${serviceId}`);
    }
    await ensureSystemIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.SYSTEM_SERVICE_INSTALL,
      operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
      payload: { serviceId },
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  }));

  app.post('/api/servers/:serverId/services/:serviceId/control', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serviceId = requireControlServiceId(request.params.serviceId);
    const action = requireAction(request.body?.action);
    const server = await requireServer(registry, request.params.serverId);
    if (request.body?.confirmation !== `control:${serviceId}:${action}`) {
      throw new ManagedServiceHttpError('managed_service_confirmation_required', `Confirm service action with control:${serviceId}:${action}`);
    }
    await ensureSystemIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.SYSTEM_SERVICE_CONTROL,
      operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
      payload: { serviceId, action },
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  }));
}

export const managedServiceHttpInternals = Object.freeze({
  requireServiceId,
  requireControlServiceId,
  requireAction,
  ensureSystemIdle,
  latestServiceSnapshot,
  jobCompletedAt,
  isCompleteServiceInventory,
});
