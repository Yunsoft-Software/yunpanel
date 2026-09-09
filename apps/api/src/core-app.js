import express from 'express';
import { OPERATIONS } from '@yunpanel/protocol';
import { inspectLocalAgent } from './agent-client.js';
import {
  createApplicationEnvironmentRegistry,
  ApplicationEnvironmentRegistryError,
} from './application-environment-registry.js';
import { createApplicationRegistry, ApplicationRegistryError } from './application-registry.js';
import { createBootstrapAdminGuard, resolveBootstrapAdminToken } from './bootstrap-auth.js';
import { createCertificateRegistry, CertificateRegistryError } from './certificate-registry.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import { createJobRegistry, JobRegistryError } from './job-registry.js';
import { createServerRegistry, RegistryError } from './server-registry.js';

export const API_VERSION = '0.2.0';

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

async function resolveDomainTls(domain, certificateRegistry) {
  if (!domain.certificateId) return null;
  const certificate = await certificateRegistry.getCertificate(domain.certificateId);
  if (!certificate || certificate.state !== 'active') throw new CertificateRegistryError('certificate_not_active', 'Attached certificate is not active', 409);
  if (certificate.staging) throw new CertificateRegistryError('staging_certificate_not_allowed', 'Staging certificates cannot be attached to production HTTPS config', 409);
  return { fullchainPath: certificate.fullchainPath, privateKeyPath: certificate.privateKeyPath };
}

async function latestNodeStatusJob(jobRegistry, applicationId) {
  const jobs = await jobRegistry.listJobs({ resourceType: 'application', resourceId: applicationId });
  return jobs
    .filter((job) => job.operation === OPERATIONS.APP_NODE_STATUS)
    .sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0))[0] ?? null;
}

async function reconcileApplicationJob(applicationRegistry, job) {
  const application = await applicationRegistry.getApplication(job.resourceId);
  if (!application) return;

  if (job.status === 'failed') {
    if (application.activeDeploymentId !== job.id) return;
    await applicationRegistry.markFailed(job.resourceId, job.id, job.error?.code ?? 'application_operation_failed');
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_DEPLOY || job.operation === OPERATIONS.APP_NODE_DEPLOY) {
    if (application.activeDeploymentId == null && application.currentReleaseId === job.result?.releaseId) return;
    await applicationRegistry.markDeployed(job.resourceId, {
      deploymentId: job.id,
      releaseId: job.result.releaseId,
      commitSha: job.result.commitSha,
      previousReleaseId: job.result.previousReleaseId,
      artifactFiles: job.result.artifactFiles ?? null,
      artifactBytes: job.result.artifactBytes ?? null,
      serviceName: job.result.serviceName ?? null,
      port: job.result.port ?? null,
      healthPath: job.result.healthPath ?? null,
      healthy: job.result.healthy ?? null,
    });
    return;
  }

  if (job.operation === OPERATIONS.APP_STATIC_ROLLBACK || job.operation === OPERATIONS.APP_NODE_ROLLBACK) {
    if (application.activeDeploymentId == null && application.currentReleaseId === job.result?.releaseId) return;
    await applicationRegistry.markRolledBack(job.resourceId, {
      operationId: job.id,
      releaseId: job.result.releaseId,
      previousReleaseId: job.result.previousReleaseId,
      serviceName: job.result.serviceName ?? null,
      port: job.result.port ?? null,
      healthPath: job.result.healthPath ?? null,
      healthy: job.result.healthy ?? null,
    });
  }
}

