import express from 'express';
import {
  createCloudflareDnsManager,
  CloudflareDnsManagerError,
  createMailDataBackupManager,
  MailDataBackupError,
  createMailDataInspector,
  createMailDiagnosticsInspector,
  MailDataInspectorError,
  MailDiagnosticsInspectorError,
  createMailboxQuotaInspector,
} from '@yunpanel/host-runtime';
import { mountApplicationConfigurationRoutes } from './application-configuration-http.js';
import { mountApplicationPassengerMigrationRoutes } from './application-passenger-migration-http.js';
import { mountApplicationProcessRoutes } from './application-process-http.js';
import { createApplicationRegistry, ApplicationRegistryError } from './application-registry.js';
import { ApplicationRuntimeBindingRegistryError } from './application-runtime-binding-registry.js';
import { createDomainRemovalBackupImpactProvider } from './domain-removal-backup-impact.js';
import { isBackupHttpError, mountBackupRoutes } from './backup-http.js';
import { createBackupProductionRuntime } from './backup-production-runtime.js';
import { createBackupResourceProvider } from './backup-resource-provider.js';
import { CertificateRegistryError, createCertificateRegistry } from './certificate-registry.js';
import { CertificateMaterialError, createCertificateMaterialManager } from './certificate-material-manager.js';
import { mountCertificateRoutes } from './certificate-http.js';
import { createApp as createCoreApp } from './core-app.js';
import { DatabaseBindingHttpError, mountDatabaseBindingRoutes } from './database-binding-http.js';
import { DatabaseBindingRegistryError } from './database-binding-registry.js';
import { createDatabaseCredentialApplyService, DatabaseCredentialApplyError } from './database-credential-apply-service.js';
import { DatabaseCredentialHttpError, mountDatabaseCredentialRoutes } from './database-credential-http.js';
import { DatabaseCredentialRegistryError } from './database-credential-registry.js';
import { DatabaseHttpError, databaseHttpInternals, mountDatabaseRoutes } from './database-http.js';
import { mountPhpMyAdminHandoffRoutes } from './phpmyadmin-handoff-http.js';
import { PhpMyAdminHandoffError } from './phpmyadmin-handoff-service.js';
import { mountWebsiteDatabaseDataRoutes } from './website-database-data-http.js';
import { mountWebsiteDatabaseDeleteRoutes, WebsiteDatabaseDeleteHttpError } from './website-database-delete-http.js';
import { createDnsHostingRegistry } from './dns-hosting-registry.js';
import { DnsZoneMailDkimRetirementHttpError } from './dns-zone-mail-dkim-retirement-http.js';
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
import {
  DomainSuspensionHttpError,
  mountDomainSuspensionRoutes,
} from './domain-suspension-http.js';
import {
  WebsiteSuspensionHttpError,
  mountWebsiteSuspensionRoutes,
} from './website-suspension-http.js';
import {
  DomainRemovalHttpError,
  mountDomainRemovalRoutes,
} from './domain-removal-http.js';
import {
  WebsiteRemovalHttpError,
  mountWebsiteRemovalRoutes,
} from './website-removal-http.js';
import { mountDockerWorkloadRoutes } from './docker-workload-http.js';
import { createDockerWorkloadRegistry, DockerWorkloadRegistryError } from './docker-workload-registry.js';
import { mountExternalLifecycleRoutes } from './external-lifecycle-http.js';
import { ExternalLifecycleRegistryError } from './external-lifecycle-registry.js';
import { createJobRegistry, JobRegistryError } from './job-registry.js';
import { mountElFinderHandoffRoutes } from './elfinder-handoff-http.js';
import { ElFinderHandoffError } from './elfinder-handoff-service.js';
import { mountMailAliasRoutes } from './mail-alias-http.js';
import { createMailAliasRegistry, MailAliasRegistryError } from './mail-alias-registry.js';
import { createMailConfigurationService, MailConfigurationError } from './mail-configuration.js';
import { MailConfigurationHttpError, mountMailConfigurationRoutes } from './mail-configuration-http.js';
import { MailDataHttpError, mountMailDataRoutes } from './mail-data-http.js';
import { createMailDataOperationsService, MailDataOperationsError } from './mail-data-operations.js';
import { MailDomainDeleteHttpError, mountMailDomainDeleteRoute } from './mail-domain-delete-http.js';
import { createMailDeleteFinalizeService, MailDeleteFinalizeError } from './mail-delete-finalize.js';
import { createMailDeleteImpactService, MailDeleteImpactError } from './mail-delete-impact.js';
import { mountMailDeleteImpactRoutes } from './mail-delete-impact-http.js';
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
import { MailSrsConfigurationError } from './mail-srs-configuration.js';
import { MailSrsHttpError, mountMailSrsRoutes } from './mail-srs-http.js';
import { MailSrsSecretRegistryError } from './mail-srs-secret-registry.js';
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
import { PowerDnsAuthoritativeServiceError } from './powerdns-authoritative-service.js';
import { mountPowerDnsRoutes, PowerDnsHttpError } from './powerdns-http.js';
import { PowerDnsSecretRegistryError } from './powerdns-secret-registry.js';
import { createDnsZoneRetirementService } from './dns-zone-retirement.js';
import { ResourceImpactError } from './resource-impact.js';
import { mountResourceImpactRoutes } from './resource-impact-http.js';
import { createAllWebsiteImpactProviders } from './website-delete-impact-providers.js';
import { RoundcubeConfigurationError } from './roundcube-configuration.js';
import { RoundcubeConfigurationHttpError, mountRoundcubeConfigurationRoutes } from './roundcube-configuration-http.js';
import {
  mountRoundcubeDomainMappingRoutes,
  RoundcubeDomainMappingHttpError,
} from './roundcube-domain-mapping-http.js';
import { RoundcubeDomainMappingRegistryError } from './roundcube-domain-mapping-registry.js';
import { RoundcubeDomainMappingServiceError } from './roundcube-domain-mapping-service.js';
import { RoundcubeSecretRegistryError } from './roundcube-secret-registry.js';
import { createServerRegistry, RegistryError } from './server-registry.js';
import { ServerDnsIdentityRegistryError } from './server-dns-identity-registry.js';
import { SiteFileHttpError, mountSiteFileRoutes } from './site-file-http.js';
import { createSiteFileManager, SiteFileManagerError } from './site-file-manager.js';
import { SiteFileWorkerError } from './site-file-worker.js';
import { SiteCreateError } from './site-create.js';
import { mountSiteCreateRoutes } from './site-create-http.js';
import { mountTerminalCapabilityRoutes } from './terminal-capability-http.js';
import { TerminalCapabilityError } from './terminal-capability-registry.js';
import { mountTtydSessionRoutes } from './ttyd-session-http.js';
import { TtydSessionError } from './ttyd-session-manager.js';
import { mountWebsiteRoutes } from './website-http.js';
import { WebsiteMigrationBindError } from './website-migration-bind.js';
import { WebsiteMigrationCreateError } from './website-migration-create.js';
import { mountWebsiteMigrationRoutes } from './website-migration-http.js';
import { createWebsiteMigrationLedger, WebsiteMigrationLedgerError } from './website-migration-ledger.js';
import { createWebsiteMigrationPolicyStore, WebsiteMigrationPolicyError } from './website-migration-policy.js';
import { WebsiteMigrationPreviewError } from './website-migration-preview.js';
import { WebsiteMigrationRollbackError } from './website-migration-rollback.js';
import { createWebsiteRegistry, WebsiteRegistryError } from './website-registry.js';
import { WebsiteProvisioningHandlerError } from './website-provisioning-handlers.js';
import { mountWebsiteProvisioningRoutes, WebsiteProvisioningHttpError } from './website-provisioning-http.js';
import { WebsiteProvisioningOrchestratorError } from './website-provisioning-orchestrator.js';
import { WebsiteProvisioningRegistryError } from './website-provisioning-registry.js';
import { mountWebsiteSftpKeyRoutes, WebsiteSftpKeyHttpError } from './website-sftp-key-http.js';
import { WebsiteSftpKeyRegistryError } from './website-sftp-key-registry.js';
import { WebsiteSftpKeyServiceError } from './website-sftp-key-service.js';
import { mountWebsiteCronRoutes, WebsiteCronHttpError } from './website-cron-http.js';
import { WebsiteCronApplyServiceError } from './website-cron-apply-service.js';
import { WebsiteCronRegistryError } from './website-cron-registry.js';
import { mountWebsitePhpToolsRoutes } from './website-php-tools-http.js';
import { WebsitePhpToolsServiceError } from './website-php-tools-service.js';
import { PhpCliToolError } from '@yunpanel/host-runtime';

