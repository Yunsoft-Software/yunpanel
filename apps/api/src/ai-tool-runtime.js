import { MANAGED_SERVICE_CONTROL_IDS, OPERATIONS } from '@yunpanel/protocol';
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
  dnsHostingRegistry = null,
  certificateRegistry = null,
  mailDomainRegistry = null,
  databaseBindingRegistry = null,
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

  return registry;
}

export const aiToolRuntimeInternals = Object.freeze({
  requireLocalResource,
  resolveLocalServer,
  ensureResourceIdle,
  newestFirst,
});
