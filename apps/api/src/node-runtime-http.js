import { MANAGED_NODE_RUNTIME_MAJORS, OPERATIONS } from '@yunpanel/protocol';
import { JobRegistryError } from './job-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { RegistryError } from './server-registry.js';

const SUPPORTED_MAJORS = new Set(MANAGED_NODE_RUNTIME_MAJORS);

export class NodeRuntimeHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'NodeRuntimeHttpError';
    this.code = code;
    this.status = status;
  }
}

async function requireServer(registry, serverId) {
  const server = await registry.getServer(serverId);
  if (!server) throw new RegistryError('server_not_found', 'Server not found', 404);
  return server;
}

function requireMajor(value) {
  if (!/^\d{2}$/.test(value ?? '') || !SUPPORTED_MAJORS.has(Number.parseInt(value, 10))) {
    throw new NodeRuntimeHttpError('node_runtime_unsupported', 'Requested Node.js major is not supported for managed installation');
  }
  return Number.parseInt(value, 10);
}

async function ensureSystemIdle(jobRegistry, serverId) {
  const jobs = await jobRegistry.listJobs({ resourceType: 'system', resourceId: serverId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new JobRegistryError('system_job_conflict', 'Another server system operation is already queued or running', 409);
  }
}

function latestInventory(jobs) {
  return jobs
    .filter((job) => [OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL].includes(job.operation)
      && job.status === 'succeeded' && job.result?.inventory !== null)
    .sort((left, right) => Date.parse(right.finishedAt ?? right.createdAt ?? 0) - Date.parse(left.finishedAt ?? left.createdAt ?? 0))[0] ?? null;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountNodeRuntimeRoutes(app, { registry, jobRegistry } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || !registry || typeof registry.getServer !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') {
    throw new Error('Node runtime HTTP dependencies are required');
  }

  app.get('/api/servers/:serverId/node-runtimes', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    const jobs = await jobRegistry.listJobs({ serverId: server.id, resourceType: 'system', resourceId: server.id });
    const latest = latestInventory(jobs);
    const inventory = latest?.operation === OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL ? latest.result.inventory : latest?.result ?? null;
    return response.json({ data: {
      inventory,
      snapshot: latest ? { jobId: latest.id, refreshedAt: latest.finishedAt ?? latest.createdAt } : null,
    } });
  }));

  app.post('/api/servers/:serverId/node-runtimes/inspect', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const server = await requireServer(registry, request.params.serverId);
    await ensureSystemIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT,
      operation: OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT,
      payload: {},
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  }));

  app.post('/api/servers/:serverId/node-runtimes/:major/install', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const major = requireMajor(request.params.major);
    const server = await requireServer(registry, request.params.serverId);
    const confirmation = `install-node-runtime:${server.id}:${major}`;
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 1 || request.body.confirmation !== confirmation) {
      throw new NodeRuntimeHttpError('node_runtime_confirmation_required', `Confirm installation with ${confirmation}`);
    }
    await ensureSystemIdle(jobRegistry, server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL,
      operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL,
      payload: { major },
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  }));
}

export const nodeRuntimeHttpInternals = Object.freeze({ requireMajor, ensureSystemIdle, latestInventory });