const DOCKER_COMPOSE_API_CONTEXT = Symbol.for('yunpanel.docker-compose-api-context');

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
  certificateMaterialGc = null,
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
  serverDnsIdentityRegistry = null,
  powerDnsAuthoritativeService = null,
  powerDnsSecretRegistry = null,
  dnsZoneTemplateRegistry = null,
  dnsZoneReapplyRuntime = null,
  dnsZoneRetirementImpactService = null,
  dnsZoneRetirementPolicy = null,
  databaseBindingRegistry = null,
  databaseCredentialRegistry = null,
  databaseCredentialApplyService = null,
  phpMyAdminHandoffService = null,
  elFinderHandoffService = null,
  databaseInventoryProvider = null,
  databaseHealthProvider = null,
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
  mailDataInspector = createMailDataInspector(),
  mailDataBackupManager = createMailDataBackupManager(),
  mailDataOperationsService = null,
  mailDiagnosticsInspector = createMailDiagnosticsInspector(),
  mailDeleteImpactService = null,
  mailDeleteFinalizeService = null,
  mailDkimConfigurationService = null,
  mailDkimDnsService = null,
  mailServiceIdentityRegistry = null,
  mailDiscoveryEndpointResolver = null,
  roundcubeWebmailEndpointResolver = null,
  mailSrsConfigurationService = null,
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
  roundcubeConfigurationService = null,
  roundcubeDomainMappingRegistry = null,
  roundcubeDomainMappingService = null,
  environment = process.env.NODE_ENV,
  journalLogReader = null,
  nginxLogReader = null,
  jobLogStore = null,
  localServerId = null,
  terminalCapabilityRegistry = null,
  ttydSessionManager = null,
  siteFileManager = null,
  websiteProvisioningRuntime = null,
  websiteSftpKeyRegistry = null,
  websiteSftpKeyService = null,
  websiteCronApplyService = null,
  websitePhpToolsService = null,
  databaseBackupService = null,
  domainSuspensionRuntime = null,
  domainRemovalRuntime = null,
  websiteRemovalRuntime = null,
  websiteSuspensionRuntime = null,
  websiteCronImpactProvider = null,
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
  const applicationEnvironmentRegistry = options.applicationEnvironmentRegistry ?? null;
  const passengerMigrationPreviewService = options.applicationPassengerMigrationPreviewService ?? null;
  const passengerMigrationService = options.applicationPassengerMigrationService ?? null;
  const runtimeBindingRegistry = options.runtimeBindingRegistry ?? null;
  const files = siteFileManager ?? createSiteFileManager({ websiteRegistry, localServerId });
  const readiness = dnsReadinessService ?? createDnsReadinessService({
    dnsHostingRegistry,
    domainRegistry,
    serverRegistry: registry,
    dnsProviderCredentialRegistry,
  });
  const dnsRetirementImpact = dnsZoneRetirementImpactService ?? (
    localServerId && powerDnsSecretRegistry
      ? createDnsZoneRetirementService({
        domainRegistry,
        powerDnsSecretRegistry,
        mailDomainRegistry,
        jobRegistry,
        provisioningRegistry: typeof websiteProvisioningRuntime?.registry?.listForDnsZone === 'function'
          ? websiteProvisioningRuntime.registry
          : null,
        retentionPolicy: dnsZoneRetirementPolicy,
        localServerId,
      })
      : null
  );
  if (dnsRetirementImpact !== null && typeof dnsRetirementImpact.preview !== 'function') {
    throw new Error('DNS zone retirement impact service is invalid');
  }
  const databaseCredentialApply = databaseCredentialApplyService ?? (
    databaseBindingRegistry && databaseCredentialRegistry
      ? createDatabaseCredentialApplyService({ databaseBindingRegistry, databaseCredentialRegistry, jobRegistry })
      : null
  );
  const mailConfig = mailConfigurationService ?? createMailConfigurationService({
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    ...(mailServiceIdentityRegistry ? { domainRegistry, mailServiceIdentityRegistry } : {}),
    ...(mailSrsConfigurationService ? { mailSrsConfigurationService } : {}),
  });
  const mailDeleteImpact = mailDeleteImpactService ?? createMailDeleteImpactService({
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry,
    jobRegistry,
    mailDataInspector,
    localServerId,
  });
  const canCreateMailDeleteFinalize = typeof mailboxRegistry?.deleteMailbox === 'function'
    && typeof mailDomainRegistry?.deleteMailDomain === 'function'
    && typeof jobRegistry?.getJob === 'function';
  const mailDeleteFinalize = mailDeleteFinalizeService ?? (canCreateMailDeleteFinalize
    ? createMailDeleteFinalizeService({
      mailboxRegistry,
      mailDomainRegistry,
      mailDeleteImpactService: mailDeleteImpact,
      jobRegistry,
    })
    : null);
  const mailDataOperations = mailDataOperationsService ?? createMailDataOperationsService({
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailDataInspector,
    mailDataBackupManager,
    mailDeleteImpactService: mailDeleteImpact,
    jobRegistry,
    localServerId,
  });
  const backupOperationRegistry = options.backupOperationRegistry ?? null;
  const removalBackupImpactProvider = backupOperationRegistry
    && databaseBindingRegistry
    && localServerId
    ? createDomainRemovalBackupImpactProvider({
      backupOperationRegistry,
      domainRegistry,
      websiteRegistry,
      databaseBindingRegistry,
      mailDomainRegistry,
      localServerId,
    })
    : null;
  const backupJobStorePath = options.backupJobStorePath ?? null;
  const projectBackupLocked = options.projectBackupLocked ?? null;
  const dockerComposeProjectRegistry = options.dockerComposeProjectRegistry ?? null;
  const dockerComposeObserver = options.dockerComposeObserver ?? null;
  const backupRuntime = backupOperationRegistry && backupJobStorePath && projectBackupLocked
    && dockerComposeProjectRegistry && dockerComposeObserver && applicationEnvironmentRegistry
    ? createBackupProductionRuntime({
      jobRegistry,
      jobStorePath: backupJobStorePath,
      backupOperationRegistry,
      applicationRegistry,
      applicationEnvironmentRegistry,
      dockerComposeProjectRegistry,
      dockerComposeObserver,
      loadDatabaseInventory: (serverId) => databaseHttpInternals.latestDatabaseSnapshot(jobRegistry, serverId),
      mailDataOperationsService: mailDataOperations,
      projectBackupLocked,
    })
    : null;
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
  const backupResourceProviderForRequest = (request) => createBackupResourceProvider({
    serverRegistry: localRegistry,
    dockerComposeProjectRegistry: request[DOCKER_COMPOSE_API_CONTEXT]?.projectRegistry ?? dockerComposeProjectRegistry,
    applicationRegistry,
    applicationEnvironmentRegistry,
    websiteRegistry,
    databaseBindingRegistry,
    loadDatabaseInventory: (serverId) => databaseHttpInternals.latestDatabaseSnapshot(jobRegistry, serverId),
    mailDomainRegistry,
    domainRegistry,
    mailDataOperationsService: mailDataOperations,
  });
  mountBackupRoutes(app, {
    backupResourceProviderForRequest,
    ...(backupRuntime ? {
      backupOperationRegistry,
      backupOrchestratorForRequest: async (_request, provider) => backupRuntime.createOrchestrator(provider),
    } : {}),
  });
  mountCertificateRoutes(app, {
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager,
    jobRegistry,
    localServerId,
    certificateMaterialGc,
  });
  app.post('/api/domains', requirePanelRouteAccess, createDomainHandler(domainRegistry, { localServerId }));
  app.post('/api/domains/:domainId/update-preview', requirePanelRouteAccess, createDomainUpdatePreviewHandler(domainRegistry, { localServerId }));
  app.patch('/api/domains/:domainId', requirePanelRouteAccess, createDomainUpdateHandler(domainRegistry, { jobRegistry, certificateRegistry, localServerId }));
  app.post('/api/domains/:domainId/reparent-preview', requirePanelRouteAccess, createDomainReparentPreviewHandler(domainRegistry, { localServerId }));
  app.post('/api/domains/:domainId/reparent', requirePanelRouteAccess, createDomainReparentHandler(domainRegistry, { localServerId }));
  if (domainSuspensionRuntime) {
    mountDomainSuspensionRoutes(app, { runtime: domainSuspensionRuntime });
  }
  if (websiteSuspensionRuntime) {
    mountWebsiteSuspensionRoutes(app, { runtime: websiteSuspensionRuntime });
  }
  if (domainRemovalRuntime) {
    mountDomainRemovalRoutes(app, { runtime: domainRemovalRuntime });
  }
  if (websiteRemovalRuntime) {
    mountWebsiteRemovalRoutes(app, { runtime: websiteRemovalRuntime });
  }
  if (websiteProvisioningRuntime) {
    if (typeof websiteProvisioningRuntime.configureDomainControlPlane !== 'function') {
      throw new Error('Website provisioning runtime cannot configure Domain control-plane dependencies');
    }
    websiteProvisioningRuntime.configureDomainControlPlane({ domainRegistry });
    if (applicationEnvironmentRegistry) {
      if (typeof websiteProvisioningRuntime.configurePassengerEnvironment !== 'function') {
        throw new Error('Website provisioning runtime cannot configure Passenger environment dependencies');
      }
      websiteProvisioningRuntime.configurePassengerEnvironment({ applicationEnvironmentRegistry });
    }
    if (runtimeBindingRegistry) {
      if (typeof websiteProvisioningRuntime.configurePassengerControlPlane !== 'function') {
        throw new Error('Website provisioning runtime cannot configure Passenger control-plane dependencies');
      }
      websiteProvisioningRuntime.configurePassengerControlPlane({
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        runtimeBindingRegistry,
        localServerId,
      });
    }
  }
  mountSiteCreateRoutes(app, {
    registry: localRegistry,
    applicationRegistry,
    dockerWorkloadRegistry,
    websiteRegistry,
    domainRegistry,
    mailDomainRegistry,
    serverDnsIdentityRegistry,
    dnsZoneTemplateRegistry,
    localServerId,
    websiteProvisioningRegistry: websiteProvisioningRuntime?.registry ?? null,
  });
  if (websiteProvisioningRuntime) {
    mountWebsiteProvisioningRoutes(app, {
      registry: websiteProvisioningRuntime.registry,
      orchestrator: websiteProvisioningRuntime.orchestrator,
      isolationMigration: websiteProvisioningRuntime.isolationMigration,
      websiteRegistry,
      localServerId,
    });
  }
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
    ...(dnsRetirementImpact ? {
      dnsRetirementImpactProvider: async ({ domainIds }) => Promise.all(domainIds.map(async (domainId) => {
        const preview = await dnsRetirementImpact.preview({ domainId });
        return Object.freeze({
          domainId,
          state: preview.retirementPlanReady ? 'ready' : 'blocked',
          previewDigest: preview.previewDigest,
          zoneSnapshotDigest: preview.zone.snapshotDigest,
          ownershipEvidenceDigest: preview.zone.exists
            ? preview.zone.ownershipOrigin?.evidenceDigest ?? null
            : null,
          snapshotRetentionDays: preview.zone.exists && preview.retention.configured
            ? preview.retention.snapshotRetentionDays
            : null,
          blockers: Object.freeze([...preview.blockers]),
        });
      })),
    } : {}),
    additionalProviders: {
      ...(removalBackupImpactProvider ? { backups: removalBackupImpactProvider } : {}),
      ...(roundcubeDomainMappingRegistry
        && typeof roundcubeDomainMappingRegistry.listActiveMappings === 'function'
        && typeof roundcubeDomainMappingRegistry.listInFlight === 'function'
        ? {
          webmailMappings: async ({ domainIds }) => {
            const affected = new Set(domainIds);
            const [active, inFlight] = await Promise.all([
              roundcubeDomainMappingRegistry.listActiveMappings(
                localServerId ? { serverId: localServerId } : {},
              ),
              roundcubeDomainMappingRegistry.listInFlight(
                localServerId ? { serverId: localServerId } : {},
              ),
            ]);
            return [...active, ...inFlight]
              .filter((mapping) => affected.has(mapping.webDomainId))
              .sort((left, right) => left.id.localeCompare(right.id));
          },
        }
        : {}),
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
      ...(websiteCronImpactProvider ? { crons: websiteCronImpactProvider } : {}),
      ...createAllWebsiteImpactProviders({
        databaseBindingRegistry,
        websiteSftpKeyRegistry: websiteSftpKeyRegistry ?? websiteSftpKeyService?.keyRegistry ?? null,
        runtimeBindingRegistry,
        websiteRegistry,
      }),
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
  if ((serverDnsIdentityRegistry === null) !== (powerDnsAuthoritativeService === null)) {
    throw new Error('Server DNS identity registry and PowerDNS authoritative service must be configured together');
  }
  if (serverDnsIdentityRegistry && powerDnsAuthoritativeService) {
    mountPowerDnsRoutes(app, {
      dnsIdentityRegistry: serverDnsIdentityRegistry,
      authoritativeService: powerDnsAuthoritativeService,
      dnsZoneTemplateRegistry,
      dnsZoneReapplyRuntime,
      jobRegistry,
      ...(powerDnsSecretRegistry ? { domainRegistry, powerDnsSecretRegistry } : {}),
      ...(dnsRetirementImpact
        && typeof dnsRetirementImpact.captureDeletionSnapshot === 'function'
        && typeof dnsRetirementImpact.inspectDeletion === 'function'
        && typeof dnsRetirementImpact.deleteCapturedSnapshot === 'function'
        ? { dnsZoneRetirementService: dnsRetirementImpact }
        : {}),
      ...(typeof websiteProvisioningRuntime?.registry?.listForDnsZone === 'function'
        ? { websiteProvisioningRegistry: websiteProvisioningRuntime.registry }
        : {}),
      ...(mailServiceIdentityRegistry ? {
        mailDomainRegistry,
        mailDkimRegistry,
        mailDkimRetirementRegistry,
        mailServiceIdentityRegistry,
        mailDiscoveryEndpointResolver,
        roundcubeWebmailEndpointResolver,
      } : {}),
    });
  }
  mountMailAliasRoutes(app, { mailAliasRegistry, mailDomainRegistry, domainRegistry, localServerId });
  mountMailboxRoutes(app, {
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDomainRegistry,
    domainRegistry,
    mailDeleteFinalizeService: mailDeleteFinalize,
    localServerId,
  });
  mountMailDeleteImpactRoutes(app, { mailDeleteImpactService: mailDeleteImpact });
  mountMailDataRoutes(app, { mailDataOperationsService: mailDataOperations });
  if (mailDeleteFinalize) mountMailDomainDeleteRoute(app, { mailDeleteFinalizeService: mailDeleteFinalize });
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
    mailboxRegistry,
    mailboxForwardingRegistry,
    mailSrsConfigurationService,
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
  if (mailSrsConfigurationService) {
    mountMailSrsRoutes(app, {
      mailSrsConfigurationService,
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
  if (roundcubeConfigurationService) {
    mountRoundcubeConfigurationRoutes(app, {
      roundcubeConfigurationService,
      jobRegistry,
      localServerId,
    });
  }
  if (roundcubeDomainMappingService) {
    mountRoundcubeDomainMappingRoutes(app, {
      service: roundcubeDomainMappingService,
    });
  }
  mountDockerWorkloadRoutes(app, { dockerWorkloadRegistry, localServerId });
  mountApplicationConfigurationRoutes(app, { applicationRegistry, jobRegistry, localServerId });
  mountApplicationProcessRoutes(app, { applicationRegistry, jobRegistry, localServerId });
  if ((passengerMigrationPreviewService === null) !== (passengerMigrationService === null)) {
    throw new Error('Application Passenger migration services must be configured together');
  }
  if (passengerMigrationPreviewService && passengerMigrationService) {
    mountApplicationPassengerMigrationRoutes(app, {
      previewService: passengerMigrationPreviewService,
      migrationService: passengerMigrationService,
    });
  }
  mountWebsiteRoutes(app, { websiteRegistry, domainRegistry, localServerId });
  mountWebsiteMigrationRoutes(app, {
    websiteRegistry,
    domainRegistry,
    applicationRegistry,
    websiteMigrationPolicy,
    migrationLedger,
    localServerId,
  });
  if (websiteSftpKeyService) {
    mountWebsiteSftpKeyRoutes(app, { sftpKeyService: websiteSftpKeyService });
  }
  if (websiteCronApplyService) {
    mountWebsiteCronRoutes(app, { websiteCronApplyService });
  }
  if (websitePhpToolsService) {
    mountWebsitePhpToolsRoutes(app, {
      websitePhpToolsService,
      requirePanelRouteAccess: core.requirePanelRouteAccess,
    });
  }
  mountManagedServiceRoutes(app, { registry: localRegistry, jobRegistry });
  mountNodeRuntimeRoutes(app, { registry: localRegistry, jobRegistry });
  if (databaseBindingRegistry) {
    mountDatabaseBindingRoutes(app, {
      registry: localRegistry,
      websiteRegistry,
      jobRegistry,
      databaseBindingRegistry,
      databaseCredentialRegistry,
      requireDatabaseName: databaseHttpInternals.requireDatabaseName,
      ensureDatabaseIdle: databaseHttpInternals.ensureDatabaseIdle,
      latestDatabaseSnapshot: databaseHttpInternals.latestDatabaseSnapshot,
    });
  }
  if (databaseBindingRegistry) {
    mountWebsiteDatabaseDataRoutes(app, {
      registry: localRegistry,
      websiteRegistry,
      databaseBindingRegistry,
      jobRegistry,
      ensureDatabaseIdle: databaseHttpInternals.ensureDatabaseIdle,
    });
  }
  if (databaseBindingRegistry && databaseCredentialRegistry && databaseInventoryProvider
    && typeof jobRegistry.getJob === 'function') {
    mountWebsiteDatabaseDeleteRoutes(app, {
      registry: localRegistry,
      websiteRegistry,
      databaseBindingRegistry,
      databaseCredentialRegistry,
      jobRegistry,
      databaseInventoryProvider,
      ensureDatabaseIdle: databaseHttpInternals.ensureDatabaseIdle,
    });
  }
  if (databaseBindingRegistry && databaseCredentialRegistry && databaseCredentialApply) {
    mountDatabaseCredentialRoutes(app, {
      registry: localRegistry,
      databaseBindingRegistry,
      databaseCredentialRegistry,
      databaseCredentialApplyService: databaseCredentialApply,
      jobRegistry,
      ensureDatabaseIdle: databaseHttpInternals.ensureDatabaseIdle,
    });
  }
  if (phpMyAdminHandoffService) {
    mountPhpMyAdminHandoffRoutes(app, {
      registry: localRegistry,
      phpMyAdminHandoffService,
    });
  }
  if (elFinderHandoffService) {
    mountElFinderHandoffRoutes(app, {
      registry: localRegistry,
      elFinderHandoffService,
    });
  }
  mountDatabaseRoutes(app, {
    registry: localRegistry,
    jobRegistry,
    databaseBindingRegistry,
    databaseCredentialRegistry,
    databaseInventoryProvider,
    databaseHealthProvider,
  });
  mountLogRoutes(app, {
    registry, applicationRegistry, jobRegistry, journalLogReader, nginxLogReader, jobLogStore, localServerId,
  });
  mountTerminalCapabilityRoutes(app, {
    terminalCapabilityRegistry, serverRegistry: registry, websiteRegistry, localServerId,
  });
  if (ttydSessionManager) {
    mountTtydSessionRoutes(app, {
      terminalCapabilityRegistry,
      ttydSessionManager,
    });
  }
  app.use(core);
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (
      isBackupHttpError(error)
      || error instanceof ApplicationRuntimeBindingRegistryError
      || error instanceof DatabaseBindingHttpError
      || error instanceof DatabaseBindingRegistryError
      || error instanceof DatabaseCredentialApplyError
      || error instanceof DatabaseCredentialHttpError
      || error instanceof DatabaseCredentialRegistryError
      || error instanceof DatabaseHttpError
      || error instanceof WebsiteDatabaseDeleteHttpError
      || error instanceof PhpMyAdminHandoffError
      || error instanceof ElFinderHandoffError
      || error instanceof CertificateMaterialError
      || error instanceof CertificateRegistryError
      || error instanceof ApplicationRegistryError
      || error instanceof DomainRegistryError
      || error instanceof DomainSuspensionHttpError
      || error instanceof DockerWorkloadRegistryError
      || error instanceof DnsZoneMailDkimRetirementHttpError
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
      || error instanceof MailDataBackupError
      || error instanceof MailDataHttpError
      || error instanceof MailDataInspectorError
      || error instanceof MailDataOperationsError
      || error instanceof MailDomainDeleteHttpError
      || error instanceof MailDeleteFinalizeError
      || error instanceof MailDeleteImpactError
      || error instanceof MailDkimConfigurationError
      || error instanceof MailDkimDnsError
      || error instanceof MailDkimDnsHttpError
      || error instanceof MailDkimHttpError
      || error instanceof MailDkimRegistryError
      || error instanceof MailDkimRetirementRegistryError
      || error instanceof MailDiagnosticsHttpError
      || error instanceof MailDiagnosticsInspectorError
      || error instanceof MailServiceIdentityRegistryError
      || error instanceof MailSrsConfigurationError
      || error instanceof MailSrsHttpError
      || error instanceof MailSrsSecretRegistryError
      || error instanceof MailboxForwardingRegistryError
      || error instanceof MailboxQuotaRegistryError
      || error instanceof MailboxQuotaHttpError
      || error instanceof MailboxRegistryError
      || error instanceof MailboxPasswordError
      || error instanceof NodeRuntimeHttpError
      || error instanceof PowerDnsAuthoritativeServiceError
      || error instanceof PowerDnsHttpError
      || error instanceof PowerDnsSecretRegistryError
      || error instanceof ResourceImpactError
      || error instanceof RoundcubeConfigurationError
      || error instanceof RoundcubeConfigurationHttpError
      || error instanceof RoundcubeDomainMappingHttpError
      || error instanceof RoundcubeDomainMappingRegistryError
      || error instanceof RoundcubeDomainMappingServiceError
      || error instanceof RoundcubeSecretRegistryError
      || error instanceof ServerDnsIdentityRegistryError
      || error instanceof SiteFileHttpError
      || error instanceof SiteFileManagerError
      || error instanceof SiteFileWorkerError
      || error instanceof SiteCreateError
      || error instanceof TerminalCapabilityError
      || error instanceof TtydSessionError
      || error instanceof WebsiteMigrationBindError
      || error instanceof WebsiteMigrationCreateError
      || error instanceof WebsiteMigrationLedgerError
      || error instanceof WebsiteMigrationPolicyError
      || error instanceof WebsiteMigrationPreviewError
      || error instanceof WebsiteMigrationRollbackError
      || error instanceof WebsiteProvisioningHandlerError
      || error instanceof WebsiteProvisioningHttpError
      || error instanceof WebsiteProvisioningOrchestratorError
      || error instanceof WebsiteProvisioningRegistryError
      || error instanceof WebsiteRegistryError
      || error instanceof WebsiteSftpKeyHttpError
      || error instanceof WebsiteSftpKeyRegistryError
      || error instanceof WebsiteSftpKeyServiceError
      || error instanceof WebsiteCronHttpError
      || error instanceof WebsiteCronApplyServiceError
      || error instanceof WebsiteCronRegistryError
      || error instanceof WebsitePhpToolsServiceError
      || error instanceof PhpCliToolError
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
