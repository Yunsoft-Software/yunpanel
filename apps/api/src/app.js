import express from 'express';
import {
  createCloudflareDnsManager,
  CloudflareDnsManagerError,
  createMailDiagnosticsInspector,
  MailDiagnosticsInspectorError,
  createMailboxQuotaInspector,
} from '@yunpanel/host-runtime';
import { mountApplicationConfigurationRoutes } from './application-configuration-http.js';
import { mountApplicationProcessRoutes } from './application-process-http.js';
import { createApplicationRegistry, ApplicationRegistryError } from './application-registry.js';
import { CertificateRegistryError, createCertificateRegistry } from './certificate-registry.js';
import { CertificateMaterialError, createCertificateMaterialManager } from './certificate-material-manager.js';
import { mountCertificateRoutes } from './certificate-http.js';
import { createApp as createCoreApp } from './core-app.js';
import { DatabaseHttpError, mountDatabaseRoutes } from './database-http.js';
import { createDnsHostingRegistry } from './dns-hosting-registry.js';
import {
  createDnsProviderCredentialRegistry,
  DnsProviderCredentialRegistryError,
} from './dns-provider-credential-registry.js';
import { createDnsReadinessService, DnsReadinessError } from './dns-readiness.js';
import { createDomainRegistry, DomainRegistryError } from './domain-registry.js';
import {
  createDomainHandler,
  createDomainReparentHandler,
  createDomainReparentPreviewHandler,
  createDomainUpdateHandler,
  createDomainUpdatePreviewHandler,
} from './domain-http.js';
import { mountDockerWorkloadRoutes } from './docker-workload-http.js';
import { createDockerWorkloadRegistry, DockerWorkloadRegistryError } from './docker-workload-registry.js';
import { mountExternalLifecycleRoutes } from './external-lifecycle-http.js';
import { ExternalLifecycleRegistryError } from './external-lifecycle-registry.js';
import { createJobRegistry, JobRegistryError } from './job-registry.js';
import { mountMailAliasRoutes } from './mail-alias-http.js';
import { createMailAliasRegistry, MailAliasRegistryError } from './mail-alias-registry.js';
import { createMailConfigurationService, MailConfigurationError } from './mail-configuration.js';
import { MailConfigurationHttpError, mountMailConfigurationRoutes } from './mail-configuration-http.js';
import { MailDkimConfigurationError } from './mail-dkim-configuration.js';
import { createMailDkimDnsService, MailDkimDnsError } from './mail-dkim-dns.js';
import { MailDkimDnsHttpError, mountMailDkimDnsRoutes } from './mail-dkim-dns-http.js';
import { mountMailDkimRoutes, MailDkimHttpError } from './mail-dkim-http.js';
import { createMailDkimRegistry, MailDkimRegistryError } from './mail-dkim-registry.js';
import {
  createMailDkimRetirementRegistry,
  MailDkimRetirementRegistryError,
} from './mail-dkim-retirement-registry.js';
import { MailDiagnosticsHttpError, mountMailDiagnosticsRoutes } from './mail-diagnostics-http.js';
import { createMailDomainRegistry } from './mail-domain-registry.js';
import { mountMailServiceIdentityRoutes } from './mail-service-identity-http.js';
import { MailServiceIdentityRegistryError } from './mail-service-identity-registry.js';
import { mountMailboxForwardingRoutes } from './mailbox-forwarding-http.js';
import {
  createMailboxForwardingRegistry,
  MailboxForwardingRegistryError,
} from './mailbox-forwarding-registry.js';
import { MailboxQuotaHttpError, mountMailboxQuotaRoutes } from './mailbox-quota-http.js';
import { createMailboxQuotaRegistry, MailboxQuotaRegistryError } from './mailbox-quota-registry.js';
import { createMailboxRegistry, MailboxRegistryError } from './mailbox-registry.js';
import { mountMailboxRoutes } from './mailbox-http.js';
import { MailboxPasswordError } from './mailbox-password.js';
import { LogHttpError, mountLogRoutes } from './log-http.js';
import { ManagedServiceHttpError, mountManagedServiceRoutes } from './managed-service-http.js';
import { mountNodeRuntimeRoutes, NodeRuntimeHttpError } from './node-runtime-http.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { ResourceImpactError } from './resource-impact.js';
import { mountResourceImpactRoutes } from './resource-impact-http.js';
import { createServerRegistry, RegistryError } from './server-registry.js';
import { SiteFileHttpError, mountSiteFileRoutes } from './site-file-http.js';
import { createSiteFileManager, SiteFileManagerError } from './site-file-manager.js';
import { SiteFileWorkerError } from './site-file-worker.js';
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

