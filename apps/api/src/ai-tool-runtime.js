import { createHash } from 'node:crypto';
import { MANAGED_SERVICE_CONTROL_IDS, OPERATIONS } from '@yunpanel/protocol';
import { createApplicationDeployQueue } from './application-deploy-queue.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from './ai-tool-catalog.js';
import { createAiToolRegistry } from './ai-tool-registry.js';
import { jobPublicView } from './job-registry.js';

export class AiToolRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiToolRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function requireDependencies({ serverRegistry, websiteRegistry, domainRegistry, applicationRegistry, jobRegistry }) {
  if (!serverRegistry || typeof serverRegistry.listServers !== 'function' || typeof serverRegistry.getServer !== 'function') {
    throw new AiToolRuntimeError('invalid_ai_server_registry', 'AI runtime requires the server registry');
  }
  if (!websiteRegistry || typeof websiteRegistry.listWebsites !== 'function' || typeof websiteRegistry.getWebsite !== 'function') {
    throw new AiToolRuntimeError('invalid_ai_website_registry', 'AI runtime requires the Website registry');
  }
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function') {
    throw new AiToolRuntimeError('invalid_ai_domain_registry', 'AI runtime requires the Domain registry');
  }
  if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function') {
    throw new AiToolRuntimeError('invalid_ai_application_registry', 'AI runtime requires the Application registry');
  }
  if (!jobRegistry || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.listJobs !== 'function') {
    throw new AiToolRuntimeError('invalid_ai_job_registry', 'AI runtime requires the job registry');
  }
}

function requireLocalResource(resource, localServerId, code, message) {
  if (!resource || (localServerId && resource.serverId !== localServerId && resource.id !== localServerId)) {
    throw new AiToolRuntimeError(code, message, 404);
  }
  return resource;
}

function newestFirst(left, right) {
  return Date.parse(right?.createdAt ?? 0) - Date.parse(left?.createdAt ?? 0);
}

const CONTROL_SERVICE_IDS = new Set(MANAGED_SERVICE_CONTROL_IDS);

async function resolveLocalServer(serverRegistry, localServerId) {
  if (localServerId) {
    return requireLocalResource(
      await serverRegistry.getServer(localServerId),
      localServerId,
      'server_not_found',
      'Server not found',
    );
  }
  const servers = await serverRegistry.listServers();
  if (servers.length !== 1) {
    throw new AiToolRuntimeError('ai_local_server_ambiguous', 'AI operation requires one unambiguous local Server', 409);
  }
  return servers[0];
}

async function ensureResourceIdle(jobRegistry, resourceType, resourceId) {
  const jobs = await jobRegistry.listJobs({ resourceType, resourceId });
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new AiToolRuntimeError('ai_resource_job_conflict', 'Another operation is already queued or running for this resource', 409);
  }
}

