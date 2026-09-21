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

export function createAiToolRuntime({
  serverRegistry,
  websiteRegistry,
  domainRegistry,
  applicationRegistry,
  jobRegistry,
  localServerId = null,
} = {}) {
  requireDependencies({ serverRegistry, websiteRegistry, domainRegistry, applicationRegistry, jobRegistry });
  const registry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });

  registry.bind('server.health', async () => {
    let server = null;
    if (localServerId) server = await serverRegistry.getServer(localServerId);
    else {
      const servers = await serverRegistry.listServers();
      if (servers.length !== 1) {
        throw new AiToolRuntimeError('ai_local_server_ambiguous', 'AI server health requires one unambiguous local Server', 409);
      }
      [server] = servers;
    }
    requireLocalResource(server, localServerId, 'server_not_found', 'Server not found');
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

  return registry;
}

export const aiToolRuntimeInternals = Object.freeze({ requireLocalResource, newestFirst });