async function reconcileAgentJob({ domainRegistry, certificateRegistry, applicationRegistry, job }) {
  if (job.resourceType === 'application') {
    await reconcileApplicationJob(applicationRegistry, job);
    return;
  }

  if (job.resourceType === 'domain') {
    if (job.status === 'failed') {
      await domainRegistry.markFailed(job.resourceId, job.error?.code ?? 'agent_job_failed');
      return;
    }
    if (job.operation === OPERATIONS.DOMAIN_STAGE) {
      await domainRegistry.markStaged(job.resourceId, { checksum: job.result.checksum, configName: job.result.configName });
      return;
    }
    if (job.operation === OPERATIONS.DOMAIN_ACTIVATE) await domainRegistry.markApplied(job.resourceId, { checksum: job.result.checksum });
    return;
  }

  if (job.resourceType === 'certificate') {
    if (job.status === 'failed') {
      await certificateRegistry.markFailed(job.resourceId, job.error?.code ?? 'certificate_operation_failed');
      return;
    }
    if (job.operation === OPERATIONS.SSL_ISSUE) {
      const certificate = await certificateRegistry.markActive(job.resourceId, job.result, { renewal: false });
      if (!certificate.staging) await domainRegistry.attachCertificate(certificate.domainId, certificate.id);
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
  applicationRegistry = createApplicationRegistry(),
  applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
    applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
  }),
  adminToken,
} = {}) {
  const app = express();
  const reconciliationJobs = new Map();
  const resolvedAdminToken = adminToken === undefined ? resolveBootstrapAdminToken({ environment }) : adminToken;
  const requireBootstrapAdmin = createBootstrapAdminGuard({ token: resolvedAdminToken });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (request, response) => response.json({ status: 'ok', service: 'yunpanel-api', version: API_VERSION }));

  app.get('/api/dev/agent/inspect', async (request, response) => {
    if (environment !== 'development') return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    try {
      return response.json(await inspectAgent());
    } catch (error) {
      return response.status(502).json({ error: { code: 'agent_unavailable', message: error.message } });
    }
  });

  const developmentList = (loader) => async (request, response) => {
    if (environment !== 'development') return response.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    return response.json({ data: await loader() });
  };
  app.get('/api/dev/servers', developmentList(() => registry.listServers()));
  app.get('/api/dev/domains', developmentList(() => domainRegistry.listDomains()));
  app.get('/api/dev/jobs', developmentList(() => jobRegistry.listJobs()));
  app.get('/api/dev/certificates', developmentList(() => certificateRegistry.listCertificates()));
  app.get('/api/dev/applications', developmentList(() => applicationRegistry.listApplications()));

  app.get('/api/servers', requireBootstrapAdmin, async (request, response) => response.json({ data: await registry.listServers() }));
  app.get('/api/servers/:serverId', requireBootstrapAdmin, async (request, response) => {
    const server = await registry.getServer(request.params.serverId);
    if (!server) return response.status(404).json({ error: { code: 'server_not_found', message: 'Server not found' } });
    return response.json({ data: server });
  });
  app.post('/api/servers/:serverId/system/packages/inspect', requireBootstrapAdmin, async (request, response) => {
    const server = await registry.getServer(request.params.serverId);
    if (!server) throw new RegistryError('server_not_found', 'Server not found', 404);
    await ensureResourceJobIdle(jobRegistry, 'system', server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: 'system.packages.inspect',
      operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
      payload: {},
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
  });
  app.post('/api/servers/:serverId/system/upgrade', requireBootstrapAdmin, async (request, response) => {
    const server = await registry.getServer(request.params.serverId);
    if (!server) throw new RegistryError('server_not_found', 'Server not found', 404);
    if (request.body?.confirmation !== 'upgrade-yunpanel') {
      throw new RegistryError('upgrade_confirmation_required', 'Explicit YunPanel upgrade confirmation is required', 400);
    }
    await ensureResourceJobIdle(jobRegistry, 'system', server.id);
    const job = await jobRegistry.enqueue({
      serverId: server.id,
      type: 'system.upgrade',
      operation: OPERATIONS.SYSTEM_UPGRADE,
      payload: {},
      resourceType: 'system',
      resourceId: server.id,
    });
    return response.status(202).json({ data: job });
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
    await registry.authenticateAgent({ serverId: request.params.serverId, agentToken: bearerToken(request) });
    const claimed = await jobRegistry.claimNext(request.params.serverId);
    if (!claimed) return response.status(204).end();
    return response.json({ data: claimed });
  });
  app.get('/api/servers/:serverId/applications/:applicationId/environment', async (request, response) => {
    await registry.authenticateAgent({ serverId: request.params.serverId, agentToken: bearerToken(request) });
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application || application.serverId !== request.params.serverId || application.type !== 'node') {
      throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    }
    return response.json({ data: await applicationEnvironmentRegistry.materialize(application.id) });
  });
  app.post('/api/servers/:serverId/commands/:jobId/result', async (request, response) => {
    const jobId = request.params.jobId;
    const reconciliation = (async () => {
      await registry.authenticateAgent({ serverId: request.params.serverId, agentToken: bearerToken(request) });
      const job = await jobRegistry.complete({
        serverId: request.params.serverId,
        jobId,
        status: request.body?.status,
        result: request.body?.result ?? null,
        error: request.body?.error ?? null,
      });

      try {
        await reconcileAgentJob({ domainRegistry, certificateRegistry, applicationRegistry, job });
      } catch (error) {
        if (job.resourceType === 'domain') {
          await domainRegistry.markFailed(job.resourceId, `reconcile_${error.code ?? 'failed'}`);
        } else if (job.resourceType === 'certificate') {
          await certificateRegistry.markFailed(job.resourceId, `reconcile_${error.code ?? 'failed'}`);
        } else if (job.resourceType === 'application') {
          const application = await applicationRegistry.getApplication(job.resourceId);
          if (application?.activeDeploymentId === job.id) await applicationRegistry.markFailed(job.resourceId, job.id, `reconcile_${error.code ?? 'failed'}`);
        }
      }
      return job;
    })();

    reconciliationJobs.set(jobId, reconciliation);
    try {
      return response.json({ data: await reconciliation });
    } finally {
      if (reconciliationJobs.get(jobId) === reconciliation) reconciliationJobs.delete(jobId);
    }
  });

  app.get('/api/applications', requireBootstrapAdmin, async (request, response) => response.json({ data: await applicationRegistry.listApplications() }));
  app.get('/api/applications/:applicationId', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    return response.json({ data: application });
  });
  app.get('/api/applications/:applicationId/environment', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    return response.json({
      data: await applicationEnvironmentRegistry.listVariables(application.id),
      secretStoreConfigured: applicationEnvironmentRegistry.secretStoreConfigured,
    });
  });
  app.put('/api/applications/:applicationId/environment/:key', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    const variable = await applicationEnvironmentRegistry.setVariable({
      applicationId: application.id,
      key: request.params.key,
      value: request.body?.value,
      secret: request.body?.secret === true,
    });
    return response.json({ data: variable });
  });
  app.delete('/api/applications/:applicationId/environment/:key', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    await applicationEnvironmentRegistry.deleteVariable(application.id, request.params.key);
    return response.status(204).end();
  });
  app.post('/api/applications', requireBootstrapAdmin, async (request, response) => {
    const type = request.body?.type ?? 'static';
    let application;
    if (type === 'static') {
      application = await applicationRegistry.createApplication({
        serverId: request.body?.serverId,
        name: request.body?.name,
        repositoryUrl: request.body?.repositoryUrl,
        branch: request.body?.branch ?? 'main',
        build: request.body?.build ?? {},
        retention: request.body?.retention ?? 5,
      });
    } else if (type === 'node') {
      application = await applicationRegistry.createNodeApplication({
        serverId: request.body?.serverId,
        name: request.body?.name,
        repositoryUrl: request.body?.repositoryUrl,
        branch: request.body?.branch ?? 'main',
        runtime: request.body?.runtime,
        retention: request.body?.retention ?? 5,
      });
    } else {
      throw new ApplicationRegistryError('invalid_application_type', 'Application type must be static or node');
    }
    return response.status(201).json({ data: application });
  });
  app.post('/api/applications/:applicationId/deploy', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    await ensureResourceJobIdle(jobRegistry, 'application', application.id);
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);

    let operation;
    let type;
    let payload;
    if (application.type === 'static') {
      operation = OPERATIONS.APP_STATIC_DEPLOY;
      type = 'app.static.deploy';
      payload = {
        applicationId: application.id,
        repositoryUrl: application.repositoryUrl,
        branch: application.branch,
        build: application.build,
        retention: application.retention,
      };
    } else if (application.type === 'node') {
      operation = OPERATIONS.APP_NODE_DEPLOY;
      type = 'app.node.deploy';
      payload = {
        applicationId: application.id,
        repositoryUrl: application.repositoryUrl,
        branch: application.branch,
        runtime: application.runtime,
        retention: application.retention,
      };
    } else {
      throw new ApplicationRegistryError('unsupported_application_type', 'Application type is not deployable', 409);
    }

    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type,
      operation,
      payload,
      resourceType: 'application',
      resourceId: application.id,
    });
    try {
      return response.status(202).json({ data: { application: await applicationRegistry.markDeploying(application.id, job.id), job } });
    } catch (error) {
      await jobRegistry.cancel(job.id).catch(() => {});
      throw error;
    }
  });
  app.post('/api/applications/:applicationId/rollback', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    if (!['static', 'node'].includes(application.type)) throw new ApplicationRegistryError('rollback_not_supported', 'Rollback is not implemented for this application type yet', 409);
    await ensureResourceJobIdle(jobRegistry, 'application', application.id);
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);

    const releaseId = request.body?.releaseId ?? application.previousReleaseId;
    if (!releaseId) throw new ApplicationRegistryError('rollback_release_required', 'No previous release is available for rollback', 409);

    const nodeRollback = application.type === 'node';
    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: nodeRollback ? 'app.node.rollback' : 'app.static.rollback',
      operation: nodeRollback ? OPERATIONS.APP_NODE_ROLLBACK : OPERATIONS.APP_STATIC_ROLLBACK,
      payload: nodeRollback
        ? {
            applicationId: application.id,
            releaseId,
            currentReleaseId: application.currentReleaseId,
            runtime: application.runtime,
          }
        : {
            applicationId: application.id,
            releaseId,
            currentReleaseId: application.currentReleaseId,
          },
      resourceType: 'application',
      resourceId: application.id,
    });
    try {
      return response.status(202).json({ data: { application: await applicationRegistry.markRollingBack(application.id, job.id, releaseId), job } });
    } catch (error) {
      await jobRegistry.cancel(job.id).catch(() => {});
      throw error;
    }
  });
  app.post('/api/applications/:applicationId/restart', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    if (application.type !== 'node') throw new ApplicationRegistryError('restart_not_supported', 'Restart is only supported for Node applications', 409);
    if (!application.currentReleaseId) throw new ApplicationRegistryError('application_not_deployed', 'Application has no active release to restart', 409);
    await ensureResourceJobIdle(jobRegistry, 'application', application.id);
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);

    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: 'app.node.restart',
      operation: OPERATIONS.APP_NODE_RESTART,
      payload: {
        applicationId: application.id,
        releaseId: application.currentReleaseId,
        runtime: application.runtime,
      },
      resourceType: 'application',
      resourceId: application.id,
    });
    return response.status(202).json({ data: job });
  });
  app.get('/api/applications/:applicationId/status', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    if (application.type !== 'node') throw new ApplicationRegistryError('status_not_supported', 'Process status is only supported for Node applications', 409);
    return response.json({ data: await latestNodeStatusJob(jobRegistry, application.id) });
  });
  app.post('/api/applications/:applicationId/status/refresh', requireBootstrapAdmin, async (request, response) => {
    const application = await applicationRegistry.getApplication(request.params.applicationId);
    if (!application) throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    if (application.type !== 'node') throw new ApplicationRegistryError('status_not_supported', 'Process status is only supported for Node applications', 409);
    if (!application.currentReleaseId) throw new ApplicationRegistryError('application_not_deployed', 'Application has no active release to inspect', 409);
    await ensureResourceJobIdle(jobRegistry, 'application', application.id);
    if (application.activeDeploymentId) throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);

    const job = await jobRegistry.enqueue({
      serverId: application.serverId,
      type: 'app.node.status',
      operation: OPERATIONS.APP_NODE_STATUS,
      payload: {
        applicationId: application.id,
        releaseId: application.currentReleaseId,
        runtime: application.runtime,
      },
      resourceType: 'application',
      resourceId: application.id,
    });
    return response.status(202).json({ data: job });
  });

  app.get('/api/domains', requireBootstrapAdmin, async (request, response) => response.json({ data: await domainRegistry.listDomains() }));
  app.get('/api/domains/:domainId', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) return response.status(404).json({ error: { code: 'domain_not_found', message: 'Not found' } });
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
    const tls = await resolveDomainTls(domain, certificateRegistry);
    const payload = { primaryDomain: domain.primaryDomain, aliases: domain.aliases, targetType: domain.targetType, target: domain.target };
    if (tls) payload.tls = tls;
    const job = await jobRegistry.enqueue({ serverId: domain.serverId, type: 'domain.stage', operation: OPERATIONS.DOMAIN_STAGE, payload, resourceType: 'domain', resourceId: domain.id });
    return response.status(202).json({ data: job });
  });
  app.post('/api/domains/:domainId/activate', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    if (domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum) throw new DomainRegistryError('staged_revision_required', 'Current desired domain revision must be staged before activation', 409);
    await ensureResourceJobIdle(jobRegistry, 'domain', domain.id);
    const job = await jobRegistry.enqueue({
      serverId: domain.serverId,
      type: 'domain.activate',
      operation: OPERATIONS.DOMAIN_ACTIVATE,
      payload: { primaryDomain: domain.primaryDomain, checksum: domain.stagedChecksum },
      resourceType: 'domain',
      resourceId: domain.id,
    });
    return response.status(202).json({ data: job });
  });
  app.post('/api/domains/:domainId/certificates/issue', requireBootstrapAdmin, async (request, response) => {
    const domain = await domainRegistry.getDomain(request.params.domainId);
    if (!domain) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    if (domain.httpsMode !== 'managed') throw new CertificateRegistryError('https_not_managed', 'Domain must use managed HTTPS before requesting a certificate', 409);
    if (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision) throw new CertificateRegistryError('http_domain_not_active', 'Current domain revision must be active before HTTP-01 certificate issuance', 409);

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
        payload: { domains: certificate.domains, email: certificate.email, staging: certificate.staging },
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

  app.get('/api/certificates', requireBootstrapAdmin, async (request, response) => response.json({ data: await certificateRegistry.listCertificates() }));
  app.get('/api/certificates/:certificateId', requireBootstrapAdmin, async (request, response) => {
    const certificate = await certificateRegistry.getCertificate(request.params.certificateId);
    if (!certificate) throw new CertificateRegistryError('certificate_not_found', 'Certificate not found', 404);
    return response.json({ data: certificate });
  });
  app.post('/api/certificates/:certificateId/renew', requireBootstrapAdmin, async (request, response) => {
    const certificate = await certificateRegistry.getCertificate(request.params.certificateId);
    if (!certificate) throw new CertificateRegistryError('certificate_not_found', 'Certificate not found', 404);
    if (certificate.state !== 'active') throw new CertificateRegistryError('certificate_not_active', 'Only active certificates can be renewed', 409);
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
    await Promise.allSettled(reconciliationJobs.values());
    const jobs = await jobRegistry.listJobs({
      serverId: request.query.serverId || null,
      resourceType: request.query.resourceType || null,
      resourceId: request.query.resourceId || null,
      status: request.query.status || null,
    });
    return response.json({ data: jobs });
  });
  app.get('/api/jobs/:jobId', requireBootstrapAdmin, async (request, response) => {
    await reconciliationJobs.get(request.params.jobId)?.catch(() => {});
    const job = await jobRegistry.getJob(request.params.jobId);
    if (!job) throw new JobRegistryError('job_not_found', 'Job not found', 404);
    return response.json({ data: job });
  });
  app.post('/api/jobs/:jobId/cancel', requireBootstrapAdmin, async (request, response) => {
    const job = await jobRegistry.cancel(request.params.jobId);
    if (job.resourceType === 'application') {
      const application = await applicationRegistry.getApplication(job.resourceId);
      if (application?.activeDeploymentId === job.id) await applicationRegistry.markFailed(job.resourceId, job.id, 'operation_cancelled');
    }
    return response.json({ data: job });
  });

  app.use((request, response) => response.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (
      error instanceof RegistryError
      || error instanceof DomainRegistryError
      || error instanceof JobRegistryError
      || error instanceof CertificateRegistryError
      || error instanceof ApplicationRegistryError
      || error instanceof ApplicationEnvironmentRegistryError
    ) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
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