export function createAiToolRuntime({
  serverRegistry,
  websiteRegistry,
  domainRegistry,
  applicationRegistry,
  jobRegistry,
  applicationEnvironmentRegistry = null,
  applicationDeployQueue = null,
  dnsHostingRegistry = null,
  dnsRecordManager = null,
  certificateRegistry = null,
  mailDomainRegistry = null,
  databaseBindingRegistry = null,
  websiteBackupSetProvider = null,
  websiteBackupService = null,
  websiteRestoreService = null,
  resticRepositoryRegistry = null,
  resticManager = null,
  journalLogReader = null,
  nginxLogReader = null,
  localServerId = null,
} = {}) {
  requireDependencies({ serverRegistry, websiteRegistry, domainRegistry, applicationRegistry, jobRegistry });
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });

  registry.bind('server.health', async () => {
    const server = await resolveLocalServer(serverRegistry, localServerId);
    const jobs = await jobRegistry.listJobs({ serverId: server.id });
    return Object.freeze({
      server,
      jobs: Object.freeze({
        queued: jobs.filter((job) => job.status === 'queued').length,
        running: jobs.filter((job) => job.status === 'running').length,
        failed: jobs.filter((job) => job.status === 'failed').length,
      }),
    });
  });

  registry.bind('website.list', async () => (
    websiteRegistry.listWebsites(localServerId ? { serverId: localServerId } : {})
  ));

  registry.bind('website.inspect', async ({ input }) => {
    const website = requireLocalResource(
      await websiteRegistry.getWebsite(input.websiteId),
      localServerId,
      'website_not_found',
      'Website not found',
    );
    const domains = (await domainRegistry.listDomains()).filter((domain) => domain.websiteId === website.id);
    const application = website.applicationId
      ? requireLocalResource(await applicationRegistry.getApplication(website.applicationId), localServerId, 'application_not_found', 'Application not found')
      : null;
    return Object.freeze({ website, domains: Object.freeze(domains), application });
  });

  registry.bind('application.inspect', async ({ input }) => {
    const application = requireLocalResource(
      await applicationRegistry.getApplication(input.applicationId),
      localServerId,
      'application_not_found',
      'Application not found',
    );
    const jobs = (await jobRegistry.listJobs({ resourceType: 'application', resourceId: application.id }))
      .sort(newestFirst)
      .slice(0, 20)
      .map(jobPublicView);
    return Object.freeze({ application, jobs: Object.freeze(jobs) });
  });

  registry.bind('job.inspect', async ({ input }) => {
    const job = requireLocalResource(await jobRegistry.getJob(input.jobId), localServerId, 'job_not_found', 'Job not found');
    return jobPublicView(job);
  });

  if (dnsHostingRegistry && typeof dnsHostingRegistry.getZone === 'function' && typeof dnsHostingRegistry.listZones === 'function'
    && typeof domainRegistry.getDomain === 'function') {
    registry.bind('dns.inspect', async ({ input }) => {
      const hasWebsite = typeof input.websiteId === 'string';
      const hasZone = typeof input.dnsZoneId === 'string';
      if (hasWebsite === hasZone) {
        throw new AiToolRuntimeError('invalid_ai_dns_scope', 'DNS inspection requires exactly one Website or DNS zone identity');
      }
      if (hasWebsite) {
        const website = requireLocalResource(
          await websiteRegistry.getWebsite(input.websiteId),
          localServerId,
          'website_not_found',
          'Website not found',
        );
        const domains = (await domainRegistry.listDomains()).filter((domain) => domain.websiteId === website.id);
        const domainIds = new Set(domains.map((domain) => domain.id));
        const zones = (await dnsHostingRegistry.listZones()).filter((zone) => zone.webDomainId && domainIds.has(zone.webDomainId));
        return Object.freeze({ website, domains: Object.freeze(domains), zones: Object.freeze(zones) });
      }
      const zone = await dnsHostingRegistry.getZone(input.dnsZoneId);
      if (!zone) throw new AiToolRuntimeError('dns_zone_not_found', 'DNS zone not found', 404);
      const domain = zone.webDomainId ? await domainRegistry.getDomain(zone.webDomainId) : null;
      requireLocalResource(domain, localServerId, 'dns_zone_not_found', 'DNS zone not found');
      return Object.freeze({ zone, domain });
    });
  }

  if (certificateRegistry && typeof certificateRegistry.getForDomain === 'function'
    && typeof domainRegistry.getDomain === 'function') {
    registry.bind('certificate.inspect', async ({ input }) => {
      const hasWebsite = typeof input.websiteId === 'string';
      const hasDomain = typeof input.domainId === 'string';
      if (hasWebsite === hasDomain) {
        throw new AiToolRuntimeError('invalid_ai_certificate_scope', 'Certificate inspection requires exactly one Website or Domain identity');
      }
      if (hasDomain) {
        const domain = requireLocalResource(
          await domainRegistry.getDomain(input.domainId),
          localServerId,
          'domain_not_found',
          'Domain not found',
        );
        return Object.freeze({ domain, certificate: await certificateRegistry.getForDomain(domain.id) });
      }
      const website = requireLocalResource(
        await websiteRegistry.getWebsite(input.websiteId),
        localServerId,
        'website_not_found',
        'Website not found',
      );
      const domains = (await domainRegistry.listDomains()).filter((domain) => domain.websiteId === website.id);
      const certificates = await Promise.all(domains.map(async (domain) => Object.freeze({
        domain,
        certificate: await certificateRegistry.getForDomain(domain.id),
      })));
      return Object.freeze({ website, certificates: Object.freeze(certificates) });
    });
  }

  if (mailDomainRegistry && typeof mailDomainRegistry.getMailDomain === 'function'
    && typeof mailDomainRegistry.listMailDomains === 'function' && typeof domainRegistry.getDomain === 'function') {
    registry.bind('mail.inspect', async ({ input }) => {
      const hasWebsite = typeof input.websiteId === 'string';
      const hasMailDomain = typeof input.mailDomainId === 'string';
      if (hasWebsite === hasMailDomain) {
        throw new AiToolRuntimeError('invalid_ai_mail_scope', 'Mail inspection requires exactly one Website or Mail Domain identity');
      }
      if (hasWebsite) {
        const website = requireLocalResource(
          await websiteRegistry.getWebsite(input.websiteId),
          localServerId,
          'website_not_found',
          'Website not found',
        );
        const domains = (await domainRegistry.listDomains()).filter((domain) => domain.websiteId === website.id);
        const domainIds = new Set(domains.map((domain) => domain.id));
        const mailDomains = (await mailDomainRegistry.listMailDomains())
          .filter((mailDomain) => mailDomain.webDomainId && domainIds.has(mailDomain.webDomainId));
        return Object.freeze({ website, domains: Object.freeze(domains), mailDomains: Object.freeze(mailDomains) });
      }
      const mailDomain = await mailDomainRegistry.getMailDomain(input.mailDomainId);
      if (!mailDomain) throw new AiToolRuntimeError('mail_domain_not_found', 'Mail Domain not found', 404);
      const domain = mailDomain.webDomainId ? await domainRegistry.getDomain(mailDomain.webDomainId) : null;
      requireLocalResource(domain, localServerId, 'mail_domain_not_found', 'Mail Domain not found');
      return Object.freeze({ mailDomain, domain });
    });
  }

  if (databaseBindingRegistry && typeof databaseBindingRegistry.listBindings === 'function'
    && typeof databaseBindingRegistry.getByDatabase === 'function') {
    registry.bind('database.inspect', async ({ input }) => {
      const hasWebsite = typeof input.websiteId === 'string';
      const hasDatabase = typeof input.databaseName === 'string';
      if (hasWebsite === hasDatabase) {
        throw new AiToolRuntimeError('invalid_ai_database_scope', 'Database inspection requires exactly one Website or database name');
      }
      const server = await resolveLocalServer(serverRegistry, localServerId);
      if (hasDatabase) {
        return Object.freeze({
          serverId: server.id,
          binding: await databaseBindingRegistry.getByDatabase({ serverId: server.id, databaseName: input.databaseName }),
        });
      }
      const website = requireLocalResource(
        await websiteRegistry.getWebsite(input.websiteId),
        localServerId,
        'website_not_found',
        'Website not found',
      );
      const bindings = await databaseBindingRegistry.listBindings({ serverId: server.id, websiteId: website.id });
      return Object.freeze({ website, bindings: Object.freeze(bindings) });
    });
  }

  if (typeof jobRegistry.enqueue === 'function') {
    registry.bind('service.restart', async ({ input }) => {
      if (!CONTROL_SERVICE_IDS.has(input.serviceId)) {
        throw new AiToolRuntimeError('unsupported_managed_service', 'Managed service is not controllable');
      }
      const server = await resolveLocalServer(serverRegistry, localServerId);
      await ensureResourceIdle(jobRegistry, 'system', server.id);
      const job = await jobRegistry.enqueue({
        serverId: server.id,
        type: OPERATIONS.SYSTEM_SERVICE_CONTROL,
        operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
        payload: { serviceId: input.serviceId, action: 'restart' },
        resourceType: 'system',
        resourceId: server.id,
      });
      return jobPublicView(job);
    });
  }

  if (typeof jobRegistry.enqueue === 'function'
    && applicationEnvironmentRegistry
    && typeof applicationEnvironmentRegistry.environmentStatus === 'function') {
    registry.bind('website.restart', async ({ input }) => {
      const website = requireLocalResource(
        await websiteRegistry.getWebsite(input.websiteId),
        localServerId,
        'website_not_found',
        'Website not found',
      );
      if (!website.applicationId) {
        throw new AiToolRuntimeError('website_restart_not_supported', 'Website has no managed Application runtime', 409);
      }
      const application = requireLocalResource(
        await applicationRegistry.getApplication(website.applicationId),
        localServerId,
        'application_not_found',
        'Application not found',
      );
      if (!['node', 'python'].includes(application.type)) {
        throw new AiToolRuntimeError('website_restart_not_supported', 'Website restart is supported only for Node and Python Applications', 409);
      }
      if (!application.currentReleaseId) {
        throw new AiToolRuntimeError('application_not_deployed', 'Application has no active release to restart', 409);
      }
      if (application.activeDeploymentId) {
        throw new AiToolRuntimeError('deployment_in_progress', 'Application already has an active operation', 409);
      }
      await ensureResourceIdle(jobRegistry, 'application', application.id);
      const environment = await applicationEnvironmentRegistry.environmentStatus(application.id);
      const isPython = application.type === 'python';
      const job = await jobRegistry.enqueue({
        serverId: application.serverId,
        type: isPython ? 'app.python.restart' : 'app.node.restart',
        operation: isPython ? OPERATIONS.APP_PYTHON_RESTART : OPERATIONS.APP_NODE_RESTART,
        payload: {
          applicationId: application.id,
          releaseId: application.currentReleaseId,
          runtime: application.activeRuntime ?? application.runtime,
          environmentRevision: environment.savedRevision,
        },
        resourceType: 'application',
        resourceId: application.id,
      });
      return jobPublicView(job);
    });
  }

  const deployQueue = applicationDeployQueue ?? (
    applicationEnvironmentRegistry && typeof jobRegistry?.enqueue === 'function'
      ? createApplicationDeployQueue({ applicationRegistry, applicationEnvironmentRegistry, jobRegistry })
      : null
  );

  if (deployQueue) {
    registry.bind('application.deploy', async ({ input }) => {
      const application = requireLocalResource(
        await applicationRegistry.getApplication(input.applicationId),
        localServerId,
        'application_not_found',
        'Application not found',
      );
      await ensureResourceIdle(jobRegistry, 'application', application.id);
      const result = await deployQueue({
        applicationId: application.id,
        gitTarget: input.gitTarget ?? null,
      });
      return Object.freeze({
        application: result.application,
        job: jobPublicView(result.job),
        replayed: Boolean(result.replayed),
      });
    });
  }

  if (typeof jobRegistry?.enqueue === 'function' && applicationEnvironmentRegistry) {
    registry.bind('application.rollback', async ({ input }) => {
      const application = requireLocalResource(
        await applicationRegistry.getApplication(input.applicationId),
        localServerId,
        'application_not_found',
        'Application not found',
      );
      if (!['static', 'node', 'python'].includes(application.type)) {
        throw new AiToolRuntimeError('rollback_not_supported', 'Rollback is not implemented for this application type', 409);
      }
      await ensureResourceIdle(jobRegistry, 'application', application.id);
      if (application.activeDeploymentId) {
        throw new AiToolRuntimeError('deployment_in_progress', 'Application already has an active operation', 409);
      }

      const releaseId = input.releaseId ?? application.previousReleaseId;
      if (!releaseId) {
        throw new AiToolRuntimeError('rollback_release_required', 'No previous release is available for rollback', 409);
      }

      const nodeRollback = application.type === 'node';
      const pythonRollback = application.type === 'python';
      const environment = (nodeRollback || pythonRollback) ? await applicationEnvironmentRegistry.environmentStatus(application.id) : null;
      const job = await jobRegistry.enqueue({
        serverId: application.serverId,
        type: pythonRollback ? 'app.python.rollback' : (nodeRollback ? 'app.node.rollback' : 'app.static.rollback'),
        operation: pythonRollback ? OPERATIONS.APP_PYTHON_ROLLBACK : (nodeRollback ? OPERATIONS.APP_NODE_ROLLBACK : OPERATIONS.APP_STATIC_ROLLBACK),
        payload: (nodeRollback || pythonRollback)
          ? {
              applicationId: application.id,
              releaseId,
              currentReleaseId: application.currentReleaseId,
              runtime: application.releases?.find((release) => release.releaseId === releaseId)?.runtime
                ?? application.activeRuntime
                ?? application.runtime,
              environmentRevision: environment?.savedRevision ?? null,
            }
          : {
              applicationId: application.id,
              releaseId,
              currentReleaseId: application.currentReleaseId,
            },
        resourceType: 'application',
        resourceId: application.id,
      });

      const updatedApp = await applicationRegistry.markRollingBack(application.id, job.id, releaseId);
      return Object.freeze({
        application: updatedApp,
        job: jobPublicView(job),
      });
    });
  }

  if (journalLogReader || nginxLogReader) {
    registry.bind('logs.query', async ({ input }) => {
      const limit = Math.min(Math.max(1, Number(input?.limit) || 50), 200);
      const search = typeof input?.query === 'string' ? input.query.slice(0, 100) : null;
      let entries = [];
      let source = 'system';

      if (input?.applicationId) {
        const application = requireLocalResource(
          await applicationRegistry.getApplication(input.applicationId),
          localServerId,
          'application_not_found',
          'Application not found',
        );
        if (application.type === 'node' && journalLogReader) {
          const unit = `yunpanel-node-${createHash('sha256').update(application.id.toLowerCase()).digest('hex').slice(0, 16)}.service`;
          const result = await journalLogReader.query({
            unit,
            limit,
            search: search || undefined,
          });
          entries = result.entries ?? [];
          source = 'journal';
        }
      } else if (input?.websiteId) {
        const website = requireLocalResource(
          await websiteRegistry.getWebsite(input.websiteId),
          localServerId,
          'website_not_found',
          'Website not found',
        );
        if (website.applicationId && journalLogReader) {
          const app = await applicationRegistry.getApplication(website.applicationId);
          if (app && app.type === 'node') {
            const unit = `yunpanel-node-${createHash('sha256').update(app.id.toLowerCase()).digest('hex').slice(0, 16)}.service`;
            const result = await journalLogReader.query({
              unit,
              limit,
              search: search || undefined,
            });
            entries = result.entries ?? [];
            source = 'journal';
          }
        }
        if (entries.length === 0 && nginxLogReader) {
          const domains = (await domainRegistry.listDomains()).filter((d) => d.websiteId === website.id);
          const domainName = domains[0]?.domainName;
          if (domainName) {
            const result = await nginxLogReader.query({
              domain: domainName,
              limit,
              search: search || undefined,
            }).catch(() => ({ entries: [] }));
            entries = result.entries ?? [];
            source = 'nginx';
          }
        }
      } else if (journalLogReader) {
        const result = await journalLogReader.query({
          unit: 'nginx.service',
          limit,
          search: search || undefined,
        });
        entries = result.entries ?? [];
        source = 'system';
      }

      return Object.freeze({
        source,
        limit,
        count: entries.length,
        entries: Object.freeze(entries.slice(0, limit)),
      });
    });
  }

  if (dnsHostingRegistry && typeof jobRegistry?.enqueue === 'function') {
    registry.bind('dns.update', async ({ input }) => {
      const zone = await dnsHostingRegistry.getZone(input.dnsZoneId);
      if (!zone) throw new AiToolRuntimeError('dns_zone_not_found', 'DNS zone not found', 404);
      const server = await resolveLocalServer(serverRegistry, localServerId);
      await ensureResourceIdle(jobRegistry, 'dns_zone', zone.id);

      const job = await jobRegistry.enqueue({
        serverId: server.id,
        type: 'dns.record.apply',
        operation: OPERATIONS.DNS_RECORD_APPLY,
        payload: {
          dnsZoneId: zone.id,
          zoneName: zone.zoneName,
          change: input.change,
        },
        resourceType: 'dns_zone',
        resourceId: zone.id,
      });

      return Object.freeze({
        zone,
        job: jobPublicView(job),
      });
    });
  }

  if (certificateRegistry && typeof jobRegistry?.enqueue === 'function') {
    registry.bind('certificate.issue', async ({ input }) => {
      const domain = requireLocalResource(
        await domainRegistry.getDomain(input.domainId),
        localServerId,
        'domain_not_found',
        'Domain not found',
      );
      await ensureResourceIdle(jobRegistry, 'certificate', domain.id);
      const server = await resolveLocalServer(serverRegistry, localServerId);

      const job = await jobRegistry.enqueue({
        serverId: server.id,
        type: 'ssl.issue',
        operation: OPERATIONS.SSL_ISSUE,
        payload: {
          domainId: domain.id,
          domains: [domain.domainName],
        },
        resourceType: 'certificate',
        resourceId: domain.id,
      });

      return Object.freeze({
        domain,
        job: jobPublicView(job),
      });
    });

    registry.bind('certificate.renew', async ({ input }) => {
      const cert = await certificateRegistry.getCertificate(input.certificateId);
      if (!cert) throw new AiToolRuntimeError('certificate_not_found', 'Certificate not found', 404);
      await ensureResourceIdle(jobRegistry, 'certificate', cert.id);
      const server = await resolveLocalServer(serverRegistry, localServerId);

      const job = await jobRegistry.enqueue({
        serverId: server.id,
        type: 'ssl.renew',
        operation: OPERATIONS.SSL_RENEW,
        payload: {
          certName: cert.certName,
          certificateId: cert.id,
        },
        resourceType: 'certificate',
        resourceId: cert.id,
      });

      return Object.freeze({
        certificate: cert,
        job: jobPublicView(job),
      });
    });
  }

  if (websiteBackupSetProvider) {
    registry.bind('backup.inspect', async ({ input }) => {
      const website = requireLocalResource(
        await websiteRegistry.getWebsite(input.websiteId),
        localServerId,
        'website_not_found',
        'Website not found',
      );
      const server = await resolveLocalServer(serverRegistry, localServerId);
      const backupSet = await websiteBackupSetProvider.getWebsiteBackupSet({
        websiteId: website.id,
        serverId: server.id,
      });
      return Object.freeze({ website, backupSet });
    });
  }

  if (websiteBackupService) {
    registry.bind('backup.create', async ({ input }) => {
      const website = requireLocalResource(
        await websiteRegistry.getWebsite(input.websiteId),
        localServerId,
        'website_not_found',
        'Website not found',
      );
      const result = await websiteBackupService.executeBackup({
        websiteId: website.id,
        tags: ['ai-agent'],
      });
      return Object.freeze({ website, result });
    });
  }

  if (websiteRestoreService) {
    registry.bind('backup.restore', async ({ input }) => {
      const website = requireLocalResource(
        await websiteRegistry.getWebsite(input.websiteId),
        localServerId,
        'website_not_found',
        'Website not found',
      );
      const result = await websiteRestoreService.executeRestore({
        websiteId: website.id,
        snapshotId: input.snapshotId,
      });
      return Object.freeze({ website, result });
    });
  }

  return registry;
}

export const aiToolRuntimeInternals = Object.freeze({
  requireLocalResource,
  resolveLocalServer,
  ensureResourceIdle,
  newestFirst,
});