function localServerRegistryView(registry, localServerId) {
  if (!localServerId) return registry;
  return new Proxy(registry, {
    get(target, property) {
      if (property === 'getServer') {
        return async (serverId) => {
          if (serverId !== localServerId) return null;
          const server = await target.getServer(serverId);
          return server?.executionMode === 'local' ? server : null;
        };
      }
      if (property === 'listServers') {
        return async () => (await target.listServers()).filter((server) => server.id === localServerId && server.executionMode === 'local');
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createApp({
  registry = createServerRegistry(),
  jobRegistry = createJobRegistry(),
  certificateRegistry = createCertificateRegistry(),
  certificateMaterialManager = createCertificateMaterialManager(),
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
  dnsProviderCredentialRegistry = createDnsProviderCredentialRegistry({
    getDnsZone: async (dnsZoneId) => dnsHostingRegistry.getZone(dnsZoneId),
  }),
  dnsReadinessService = null,
  dnsRecordManager = createCloudflareDnsManager(),
  mailDomainRegistry = createMailDomainRegistry({
    getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  }),
  mailDkimRegistry = createMailDkimRegistry({
    getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
  }),
  mailDkimRetirementRegistry = createMailDkimRetirementRegistry({
    getDkimKey: async (mailDomainId) => mailDkimRegistry.getKey(mailDomainId),
  }),
  mailDiagnosticsInspector = createMailDiagnosticsInspector(),
  mailDkimConfigurationService = null,
  mailDkimDnsService = null,
  mailServiceIdentityRegistry = null,
  mailboxRegistry = createMailboxRegistry({
    getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
  }),
  mailboxQuotaRegistry = createMailboxQuotaRegistry({
    getMailbox: async (mailboxId) => mailboxRegistry.getMailbox(mailboxId),
  }),
  mailboxQuotaInspector = createMailboxQuotaInspector(),
  mailboxForwardingRegistry = createMailboxForwardingRegistry({
    getMailbox: async (mailboxId) => mailboxRegistry.getMailbox(mailboxId),
  }),
  mailAliasRegistry = createMailAliasRegistry({
    getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
    listMailboxes: (filter) => mailboxRegistry.listMailboxes(filter),
  }),
  mailConfigurationService = null,
  environment = process.env.NODE_ENV,
  journalLogReader = null,
  nginxLogReader = null,
  jobLogStore = null,
  localServerId = null,
  terminalCapabilityRegistry = null,
  siteFileManager = null,
  ...options
} = {}) {
  const core = createCoreApp({
    ...options,
    registry,
    domainRegistry,
    jobRegistry,
    certificateRegistry,
    certificateMaterialManager,
    applicationRegistry,
    environment,
    localServerId,
    dnsHostingRegistry,
    dnsProviderCredentialRegistry,
  });
  const app = express();
  const localRegistry = localServerRegistryView(registry, localServerId);
  const files = siteFileManager ?? createSiteFileManager({ websiteRegistry, localServerId });
  const readiness = dnsReadinessService ?? createDnsReadinessService({
    dnsHostingRegistry,
    domainRegistry,
    serverRegistry: registry,
    dnsProviderCredentialRegistry,
  });
  const mailConfig = mailConfigurationService ?? createMailConfigurationService({
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    ...(mailServiceIdentityRegistry ? { domainRegistry, mailServiceIdentityRegistry } : {}),
  });
  const canCreateDkimDnsService = typeof dnsHostingRegistry?.listZones === 'function'
    && typeof dnsProviderCredentialRegistry?.getForZone === 'function'
    && typeof dnsProviderCredentialRegistry?.materialize === 'function'
    && typeof dnsRecordManager?.inspectRecord === 'function'
    && typeof jobRegistry?.enqueue === 'function' && typeof jobRegistry?.listJobs === 'function';
  const dkimDns = mailDkimDnsService ?? (canCreateDkimDnsService ? createMailDkimDnsService({
    mailDomainRegistry,
    mailDkimRegistry,
    mailDkimRetirementRegistry,
    domainRegistry,
    dnsHostingRegistry,
    dnsProviderCredentialRegistry,
    dnsRecordManager,
    jobRegistry,
    localServerId,
  }) : null);
  app.disable('x-powered-by');
  mountSiteFileRoutes(app, { siteFileManager: files });
  app.use(express.json({ limit: '256kb' }));
  mountCertificateRoutes(app, {
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager,
    jobRegistry,
    localServerId,
  });
  app.post('/api/domains', requirePanelRouteAccess, createDomainHandler(domainRegistry, { localServerId }));
  app.post('/api/domains/:domainId/update-preview', requirePanelRouteAccess, createDomainUpdatePreviewHandler(domainRegistry, { localServerId }));
  app.patch('/api/domains/:domainId', requirePanelRouteAccess, createDomainUpdateHandler(domainRegistry, { jobRegistry, certificateRegistry, localServerId }));
  app.post('/api/domains/:domainId/reparent-preview', requirePanelRouteAccess, createDomainReparentPreviewHandler(domainRegistry, { localServerId }));
  app.post('/api/domains/:domainId/reparent', requirePanelRouteAccess, createDomainReparentHandler(domainRegistry, { localServerId }));
  mountSiteCreateRoutes(app, { registry: localRegistry, applicationRegistry, dockerWorkloadRegistry, websiteRegistry, domainRegistry, localServerId });
  mountResourceImpactRoutes(app, {
    registry: localRegistry,
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    localServerId,
    additionalProviders: {
      dockerWorkloads: async ({ dockerWorkloadId }) => {
        if (!dockerWorkloadId) return [];
        const workload = await dockerWorkloadRegistry.getWorkload(dockerWorkloadId);
        if (!workload) throw new Error('Docker workload reference is unavailable');
        return [{ id: workload.id, state: workload.state }];
      },
      mailboxes: async ({ domainIds }) => {
        const impactedDomains = new Set(domainIds);
        const mailDomainIds = new Set((await mailDomainRegistry.listMailDomains())
          .filter((item) => item.webDomainId !== null && impactedDomains.has(item.webDomainId))
          .map((item) => item.id));
        return (await mailboxRegistry.listMailboxes())
          .filter((item) => mailDomainIds.has(item.mailDomainId))
          .map((item) => ({ id: item.id, state: item.enabled ? 'enabled' : 'disabled' }));
      },
    },
  });
  mountExternalLifecycleRoutes(app, {
    dnsHostingRegistry,
    dnsProviderCredentialRegistry,
    dnsReadinessService: readiness,
    dnsRecordManager,
    domainRegistry,
    jobRegistry,
    localServerId,
    mailDomainRegistry,
  });
  mountMailAliasRoutes(app, { mailAliasRegistry, mailDomainRegistry, domainRegistry, localServerId });
  mountMailboxRoutes(app, {
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDomainRegistry,
    domainRegistry,
    localServerId,
  });
  mountMailboxQuotaRoutes(app, {
    mailboxQuotaRegistry,
    mailboxQuotaInspector,
    mailboxRegistry,
    mailDomainRegistry,
    domainRegistry,
    localServerId,
  });
  mountMailboxForwardingRoutes(app, {
    mailboxForwardingRegistry,
    mailboxRegistry,
    mailDomainRegistry,
    domainRegistry,
    localServerId,
  });
  mountMailDkimRoutes(app, {
    mailDkimRegistry,
    mailDkimRetirementRegistry,
    mailDkimConfigurationService,
    mailDkimDnsService: dkimDns,
    mailDomainRegistry,
    domainRegistry,
    jobRegistry: mailDkimConfigurationService ? jobRegistry : null,
    localServerId,
  });
  if (dkimDns) mountMailDkimDnsRoutes(app, { mailDkimDnsService: dkimDns });
  mountMailDiagnosticsRoutes(app, {
    mailDiagnosticsInspector,
    mailDkimRegistry,
    mailDomainRegistry,
    domainRegistry,
    localServerId,
  });
  if (mailServiceIdentityRegistry) {
    mountMailServiceIdentityRoutes(app, {
      mailServiceIdentityRegistry,
      mailDomainRegistry,
      domainRegistry,
      jobRegistry,
      localServerId,
    });
  }
  mountMailConfigurationRoutes(app, {
    mailConfigurationService: mailConfig,
    mailDomainRegistry,
    domainRegistry,
    jobRegistry,
    localServerId,
  });
  mountDockerWorkloadRoutes(app, { dockerWorkloadRegistry, localServerId });
  mountApplicationConfigurationRoutes(app, { applicationRegistry, jobRegistry, localServerId });
  mountApplicationProcessRoutes(app, { applicationRegistry, jobRegistry, localServerId });
  mountWebsiteRoutes(app, { websiteRegistry, domainRegistry, localServerId });
  mountWebsiteMigrationRoutes(app, {
    websiteRegistry,
    domainRegistry,
    applicationRegistry,
    websiteMigrationPolicy,
    migrationLedger,
    localServerId,
  });
  mountManagedServiceRoutes(app, { registry: localRegistry, jobRegistry });
  mountNodeRuntimeRoutes(app, { registry: localRegistry, jobRegistry });
  mountDatabaseRoutes(app, { registry: localRegistry, jobRegistry });
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
      || error instanceof CertificateMaterialError
      || error instanceof CertificateRegistryError
      || error instanceof ApplicationRegistryError
      || error instanceof DomainRegistryError
      || error instanceof DockerWorkloadRegistryError
      || error instanceof DnsProviderCredentialRegistryError
      || error instanceof DnsReadinessError
      || error instanceof CloudflareDnsManagerError
      || error instanceof ExternalLifecycleRegistryError
      || error instanceof RegistryError
      || error instanceof JobRegistryError
      || error instanceof LogHttpError
      || error instanceof ManagedServiceHttpError
      || error instanceof MailAliasRegistryError
      || error instanceof MailConfigurationError
      || error instanceof MailConfigurationHttpError
      || error instanceof MailDkimConfigurationError
      || error instanceof MailDkimDnsError
      || error instanceof MailDkimDnsHttpError
      || error instanceof MailDkimHttpError
      || error instanceof MailDkimRegistryError
      || error instanceof MailDkimRetirementRegistryError
      || error instanceof MailDiagnosticsHttpError
      || error instanceof MailDiagnosticsInspectorError
      || error instanceof MailServiceIdentityRegistryError
      || error instanceof MailboxForwardingRegistryError
      || error instanceof MailboxQuotaRegistryError
      || error instanceof MailboxQuotaHttpError
      || error instanceof MailboxRegistryError
      || error instanceof MailboxPasswordError
      || error instanceof NodeRuntimeHttpError
      || error instanceof ResourceImpactError
      || error instanceof SiteFileHttpError
      || error instanceof SiteFileManagerError
      || error instanceof SiteFileWorkerError
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
    const bodyTooLarge = error?.type === 'entity.too.large' || error?.status === 413;
    return response.status(bodyTooLarge ? 413 : invalidJson ? 400 : 500).json({
      error: {
        code: bodyTooLarge ? 'request_body_too_large' : invalidJson ? 'invalid_json' : 'internal_error',
        message: bodyTooLarge ? 'Request body is too large' : invalidJson ? 'Invalid JSON body' : 'Unexpected server error',
      },
    });
  });
  return app;
}