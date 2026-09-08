import express from 'express';
import { OPERATIONS } from '@yunpanel/protocol';
import { inspectLocalAgent } from './agent-client.js';
import { createBootstrapAdminGuard, resolveBootstrapAdminToken } from './bootstrap-auth.js';
import { createCertificateRegistry, CertificateRegistryError } from './certificate-registry.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import { createJobRegistry, JobRegistryError } from './job-registry.js';
import { createServerRegistry, RegistryError } from './server-registry.js';

export const API_VERSION = '0.0.1';

function bearerToken(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function ensureResourceJobIdle(jobRegistry, resourceType, resourceId) {
  const jobs = await jobRegistry.listJobs({ resourceType, resourceId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new JobRegistryError(`${resourceType}_job_conflict`, `A ${resourceType} operation is already queued or running`, 409);
  }
}

async function reconcileAgentJob({ domainRegistry, certificateRegistry, job }) {
  if (job.resourceType === 'domain') {
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
    return;
  }

  if (job.resourceType === 'certificate') {
    if (job.status === 'failed') {
      await certificateRegistry.markFailed(job.resourceId, job.error?.code ?? 'certificate_operation_failed');
      return;
    }

    if (job.operation === OPERATIONS.SSL_ISSUE) {
      await certificateRegistry.markActive(job.resourceId, job.result, { renewal: false });
      return;
    }

    if (job.operation === OPERATIONS.SSL_RENEW) {
      if (job.result.dryRun === true) {
        await certificateRegistry.setState(job.resourceId, 'active');
        return;
      }
      await certificateRegistry.markActive(job.resourceId, job.result, { renewal: true });
    }
  }
}

export function createApp({
  inspectAgent = inspectLocalAgent,
  environment = process.env.NODE_ENV,
  registry = createServerRegistry(),
  domainRegistry = createDomainRegistry(),
  jobRegistry = createJobRegistry(),
  certificateRegistry = createCertificateRegistry(),
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
    return response.json({ data: await registry.listServers() });
  });

  app.get('/api/dev/domains', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }
    return response.json({ data: await domainRegistry.listDomains() });
  });

  app.get('/api/dev/jobs', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }
    return response.json({ data: await jobRegistry.listJobs() });
  });

  app.get('/api/dev/certificates', async (request, response) => {
    if (environment !== 'development') {
      return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    }
    return response.json({ data: await certificateRegistry.listCertificates() });
  });

  app.get('/api/servers', requireBootstrapAdmin, async (request, response) => {
    return response.json({ data: await registry.listServers() });
  });

  app.get('/api/servers/:serverId', requireBootstrapAdmin, async (request, response) => {
    const server = await registry.getServer(request.params.serverId);
    if (!server) return response.status(404).json({ error: { code: 'server_not_found', message: 'Server not found' } });
    return response.json({ data: server });
  });

  app.post('/api/servers/enrollment-tokens', requireBootstrapAdmin, async (request, response) => {
    const ttlMinutes = request.body?.ttlMinutes;
    const options = { label: request.body?.label ?? null };
    if (ttlMinutes !== undefined) options.ttlMs = Number(ttlMinutes) * 60 * 1000;
    return response.status(201).json({ data: await registry.issueEnrollmentToken(options) });
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
      await reconcileAgentJob({ domainRegistry, certificateRegistry, job });
    } catch (error) {
      if (job.resourceType === 'domain') {
        await domainRegistry.markFailed(job.resourceId, `reconcile_${error.code ?? 'failed'}`);
      } else if (job.resourceType === 'certificate') {
        await certificateRegistry.markFailed(job.resourceId, `reconcile_${error.code ?? 'failed'}`);
      }
    }

    return response.json({ data: job });
  });

  app.get('/api/domains', requireBootstrapAdmin, async (request, response) => {
    return response.json({ data: await domainRegistry.listDomains() });
  });

  app.get('/api/domains/:domainId', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) return response.status(404).json({ error: { code: 'domain_not_found', message: 'Domain not found' } });
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
    await ensureResourceJobIdle(jobRegistry, 'domain', domain.id);

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
    await ensureResourceJobIdle(jobRegistry, 'domain', domain.id);

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

  app.post('/api/domains/:domainId/certificates/issue', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    if (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision) {
      throw new CertificateRegistryError('http_domain_not_active', 'Current domain revision must be active before HTTP-01 certificate issuance', 409);
    }

    const certificate = await certificateRegistry.createForDomain({
      domainId: domain.id,
      serverId: domain.serverId,
      domains: [domain.primaryDomain, ...domain.aliases],
      email: request.body?.email,
      staging: request.body?.staging === true,
    });

    try {
      const job = await jobRegistry.enqueue({
        serverId: domain.serverId,
        type: 'ssl.issue',
        operation: OPERATIONS.SSL_ISSUE,
        payload: {
          domains: certificate.domains,
          email: certificate.email,
          staging: certificate.staging,
        },
        resourceType: 'certificate',
        resourceId: certificate.id,
      });
      await certificateRegistry.setState(certificate.id, 'issuing');
      return response.status(202).json({ data: { certificate: await certificateRegistry.getCertificate(certificate.id), job } });
    } catch (error) {
      await certificateRegistry.markFailed(certificate.id, error.code ?? 'certificate_enqueue_failed');
      throw error;
    }
  });

  app.get('/api/certificates', requireBootstrapAdmin, async (request, response) => {
    return response.json({ data: await certificateRegistry.listCertificates() });
  });

  app.get('/api/certificates/:certificateId', requireBootstrapAdmin, async (request, response) => {
    const certificate = await certificateRegistry.getCertificate(request.params.certificateId);
    if (!certificate) throw new CertificateRegistryError('certificate_not_found', 'Certificate not found', 404);
    return response.json({ data: certificate });
  });

  app.post('/api/certificates/:certificateId/renew', requireBootstrapAdmin, async (request, response) => {
    const certificate = await certificateRegistry.getCertificate(request.params.certificateId);
    if (!certificate) throw new CertificateRegistryError('certificate_not_found', 'Certificate not found', 404);
    if (certificate.state !== 'active') {
      throw new CertificateRegistryError('certificate_not_active', 'Only active certificates can be renewed', 409);
    }
    await ensureResourceJobIdle(jobRegistry, 'certificate', certificate.id);

    const dryRun = request.body?.dryRun === true;
    const job = await jobRegistry.enqueue({
      serverId: certificate.serverId,
      type: 'ssl.renew',
      operation: OPERATIONS.SSL_RENEW,
      payload: { certName: certificate.certName, dryRun },
      resourceType: 'certificate',
      resourceId: certificate.id,
    });
    if (!dryRun) await certificateRegistry.setState(certificate.id, 'renewing');
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
    return response.json({ data: await jobRegistry.cancel(request.params.jobId) });
  });

  app.use((request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);

    if (
      error instanceof RegistryError
      || error instanceof DomainRegistryError
      || error instanceof JobRegistryError
      || error instanceof CertificateRegistryError
    ) {
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
