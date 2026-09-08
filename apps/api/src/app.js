import express from 'express';
import { OPERATIONS } from '@yunpanel/protocol';
import { inspectLocalAgent } from './agent-client.js';
import { createBootstrapAdminGuard, resolveBootstrapAdminToken } from './bootstrap-auth.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import { createJobRegistry, JobRegistryError } from './job-registry.js';
import { createServerRegistry, RegistryError } from './server-registry.js';

export const API_VERSION = '0.0.1';

function bearerToken(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function ensureDomainJobIdle(jobRegistry, domainId) {
  const jobs = await jobRegistry.listJobs({ resourceType: 'domain', resourceId: domainId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new JobRegistryError('domain_job_conflict', 'A domain operation is already queued or running', 409);
  }
}

async function reconcileDomainJob(domainRegistry, job) {
  if (job.resourceType !== 'domain') return;

  if (job.status === 'failed') {
    await domainRegistry.markFailed(job.resourceId, job.error?.code ?? 'agent_job_failed');
    return;
  }

  if (job.operation === OPERATIONS.DOMAIN_STAGE) {
    await domainRegistry.markStaged(job.resourceId, {
      checksum: job.result.checksum,
      configName: job.result.configName,
    });
    return;
  }

  if (job.operation === OPERATIONS.DOMAIN_ACTIVATE) {
    await domainRegistry.markApplied(job.resourceId, {
      checksum: job.result.checksum,
    });
  }
}

export function createApp({
  inspectAgent = inspectLocalAgent,
  environment = process.env.NODE_ENV,
  registry = createServerRegistry(),
  domainRegistry = createDomainRegistry(),
  jobRegistry = createJobRegistry(),
  adminToken,
} = {}) {
  const app = express();
  const resolvedAdminToken = adminToken === undefined
    ? resolveBootstrapAdminToken({ environment })
    : adminToken;
  const requireBootstrapAdmin = createBootstrapAdminGuard({ token: resolvedAdminToken });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (request, response) => {
    response.json({
      status: 'ok',
      service: 'yunpanel-api',
      version: API_VERSION,
    });
  });

  app.get('/api/dev/agent/inspect', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }

    try {
      const result = await inspectAgent();
      return response.json(result);
    } catch (error) {
      return response.status(502).json({
        error: {
          code: 'agent_unavailable',
          message: error.message,
        },
      });
    }
  });

  app.get('/api/dev/servers', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }

    const servers = await registry.listServers();
    return response.json({ data: servers });
  });

  app.get('/api/dev/domains', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }

    const domains = await domainRegistry.listDomains();
    return response.json({ data: domains });
  });

  app.get('/api/dev/jobs', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }

    const jobs = await jobRegistry.listJobs();
    return response.json({ data: jobs });
  });

  app.get('/api/servers', requireBootstrapAdmin, async (request, response) => {
    const servers = await registry.listServers();
    return response.json({ data: servers });
  });

  app.get('/api/servers/:serverId', requireBootstrapAdmin, async (request, response) => {
    const server = await registry.getServer(request.params.serverId);
    if (!server) {
      return response.status(404).json({ error: { code: 'server_not_found', message: 'Server not found' } });
    }
    return response.json({ data: server });
  });

  app.post('/api/servers/enrollment-tokens', requireBootstrapAdmin, async (request, response) => {
    const ttlMinutes = request.body?.ttlMinutes;
    const options = { label: request.body?.label ?? null };
    if (ttlMinutes !== undefined) options.ttlMs = Number(ttlMinutes) * 60 * 1000;

    const enrollment = await registry.issueEnrollmentToken(options);
    return response.status(201).json({ data: enrollment });
  });

  app.post('/api/servers/enroll', async (request, response) => {
    const enrolled = await registry.enrollServer({
      token: request.body?.token,
      hostname: request.body?.hostname,
      displayName: request.body?.displayName ?? null,
    });

    return response.status(201).json({ data: enrolled });
  });

  app.post('/api/servers/:serverId/heartbeat', async (request, response) => {
    const server = await registry.heartbeat({
      serverId: request.params.serverId,
      agentToken: bearerToken(request),
      agentVersion: request.body?.agentVersion ?? null,
      inventory: request.body?.inventory ?? null,
      services: request.body?.services ?? null,
    });

    return response.json({ data: server });
  });

  app.get('/api/servers/:serverId/commands/next', async (request, response) => {
    await registry.authenticateAgent({
      serverId: request.params.serverId,
      agentToken: bearerToken(request),
    });

    const claimed = await jobRegistry.claimNext(request.params.serverId);
    if (!claimed) return response.status(204).end();
    return response.json({ data: claimed });
  });

  app.post('/api/servers/:serverId/commands/:jobId/result', async (request, response) => {
    await registry.authenticateAgent({
      serverId: request.params.serverId,
      agentToken: bearerToken(request),
    });

    const job = await jobRegistry.complete({
      serverId: request.params.serverId,
      jobId: request.params.jobId,
      status: request.body?.status,
      result: request.body?.result ?? null,
      error: request.body?.error ?? null,
    });

    try {
      await reconcileDomainJob(domainRegistry, job);
    } catch (error) {
      await domainRegistry.markFailed(job.resourceId, `reconcile_${error.code ?? 'failed'}`);
    }

    return response.json({ data: job });
  });

  app.get('/api/domains', requireBootstrapAdmin, async (request, response) => {
    const domains = await domainRegistry.listDomains();
    return response.json({ data: domains });
  });

  app.get('/api/domains/:domainId', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) {
      return response.status(404).json({ error: { code: 'domain_not_found', message: 'Domain not found' } });
    }
    return response.json({ data: domain });
  });

  app.post('/api/domains', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.createDomain({
      serverId: request.body?.serverId,
      primaryDomain: request.body?.primaryDomain,
      aliases: request.body?.aliases ?? [],
      targetType: request.body?.targetType,
      target: request.body?.target,
      httpsMode: request.body?.httpsMode ?? 'off',
    });
    return response.status(201).json({ data: domain });
  });

  app.post('/api/domains/:domainId/stage', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    await ensureDomainJobIdle(jobRegistry, domain.id);

    const job = await jobRegistry.enqueue({
      serverId: domain.serverId,
      type: 'domain.stage',
      operation: OPERATIONS.DOMAIN_STAGE,
      payload: {
        primaryDomain: domain.primaryDomain,
        aliases: domain.aliases,
        targetType: domain.targetType,
        target: domain.target,
      },
      resourceType: 'domain',
      resourceId: domain.id,
    });

    return response.status(202).json({ data: job });
  });

  app.post('/api/domains/:domainId/activate', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    if (domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum) {
      throw new DomainRegistryError('staged_revision_required', 'Current desired domain revision must be staged before activation', 409);
    }
    await ensureDomainJobIdle(jobRegistry, domain.id);

    const job = await jobRegistry.enqueue({
      serverId: domain.serverId,
      type: 'domain.activate',
      operation: OPERATIONS.DOMAIN_ACTIVATE,
      payload: {
        primaryDomain: domain.primaryDomain,
        checksum: domain.stagedChecksum,
      },
      resourceType: 'domain',
      resourceId: domain.id,
    });

    return response.status(202).json({ data: job });
  });

  app.get('/api/jobs', requireBootstrapAdmin, async (request, response) => {
    const jobs = await jobRegistry.listJobs({
      serverId: request.query.serverId || null,
      resourceType: request.query.resourceType || null,
      resourceId: request.query.resourceId || null,
      status: request.query.status || null,
    });
    return response.json({ data: jobs });
  });

  app.get('/api/jobs/:jobId', requireBootstrapAdmin, async (request, response) => {
    const job = await jobRegistry.getJob(request.params.jobId);
    if (!job) throw new JobRegistryError('job_not_found', 'Job not found', 404);
    return response.json({ data: job });
  });

  app.post('/api/jobs/:jobId/cancel', requireBootstrapAdmin, async (request, response) => {
    const job = await jobRegistry.cancel(request.params.jobId);
    return response.json({ data: job });
  });

  app.use((request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);

    if (error instanceof RegistryError || error instanceof DomainRegistryError || error instanceof JobRegistryError) {
      return response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    const isJsonSyntaxError = error instanceof SyntaxError && error.status === 400;
    return response.status(isJsonSyntaxError ? 400 : 500).json({
      error: {
        code: isJsonSyntaxError ? 'invalid_json' : 'internal_error',
        message: isJsonSyntaxError ? 'Invalid JSON body' : 'Unexpected server error',
      },
    });
  });

  return app;
}
