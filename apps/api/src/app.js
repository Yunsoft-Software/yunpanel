import express from 'express';
import { mountApplicationConfigurationRoutes } from './application-configuration-http.js';
import { mountApplicationProcessRoutes } from './application-process-http.js';
import { createApplicationRegistry, ApplicationRegistryError } from './application-registry.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { createApp as createCoreApp } from './core-app.js';
import { DatabaseHttpError, mountDatabaseRoutes } from './database-http.js';
import { createDnsHostingRegistry } from './dns-hosting-registry.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import { createDomainHandler, createDomainReparentHandler, createDomainReparentPreviewHandler } from './domain-http.js';
import { mountDockerWorkloadRoutes } from './docker-workload-http.js';
import { createDockerWorkloadRegistry, DockerWorkloadRegistryError } from './docker-workload-registry.js';
import { mountExternalLifecycleRoutes } from './external-lifecycle-http.js';
import { ExternalLifecycleRegistryError } from './external-lifecycle-registry.js';
import { createJobRegistry, JobRegistryError } from './job-registry.js';
import { createMailDomainRegistry } from './mail-domain-registry.js';
import { LogHttpError, mountLogRoutes } from './log-http.js';
import { ManagedServiceHttpError, mountManagedServiceRoutes } from './managed-service-http.js';
import { mountNodeRuntimeRoutes, NodeRuntimeHttpError } from './node-runtime-http.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { ResourceImpactError } from './resource-impact.js';
import { mountResourceImpactRoutes } from './resource-impact-http.js';
import { createServerRegistry, RegistryError } from './server-registry.js';
import { SiteCreateError } from './site-create.js';
import { mountSiteCreateRoutes } from './site-create-http.js';
import { mountTerminalCapabilityRoutes } from './terminal-capability-http.js';
import { TerminalCapabilityError } from './terminal-capability-registry.js';
import { mountWebsiteRoutes } from './website-http.js';
import { WebsiteMigrationBindError } from './website-migration-bind.js';
import { WebsiteMigrationCreateError } from './website-migration-create.js';
import { mountWebsiteMigrationRoutes } from './website-migration-http.js';
import { createWebsiteMigrationLedger, WebsiteMigrationLedgerError } from './website-migration-ledger.js';
import { createWebsiteMigrationPolicyStore, WebsiteMigrationPolicyError } from './website-migration-policy.js';
import { WebsiteMigrationPreviewError } from './website-migration-preview.js';
import { WebsiteMigrationRollbackError } from './website-migration-rollback.js';
import { createWebsiteRegistry, WebsiteRegistryError } from './website-registry.js';

export { API_VERSION } from './core-app.js';

export function createApp({
  registry = createServerRegistry(),
  jobRegistry = createJobRegistry(),
  certificateRegistry = createCertificateRegistry(),
  applicationRegistry = createApplicationRegistry(),
  dockerWorkloadRegistry = createDockerWorkloadRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  }),
  websiteRegistry = createWebsiteRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
    getDockerWorkload: async (workloadId) => dockerWorkloadRegistry.getWorkload(workloadId),
  }),
  websiteMigrationPolicy = createWebsiteMigrationPolicyStore(),
  migrationLedger = createWebsiteMigrationLedger(),
  domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
    getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
    websiteBindingRequired: () => websiteMigrationPolicy.snapshot().websiteBindingRequired,
  }),
  dnsHostingRegistry = createDnsHostingRegistry({
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  }),
  mailDomainRegistry = createMailDomainRegistry({
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  }),
  environment = process.env.NODE_ENV,
  journalLogReader = null,
  nginxLogReader = null,
  jobLogStore = null,
  localServerId = null,
  terminalCapabilityRegistry = null,
  ...options
} = {}) {
  const core = createCoreApp({ ...options, registry, domainRegistry, jobRegistry, certificateRegistry, applicationRegistry, environment });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.post('/api/domains', requirePanelRouteAccess, createDomainHandler(domainRegistry));
  app.post('/api/domains/:domainId/reparent-preview', requirePanelRouteAccess, createDomainReparentPreviewHandler(domainRegistry));
  app.post('/api/domains/:domainId/reparent', requirePanelRouteAccess, createDomainReparentHandler(domainRegistry));
  mountSiteCreateRoutes(app, { registry, applicationRegistry, dockerWorkloadRegistry, websiteRegistry, domainRegistry });
  mountResourceImpactRoutes(app, {
    registry,
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    additionalProviders: {
      dockerWorkloads: async ({ dockerWorkloadId }) => {
        if (!dockerWorkloadId) return [];
        const workload = await dockerWorkloadRegistry.getWorkload(dockerWorkloadId);
        if (!workload) throw new Error('Docker workload reference is unavailable');
        return [{ id: workload.id, state: workload.state }];
      },
    },
  });
  mountExternalLifecycleRoutes(app, { dnsHostingRegistry, mailDomainRegistry });
  mountDockerWorkloadRoutes(app, { dockerWorkloadRegistry });
  mountApplicationConfigurationRoutes(app, { applicationRegistry, jobRegistry });
  mountApplicationProcessRoutes(app, { applicationRegistry, jobRegistry });
  mountWebsiteRoutes(app, { websiteRegistry, domainRegistry });
  mountWebsiteMigrationRoutes(app, {
    websiteRegistry,
    domainRegistry,
    applicationRegistry,
    websiteMigrationPolicy,
    migrationLedger,
  });
  mountManagedServiceRoutes(app, { registry, jobRegistry });
  mountNodeRuntimeRoutes(app, { registry, jobRegistry });
  mountDatabaseRoutes(app, { registry, jobRegistry });
  mountLogRoutes(app, {
    registry, applicationRegistry, jobRegistry, journalLogReader, nginxLogReader, jobLogStore, localServerId,
  });
  mountTerminalCapabilityRoutes(app, {
    terminalCapabilityRegistry, serverRegistry: registry, websiteRegistry, localServerId,
  });
  app.use(core);
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (
      error instanceof DatabaseHttpError
      || error instanceof ApplicationRegistryError
      || error instanceof DomainRegistryError
      || error instanceof DockerWorkloadRegistryError
      || error instanceof ExternalLifecycleRegistryError
      || error instanceof RegistryError
      || error instanceof JobRegistryError
      || error instanceof LogHttpError
      || error instanceof ManagedServiceHttpError
      || error instanceof NodeRuntimeHttpError
      || error instanceof ResourceImpactError
      || error instanceof SiteCreateError
      || error instanceof TerminalCapabilityError
      || error instanceof WebsiteMigrationBindError
      || error instanceof WebsiteMigrationCreateError
      || error instanceof WebsiteMigrationLedgerError
      || error instanceof WebsiteMigrationPolicyError
      || error instanceof WebsiteMigrationPreviewError
      || error instanceof WebsiteMigrationRollbackError
      || error instanceof WebsiteRegistryError
    ) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    const invalidJson = error instanceof SyntaxError && error.status === 400;
    return response.status(invalidJson ? 400 : 500).json({
      error: {
        code: invalidJson ? 'invalid_json' : 'internal_error',
        message: invalidJson ? 'Invalid JSON body' : 'Unexpected server error',
      },
    });
  });
  return app;
}
