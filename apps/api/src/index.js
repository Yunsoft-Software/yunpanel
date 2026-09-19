import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createJournalLogReader,
  createDatabaseManager,
  createMailDiagnosticsInspector,
  createNginxLogReader,
  inspectAllowlistedServices,
  inspectDocker,
  inspectNginx,
} from '@yunpanel/host-runtime';
import { createApp, API_VERSION } from './app.js';
import { createAuditedJobRegistry } from './audited-job-registry.js';
import { createAuthStore } from './auth-store.js';
import { createAuthenticatedApi, createLiveConnectionAuthenticator } from './auth-http.js';
import { createApplicationEnvironmentRegistry } from './application-environment-registry.js';
import { createApplicationDeployQueue } from './application-deploy-queue.js';
import { createApplicationPassengerMigrationPreviewService } from './application-passenger-migration-preview.js';
import { createApplicationPassengerMigrationService } from './application-passenger-migration-service.js';
import { createApplicationRegistry } from './application-registry.js';
import { createApplicationRuntimeBindingRegistry } from './application-runtime-binding-registry.js';
import { createBackupOperationRegistry } from './backup-operation-registry.js';
import { createBackupProjectLockProvider } from './backup-project-lock.js';
import { createCertificateRegistry } from './certificate-registry.js';
import { createCertificateMaterialManager } from './certificate-material-manager.js';
import { startCertificateRenewalScheduler } from './certificate-renewal-scheduler.js';
import { startConfiguredLocalRuntime } from './configured-local-runtime.js';
import { createDatabaseBindingRegistry } from './database-binding-registry.js';
import { createDatabaseCredentialApplyService } from './database-credential-apply-service.js';
import { createDatabaseCredentialMaterializer } from './database-credential-materializer.js';
import { createDatabaseCredentialRegistry } from './database-credential-registry.js';
import { createDomainRegistry } from './domain-registry.js';
import { createDomainStageTargetJobRegistry } from './domain-stage-target-job-registry.js';
import { createDomainSuspensionOperationRegistry } from './domain-suspension-operation-registry.js';
import { createDomainSuspensionRuntime } from './domain-suspension-runtime.js';
import { createDomainRemovalProductionRuntime } from './domain-removal-production-runtime.js';
import { createDomainSuspensionService } from './domain-suspension.js';
import { createDnsHostingRegistry } from './dns-hosting-registry.js';
import { createDnsProviderCredentialRegistry } from './dns-provider-credential-registry.js';
import { createDnsZoneRetirementOperationRegistry } from './dns-zone-retirement-operation-registry.js';
import { createDnsZoneRetirementRuntime } from './dns-zone-retirement-runtime.js';
import { createDnsZoneRetirementService } from './dns-zone-retirement.js';
import { createDockerComposeApiHandler } from './docker-compose-api-handler.js';
import {
  createDockerComposeProjectRegistryBootstrap,
  createDockerComposeRuntime,
} from './docker-compose-runtime.js';
import { createDockerWorkloadRegistry } from './docker-workload-registry.js';
import { createDurableJobRegistry } from './durable-job-registry.js';
import { createJobRegistry } from './job-registry.js';
import { createJobLogStore } from './job-log-store.js';
import { createGithubWebhookHandler } from './github-webhook-http.js';
import { createLiveSessionRegistry } from './live-session-registry.js';
import { createElFinderHandoffService } from './elfinder-handoff-service.js';
import { startElFinderHandoffSocket } from './elfinder-handoff-socket.js';
import { createLocalDatabaseCredentialOperation } from './local-database-credential-operation.js';
import { createLocalHostOperations } from './local-host-operations.js';
import { createMailAliasRegistry } from './mail-alias-registry.js';
import { createMailConfigurationService } from './mail-configuration.js';
import { createMailDkimConfigurationService } from './mail-dkim-configuration.js';
import { createMailDkimRegistry } from './mail-dkim-registry.js';
import { createMailDkimRetirementRegistry } from './mail-dkim-retirement-registry.js';
import { createMailDomainRegistry } from './mail-domain-registry.js';
import { createMailDomainRemovalProductionRuntime } from './mail-domain-removal-production-runtime.js';
import { createMailServiceIdentityRegistry } from './mail-service-identity-registry.js';
import { createMailSrsConfigurationService } from './mail-srs-configuration.js';
import { createMailSrsSecretRegistry } from './mail-srs-secret-registry.js';
import { createMailboxForwardingRegistry } from './mailbox-forwarding-registry.js';
import { createMailboxQuotaRegistry } from './mailbox-quota-registry.js';
import { createMailboxRegistry } from './mailbox-registry.js';
import { createPowerDnsAuthoritativeService } from './powerdns-authoritative-service.js';
import { createPhpMyAdminHandoffService } from './phpmyadmin-handoff-service.js';
import { startPhpMyAdminHandoffSocket } from './phpmyadmin-handoff-socket.js';
import { createPowerDnsSecretRegistry } from './powerdns-secret-registry.js';
import { prepareRootAuthStateOwnership } from './root-auth-state-migration.js';
import { createRoundcubeConfigurationService } from './roundcube-configuration.js';
import { createRoundcubeDomainMappingRegistry } from './roundcube-domain-mapping-registry.js';
import { createRoundcubeDomainMappingService } from './roundcube-domain-mapping-service.js';
import { createRoundcubeWebmailEndpointResolver } from './roundcube-webmail-endpoint-resolver.js';
import { createRoundcubeSecretRegistry } from './roundcube-secret-registry.js';
import { createServerDnsIdentityRegistry } from './server-dns-identity-registry.js';
import { createServerRegistry } from './server-registry.js';
import { createTerminalCapabilityRegistry } from './terminal-capability-registry.js';
import { createTerminalProcessManager } from './terminal-process-manager.js';
import { createTerminalWebSocketServer } from './terminal-websocket.js';
import { createTtydSessionManager } from './ttyd-session-manager.js';
import { createWebsiteMigrationLedger } from './website-migration-ledger.js';
import { createWebsiteMigrationPolicyStore } from './website-migration-policy.js';
import { createWebsiteProvisioningRuntime } from './website-provisioning-runtime.js';
import { createWebsiteRegistry } from './website-registry.js';
import { createWebsiteSftpKeyRuntime } from './website-sftp-key-runtime.js';

const host = process.env.YUNPANEL_API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.YUNPANEL_API_PORT ?? '3001', 10);
const serverStorePath = process.env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
const controlPlaneStateRoot = path.dirname(serverStorePath);
const domainStorePath = process.env.YUNPANEL_DOMAIN_STORE ?? path.resolve('.data/domain-registry.json');
const domainSuspensionOperationStorePath = process.env.YUNPANEL_DOMAIN_SUSPENSION_OPERATION_STORE
  ?? path.join(controlPlaneStateRoot, 'domain-suspension-operations.json');
const domainRemovalOperationStorePath = process.env.YUNPANEL_DOMAIN_REMOVAL_OPERATION_STORE
  ?? path.join(controlPlaneStateRoot, 'domain-removal-operations.json');
const jobStorePath = process.env.YUNPANEL_JOB_STORE ?? path.resolve('.data/job-registry.json');
const backupOperationStorePath = process.env.YUNPANEL_BACKUP_OPERATION_STORE
  ?? path.join(controlPlaneStateRoot, 'backup-operation-registry.json');
const jobLogStorePath = path.resolve(path.dirname(jobStorePath), 'job-logs');
const certificateStorePath = process.env.YUNPANEL_CERTIFICATE_STORE ?? path.resolve('.data/certificate-registry.json');
const customCertificateRoot = path.join(path.dirname(certificateStorePath), 'custom-certificates');
const applicationStorePath = process.env.YUNPANEL_APPLICATION_STORE ?? path.resolve('.data/application-registry.json');
const applicationRuntimeBindingStorePath = process.env.YUNPANEL_APPLICATION_RUNTIME_BINDING_STORE
  ?? path.join(controlPlaneStateRoot, 'application-runtime-binding-registry.json');
const websiteStorePath = process.env.YUNPANEL_WEBSITE_STORE ?? path.resolve('.data/website-registry.json');
const websiteProvisioningStorePath = process.env.YUNPANEL_WEBSITE_PROVISIONING_STORE
  ?? path.join(controlPlaneStateRoot, 'website-provisioning-registry.json');
const websiteIsolationMigrationStorePath = process.env.YUNPANEL_WEBSITE_ISOLATION_MIGRATION_STORE
  ?? path.join(controlPlaneStateRoot, 'website-isolation-migration-registry.json');
const websiteSftpKeyStorePath = process.env.YUNPANEL_WEBSITE_SFTP_KEY_STORE
  ?? path.join(controlPlaneStateRoot, 'website-sftp-key-registry.json');
const databaseBindingStorePath = process.env.YUNPANEL_DATABASE_BINDING_STORE
  ?? path.resolve('.data/database-binding-registry.json');
const databaseCredentialStorePath = process.env.YUNPANEL_DATABASE_CREDENTIAL_STORE
  ?? path.resolve('.data/database-credential-registry.json');
const websiteMigrationPolicyStorePath = process.env.YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE ?? path.resolve('.data/website-migration-policy.json');
const websiteMigrationLedgerStorePath = process.env.YUNPANEL_WEBSITE_MIGRATION_LEDGER_STORE ?? path.resolve('.data/website-migration-ledger.json');
const dnsHostingStorePath = process.env.YUNPANEL_DNS_HOSTING_STORE ?? path.resolve('.data/dns-hosting-registry.json');
const dnsProviderCredentialStorePath = process.env.YUNPANEL_DNS_CREDENTIAL_STORE ?? path.resolve('.data/dns-provider-credential-registry.json');
const serverDnsIdentityStorePath = process.env.YUNPANEL_SERVER_DNS_IDENTITY_STORE
  ?? path.join(controlPlaneStateRoot, 'server-dns-identity-registry.json');
const powerDnsSecretStorePath = process.env.YUNPANEL_POWERDNS_SECRET_STORE
  ?? path.join(controlPlaneStateRoot, 'powerdns-secret-registry.json');
const dnsZoneRetirementOperationStorePath = process.env.YUNPANEL_DNS_ZONE_RETIREMENT_OPERATION_STORE
  ?? path.join(controlPlaneStateRoot, 'dns-zone-retirement-operations.json');
const mailDomainStorePath = process.env.YUNPANEL_MAIL_DOMAIN_STORE ?? path.resolve('.data/mail-domain-registry.json');
const mailDomainRemovalOperationStorePath = process.env.YUNPANEL_MAIL_DOMAIN_REMOVAL_OPERATION_STORE
  ?? path.join(controlPlaneStateRoot, 'mail-domain-removal-operations.json');
const mailDkimRootPath = process.env.YUNPANEL_MAIL_DKIM_ROOT ?? path.resolve('.data/mail-dkim');
const mailDkimRetirementStorePath = process.env.YUNPANEL_MAIL_DKIM_RETIREMENT_STORE
  ?? path.resolve('.data/mail-dkim-retirement-registry.json');
const mailServiceIdentityStorePath = process.env.YUNPANEL_MAIL_SERVICE_IDENTITY_STORE
  ?? path.resolve('.data/mail-service-identity-registry.json');
const mailSrsSecretStorePath = process.env.YUNPANEL_MAIL_SRS_SECRET_STORE
  ?? path.resolve('.data/mail-srs-secret-registry.json');
const roundcubeSecretStorePath = process.env.YUNPANEL_ROUNDCUBE_SECRET_STORE
  ?? path.resolve('.data/roundcube-secret-registry.json');
const roundcubeDomainMappingStorePath = process.env.YUNPANEL_ROUNDCUBE_DOMAIN_MAPPING_STORE
  ?? path.join(controlPlaneStateRoot, 'roundcube-domain-mapping-registry.json');
const mailboxStorePath = process.env.YUNPANEL_MAILBOX_STORE ?? path.resolve('.data/mailbox-registry.json');
const mailboxQuotaStorePath = process.env.YUNPANEL_MAILBOX_QUOTA_STORE ?? path.resolve('.data/mailbox-quota-registry.json');
const mailboxForwardingStorePath = process.env.YUNPANEL_MAILBOX_FORWARDING_STORE ?? path.resolve('.data/mailbox-forwarding-registry.json');
const mailAliasStorePath = process.env.YUNPANEL_MAIL_ALIAS_STORE ?? path.resolve('.data/mail-alias-registry.json');
const dockerWorkloadStorePath = process.env.YUNPANEL_DOCKER_WORKLOAD_STORE ?? path.resolve('.data/docker-workload-registry.json');
const applicationEnvironmentStorePath = process.env.YUNPANEL_APPLICATION_ENVIRONMENT_STORE ?? path.resolve('.data/application-environment-registry.json');
const authStorePath = process.env.YUNPANEL_AUTH_DB ?? path.join(path.dirname(serverStorePath), 'auth', 'auth.sqlite');
const internalProxyToken = process.env.YUNPANEL_INTERNAL_PROXY_TOKEN;
const publicOrigin = process.env.YUNPANEL_PUBLIC_ORIGIN ?? (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:5173' : undefined);
const localServerId = process.env.YUNPANEL_LOCAL_SERVER_ID?.trim() || null;
const dnsZoneRetentionDaysRaw = process.env.YUNPANEL_DNS_ZONE_SNAPSHOT_RETENTION_DAYS?.trim() || null;
const dnsZoneSnapshotRetentionDays = dnsZoneRetentionDaysRaw === null
  ? null
  : Number.parseInt(dnsZoneRetentionDaysRaw, 10);
const certificateRenewalIntervalMs = Number.parseInt(process.env.YUNPANEL_CERTIFICATE_RENEWAL_INTERVAL_MS ?? `${6 * 60 * 60 * 1000}`, 10);
const certificateRenewBeforeMs = Number.parseInt(process.env.YUNPANEL_CERTIFICATE_RENEW_BEFORE_MS ?? `${30 * 24 * 60 * 60 * 1000}`, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('YUNPANEL_API_PORT must be a valid TCP port');
if (process.env.NODE_ENV !== 'development' && !/^[A-Za-z0-9_-]{43}$/.test(internalProxyToken ?? '')) {
  throw new Error('YUNPANEL_INTERNAL_PROXY_TOKEN is required in production');
}
if (process.env.NODE_ENV !== 'development' && !localServerId) {
  throw new Error('YUNPANEL_LOCAL_SERVER_ID is required in production');
}
if (dnsZoneRetentionDaysRaw !== null
  && (!/^[1-9]\d*$/.test(dnsZoneRetentionDaysRaw)
    || !Number.isSafeInteger(dnsZoneSnapshotRetentionDays)
    || dnsZoneSnapshotRetentionDays < 1
    || dnsZoneSnapshotRetentionDays > 3650)) {
  throw new Error('YUNPANEL_DNS_ZONE_SNAPSHOT_RETENTION_DAYS must be an integer between 1 and 3650');
}

function reportLocalExecutorFault(error) {
  const code = typeof error?.code === 'string' ? error.code : 'local_executor_fault';
  const phase = typeof error?.phase === 'string' ? error.phase : 'unknown';
  const jobId = typeof error?.jobId === 'string' ? error.jobId : 'none';
  console.error(`[yunpanel-api] local executor fault code=${code} phase=${phase} job=${jobId}`);
}

function reportPhpMyAdminHandoffFault(error) {
  const code = typeof error?.code === 'string' ? error.code : 'phpmyadmin_handoff_socket_fault';
  console.error(`[yunpanel-api] phpMyAdmin handoff unavailable code=${code}`);
}

function reportElFinderHandoffFault(error) {
  const code = typeof error?.code === 'string' ? error.code : 'elfinder_handoff_socket_fault';
  console.error(`[yunpanel-api] elFinder handoff unavailable code=${code}`);
}

function reportAuditFault(metadata) {
  const phase = ['link', 'complete', 'cancel'].includes(metadata?.phase) ? metadata.phase : 'unknown';
  const jobId = typeof metadata?.jobId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(metadata.jobId) ? metadata.jobId : 'none';
  console.error(`[yunpanel-api] audit write failed phase=${phase} job=${jobId}`);
}

const registry = createServerRegistry({ filePath: serverStorePath });
await registry.init();
const durableJobRegistry = createDurableJobRegistry({
  filePath: jobStorePath,
  registryFactory: createJobRegistry,
  automaticReconciliation: true,
});
await durableJobRegistry.init();
const backupOperationRegistry = createBackupOperationRegistry({ filePath: backupOperationStorePath });
await backupOperationRegistry.init();
const projectBackupLocked = createBackupProjectLockProvider({ backupOperationRegistry });
const certificateRegistry = createCertificateRegistry({ filePath: certificateStorePath, customRoot: customCertificateRoot });
await certificateRegistry.init();
const certificateMaterialManager = createCertificateMaterialManager({ customRoot: customCertificateRoot });
const applicationRegistry = createApplicationRegistry({
  filePath: applicationStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
});
await applicationRegistry.init();
const runtimeBindingRegistry = createApplicationRuntimeBindingRegistry({ filePath: applicationRuntimeBindingStorePath });
await runtimeBindingRegistry.init();
const dockerWorkloadRegistry = createDockerWorkloadRegistry({
  filePath: dockerWorkloadStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
});
await dockerWorkloadRegistry.init();
const dockerComposeProjectBootstrap = createDockerComposeProjectRegistryBootstrap({
  env: process.env,
  serverRegistry: registry,
});
await dockerComposeProjectBootstrap.projectRegistry.init();
const websiteRegistry = createWebsiteRegistry({
  filePath: websiteStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
  getDockerWorkload: async (workloadId) => dockerWorkloadRegistry.getWorkload(workloadId),
  getDockerComposeProject: async (projectId) => dockerComposeProjectBootstrap.projectRegistry.getProject(projectId),
});
await websiteRegistry.init();
const websiteProvisioningRuntime = createWebsiteProvisioningRuntime({
  filePath: websiteProvisioningStorePath,
  isolationMigrationFilePath: websiteIsolationMigrationStorePath,
});
const websiteSftpKeyRuntime = await createWebsiteSftpKeyRuntime({
  filePath: websiteSftpKeyStorePath,
  websiteRegistry,
  localServerId,
});
const databaseBindingRegistry = createDatabaseBindingRegistry({
  filePath: databaseBindingStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
  getApplication: async (applicationId) => applicationRegistry.getApplication(applicationId),
});
await databaseBindingRegistry.init();
const databaseCredentialRegistry = createDatabaseCredentialRegistry({
  filePath: databaseCredentialStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY,
  getDatabaseBinding: async (bindingId) => databaseBindingRegistry.getBinding(bindingId),
});
await databaseCredentialRegistry.init();
const databaseCredentialMaterializer = createDatabaseCredentialMaterializer({
  databaseBindingRegistry,
  databaseCredentialRegistry,
});
const localDatabaseCredentialOperation = createLocalDatabaseCredentialOperation({
  materializer: databaseCredentialMaterializer,
});
const websiteMigrationPolicy = createWebsiteMigrationPolicyStore({ filePath: websiteMigrationPolicyStorePath });
await websiteMigrationPolicy.init();
const migrationLedger = createWebsiteMigrationLedger({ filePath: websiteMigrationLedgerStorePath });
await migrationLedger.init();
const domainRegistry = createDomainRegistry({
  filePath: domainStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  getWebsite: async (websiteId) => websiteRegistry.getWebsite(websiteId),
  websiteBindingRequired: () => websiteMigrationPolicy.snapshot().websiteBindingRequired,
});
await domainRegistry.init();
const dnsHostingRegistry = createDnsHostingRegistry({
  filePath: dnsHostingStorePath,
  getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
});
await dnsHostingRegistry.init();
const dnsProviderCredentialRegistry = createDnsProviderCredentialRegistry({
  filePath: dnsProviderCredentialStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY,
  getDnsZone: async (dnsZoneId) => dnsHostingRegistry.getZone(dnsZoneId),
});
await dnsProviderCredentialRegistry.init();
const serverDnsIdentityRegistry = createServerDnsIdentityRegistry({
  filePath: serverDnsIdentityStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
});
await serverDnsIdentityRegistry.init();
const powerDnsSecretRegistry = createPowerDnsSecretRegistry({
  filePath: powerDnsSecretStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
});
await powerDnsSecretRegistry.init();
const powerDnsAuthoritativeService = localServerId
  ? createPowerDnsAuthoritativeService({
    localServerId,
    serverRegistry: registry,
    dnsIdentityRegistry: serverDnsIdentityRegistry,
    secretRegistry: powerDnsSecretRegistry,
  })
  : null;
const mailServiceIdentityRegistry = createMailServiceIdentityRegistry({
  filePath: mailServiceIdentityStorePath,
  getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
  getCertificate: async (certificateId) => certificateRegistry.getCertificate(certificateId),
});
await mailServiceIdentityRegistry.init();
const mailSrsSecretRegistry = createMailSrsSecretRegistry({
  filePath: mailSrsSecretStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
});
await mailSrsSecretRegistry.init();
const mailSrsConfigurationService = createMailSrsConfigurationService({
  mailServiceIdentityRegistry,
  mailSrsSecretRegistry,
});
const roundcubeSecretRegistry = createRoundcubeSecretRegistry({
  filePath: roundcubeSecretStorePath,
  serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
});
await roundcubeSecretRegistry.init();
const mailDomainRegistry = createMailDomainRegistry({
  filePath: mailDomainStorePath,
  getWebDomain: async (domainId) => domainRegistry.getDomain(domainId),
});
await mailDomainRegistry.init();
const roundcubeDomainMappingRegistry = createRoundcubeDomainMappingRegistry({
  filePath: roundcubeDomainMappingStorePath,
  getMailDomain: (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
  getDomain: (domainId) => domainRegistry.getDomain(domainId),
  getCertificate: (certificateId) => certificateRegistry.getCertificate(certificateId),
  inspectCertificate: (input) => certificateMaterialManager.inspectStored(input),
});
await roundcubeDomainMappingRegistry.init();
const roundcubeConfigurationService = createRoundcubeConfigurationService({
  mailServiceIdentityRegistry,
  roundcubeSecretRegistry,
  roundcubeDomainMappingRegistry,
  certificateRegistry,
  certificateMaterialManager,
});
const mailDkimRegistry = createMailDkimRegistry({
  keyRoot: mailDkimRootPath,
  getMailDomain: (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
});
await mailDkimRegistry.init();
const mailDkimRetirementRegistry = createMailDkimRetirementRegistry({
  filePath: mailDkimRetirementStorePath,
  getDkimKey: (mailDomainId) => mailDkimRegistry.getKey(mailDomainId),
});
await mailDkimRetirementRegistry.init();
const mailDiagnosticsInspector = createMailDiagnosticsInspector();
const mailDkimConfigurationService = createMailDkimConfigurationService({
  mailDomainRegistry,
  mailDkimRegistry,
  mailDiagnosticsInspector,
});
const mailboxRegistry = createMailboxRegistry({
  filePath: mailboxStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY,
  getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
});
await mailboxRegistry.init();
const mailboxQuotaRegistry = createMailboxQuotaRegistry({
  filePath: mailboxQuotaStorePath,
  getMailbox: (mailboxId) => mailboxRegistry.getMailbox(mailboxId),
});
await mailboxQuotaRegistry.init();
const mailboxForwardingRegistry = createMailboxForwardingRegistry({
  filePath: mailboxForwardingStorePath,
  getMailbox: (mailboxId) => mailboxRegistry.getMailbox(mailboxId),
});
await mailboxForwardingRegistry.init();
const mailAliasRegistry = createMailAliasRegistry({
  filePath: mailAliasStorePath,
  getMailDomain: async (mailDomainId) => mailDomainRegistry.getMailDomain(mailDomainId),
  listMailboxes: (filter) => mailboxRegistry.listMailboxes(filter),
});
await mailAliasRegistry.init();
const mailConfigurationService = createMailConfigurationService({
  mailDomainRegistry,
  mailboxRegistry,
  mailAliasRegistry,
  mailboxQuotaRegistry,
  mailboxForwardingRegistry,
  domainRegistry,
  mailServiceIdentityRegistry,
  mailSrsConfigurationService,
});
const applicationEnvironmentRegistry = createApplicationEnvironmentRegistry({
  filePath: applicationEnvironmentStorePath,
  masterKey: process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  applicationExists: async (applicationId) => Boolean(await applicationRegistry.getApplication(applicationId)),
});
await applicationEnvironmentRegistry.init();
websiteProvisioningRuntime.configureSftpKeys({ sftpKeyService: websiteSftpKeyRuntime.service });
websiteProvisioningRuntime.configureDomainControlPlane({ domainRegistry });
websiteProvisioningRuntime.configurePassengerEnvironment({ applicationEnvironmentRegistry });
websiteProvisioningRuntime.configurePassengerControlPlane({
  applicationRegistry,
  websiteRegistry,
  domainRegistry,
  runtimeBindingRegistry,
  localServerId,
});
const jobLogStore = createJobLogStore({ directoryPath: jobLogStorePath });
await jobLogStore.init();
const journalLogReader = createJournalLogReader();
const nginxLogReader = createNginxLogReader();
const databaseManager = createDatabaseManager();
await prepareRootAuthStateOwnership({ filePath: authStorePath });
const liveSessions = createLiveSessionRegistry();
const authStore = createAuthStore({ filePath: authStorePath, liveSessions });
const terminalCapabilityRegistry = createTerminalCapabilityRegistry({ liveSessions });
const terminalProcessManager = createTerminalProcessManager();
const ttydSessionManager = createTtydSessionManager({ liveSessions });
const auditedJobRegistry = createAuditedJobRegistry({
  registry: durableJobRegistry,
  audit: authStore.audit,
  onAuditError: reportAuditFault,
});
const jobRegistry = createDomainStageTargetJobRegistry({
  registry: auditedJobRegistry,
  domainRegistry,
  websiteRegistry,
  dockerComposeProjectRegistry: dockerComposeProjectBootstrap.projectRegistry,
  applicationRegistry,
  runtimeBindingRegistry,
});
const roundcubeDomainMappingService = createRoundcubeDomainMappingService({
  registry: roundcubeDomainMappingRegistry,
  roundcubeConfigurationService,
  jobRegistry,
});
const roundcubeWebmailEndpointResolver = createRoundcubeWebmailEndpointResolver({
  roundcubeDomainMappingRegistry,
  roundcubeConfigurationService,
  jobRegistry,
});
const mailDomainRemovalRuntimeBundle = localServerId
  ? createMailDomainRemovalProductionRuntime({
    filePath: mailDomainRemovalOperationStorePath,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry,
    mailConfigurationService,
    jobRegistry,
    localServerId,
  })
  : null;
const mailDomainRemovalRuntime = mailDomainRemovalRuntimeBundle?.runtime ?? null;
if (mailDomainRemovalRuntime) await mailDomainRemovalRuntime.init();

const domainSuspensionRuntime = localServerId
  ? createDomainSuspensionRuntime({
    registry: createDomainSuspensionOperationRegistry({
      filePath: domainSuspensionOperationStorePath,
    }),
    service: createDomainSuspensionService({
      domainRegistry,
      jobRegistry,
      localServerId,
    }),
  })
  : null;
if (domainSuspensionRuntime) await domainSuspensionRuntime.init();
const dnsZoneRetirementService = localServerId && powerDnsSecretRegistry
  ? createDnsZoneRetirementService({
    domainRegistry,
    powerDnsSecretRegistry,
    provisioningRegistry: typeof websiteProvisioningRuntime?.registry?.listForDnsZone === 'function'
      ? websiteProvisioningRuntime.registry
      : null,
    mailDomainRegistry,
    jobRegistry,
    retentionPolicy: dnsZoneSnapshotRetentionDays === null
      ? null
      : { snapshotRetentionDays: dnsZoneSnapshotRetentionDays },
    localServerId,
  })
  : null;
const dnsZoneRetirementRuntime = dnsZoneRetirementService
  ? createDnsZoneRetirementRuntime({
    registry: createDnsZoneRetirementOperationRegistry({
      filePath: dnsZoneRetirementOperationStorePath,
    }),
    service: dnsZoneRetirementService,
  })
  : null;
if (dnsZoneRetirementRuntime) await dnsZoneRetirementRuntime.init();
const domainRemovalRuntimeBundle = localServerId && domainSuspensionRuntime && mailDomainRemovalRuntime
  ? createDomainRemovalProductionRuntime({
    filePath: domainRemovalOperationStorePath,
    registry,
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    dnsHostingRegistry,
    mailDomainRegistry,
    mailboxRegistry,
    dockerWorkloadRegistry,
    backupOperationRegistry,
    databaseBindingRegistry,
    domainSuspensionRuntime,
    dnsZoneRetirementService,
    dnsZoneRetirementRuntime,
    mailDomainRemovalRuntime,
    localServerId,
  })
  : null;
const domainRemovalRuntime = domainRemovalRuntimeBundle?.runtime ?? null;
if (domainRemovalRuntime) await domainRemovalRuntime.init();
const dockerComposeRuntime = await createDockerComposeRuntime({
  env: process.env,
  serverRegistry: registry,
  jobRegistry,
  projectRegistry: dockerComposeProjectBootstrap.projectRegistry,
  projectBackupLocked,
});
const databaseCredentialApplyService = createDatabaseCredentialApplyService({
  databaseBindingRegistry,
  databaseCredentialRegistry,
  jobRegistry,
});
const phpMyAdminHandoffService = createPhpMyAdminHandoffService({
  databaseBindingRegistry,
  databaseCredentialRegistry,
  databaseCredentialApplyService,
  jobRegistry,
  liveSessions,
});
let phpMyAdminHandoffRuntime = null;
if (localServerId) {
  try {
    phpMyAdminHandoffRuntime = await startPhpMyAdminHandoffSocket({ phpMyAdminHandoffService });
  } catch (error) {
    reportPhpMyAdminHandoffFault(error);
  }
}
const elFinderHandoffService = localServerId
  ? createElFinderHandoffService({
    websiteRegistry,
    localServerId,
    runtimeInspector: (intent) => websiteProvisioningRuntime.handlers.elfinder.inspect({
      intent,
    }),
    liveSessions,
  })
  : null;
let elFinderHandoffRuntime = null;
if (elFinderHandoffService) {
  try {
    elFinderHandoffRuntime = await startElFinderHandoffSocket({ elFinderHandoffService });
  } catch (error) {
    reportElFinderHandoffFault(error);
  }
}
const websiteDatabaseInventoryProvider = () => databaseManager.inspect();
const websiteDatabaseHealthProvider = () => databaseManager.inspectSecurityBaseline();
websiteProvisioningRuntime.configureDatabaseControlPlane({
  jobRegistry,
  databaseBindingRegistry,
  databaseCredentialRegistry,
  databaseCredentialApplyService,
  databaseCredentialMaterializer,
  databaseInventoryProvider: websiteDatabaseInventoryProvider,
  databaseHealthProvider: websiteDatabaseHealthProvider,
});
await websiteProvisioningRuntime.init();
const applicationDeployQueue = createApplicationDeployQueue({
  applicationRegistry,
  applicationEnvironmentRegistry,
  jobRegistry,
});
const applicationPassengerMigrationPreviewService = createApplicationPassengerMigrationPreviewService({
  applicationRegistry,
  websiteRegistry,
  domainRegistry,
  localServerId,
});
const applicationPassengerMigrationService = createApplicationPassengerMigrationService({
  previewService: applicationPassengerMigrationPreviewService,
  applicationRegistry,
  domainRegistry,
  certificateRegistry,
  runtimeBindingRegistry,
  jobRegistry,
});
const listener = createAuthenticatedApi({
  store: authStore,
  publicOrigin,
  development: process.env.NODE_ENV === 'development',
  proxyToken: internalProxyToken,
  trustedProxyIps: process.env.YUNPANEL_TRUSTED_PROXY_IPS,
  toolGatewayAuthorizer: ({ gateway, request, session }) => {
    if (gateway.id !== 'ttyd') return false;
    const toolSessionId = request.headers['x-yunpanel-tool-session'];
    const transport = request.headers['x-yunpanel-tool-transport'];
    if (typeof toolSessionId !== 'string' || toolSessionId.includes(',')
      || !['http', 'websocket'].includes(transport)) return false;
    return Boolean(ttydSessionManager.authorize(toolSessionId, {
      ownerSessionId: session.id,
      userId: session.user.id,
      markConnected: transport === 'websocket',
    }));
  },
  publicWebhookHandler: createGithubWebhookHandler({
    applicationRegistry,
    applicationEnvironmentRegistry,
    queueApplicationDeploy: applicationDeployQueue,
    localServerId,
  }),
  createHandler: () => createDockerComposeApiHandler({
    runtime: dockerComposeRuntime,
    localServerId,
    baseHandler: createApp({
      registry,
      domainRegistry,
      jobRegistry,
      domainSuspensionRuntime,
      dnsZoneRetirementImpactService: dnsZoneRetirementService,
      dnsZoneRetirementRuntime,
      backupOperationRegistry,
      backupJobStorePath: jobStorePath,
      projectBackupLocked,
      dockerComposeProjectRegistry: dockerComposeRuntime.projectRegistry,
      dockerComposeObserver: dockerComposeRuntime.observer,
      certificateRegistry,
      certificateMaterialManager,
      applicationRegistry,
      runtimeBindingRegistry,
      applicationPassengerMigrationPreviewService,
      applicationPassengerMigrationService,
      websiteRegistry,
      websiteProvisioningRuntime,
      websiteSftpKeyService: websiteSftpKeyRuntime.service,
      databaseBindingRegistry,
      databaseCredentialRegistry,
      databaseCredentialApplyService,
      phpMyAdminHandoffService: phpMyAdminHandoffRuntime ? phpMyAdminHandoffService : null,
      elFinderHandoffService: elFinderHandoffRuntime ? elFinderHandoffService : null,
      databaseInventoryProvider: () => databaseManager.inspect(),
      databaseHealthProvider: () => databaseManager.inspectSecurityBaseline(),
      websiteMigrationPolicy,
      migrationLedger,
      dnsHostingRegistry,
      dnsProviderCredentialRegistry,
      ...(powerDnsAuthoritativeService ? {
        serverDnsIdentityRegistry,
        powerDnsAuthoritativeService,
        powerDnsSecretRegistry,
      } : {}),
      ...(dnsZoneSnapshotRetentionDays === null ? {} : {
        dnsZoneRetirementPolicy: { snapshotRetentionDays: dnsZoneSnapshotRetentionDays },
      }),
      mailDomainRegistry,
      mailDkimRegistry,
      mailDkimRetirementRegistry,
      mailDiagnosticsInspector,
      mailDkimConfigurationService,
      mailServiceIdentityRegistry,
      roundcubeWebmailEndpointResolver,
      mailSrsConfigurationService,
      mailboxRegistry,
      mailboxQuotaRegistry,
      mailboxForwardingRegistry,
      mailAliasRegistry,
      mailConfigurationService,
      roundcubeConfigurationService,
      roundcubeDomainMappingService,
      dockerWorkloadRegistry,
      applicationEnvironmentRegistry,
      applicationDeployQueue,
      journalLogReader,
      nginxLogReader,
      jobLogStore,
      localServerId,
      terminalCapabilityRegistry,
      ttydSessionManager,
    }),
  }),
});

const localRuntime = await startConfiguredLocalRuntime({
  env: process.env,
  hostname: os.hostname(),
  jobStorePath,
  runtimeVersion: API_VERSION,
  registry,
  jobRegistry,
  domainRegistry,
  certificateRegistry,
  applicationRegistry,
  applicationEnvironmentRegistry,
  websiteRegistry,
  runtimeBindingRegistry,
  mailDomainRegistry,
  mailConfigurationService,
  mailDkimConfigurationService,
  roundcubeConfigurationService,
  dnsProviderCredentialRegistry,
  jobLogStore,
  createOperations: (options) => dockerComposeRuntime.extendLocalOperations(createLocalHostOperations({
    ...options,
    databaseManager,
    databaseCredentialOperation: localDatabaseCredentialOperation,
  })),
  inspectServices: inspectAllowlistedServices,
  inspectDocker,
  inspectNginx,
  onError: reportLocalExecutorFault,
});
const renewalScheduler = startCertificateRenewalScheduler({
  certificateRegistry,
  jobRegistry,
  dnsProviderCredentialRegistry,
  intervalMs: certificateRenewalIntervalMs,
  renewBeforeMs: certificateRenewBeforeMs,
});
const server = http.createServer({ headersTimeout: 15_000, requestTimeout: 30_000 }, listener);
const terminalAuthenticator = createLiveConnectionAuthenticator({
  store: authStore,
  publicOrigin,
  development: process.env.NODE_ENV === 'development',
  proxyToken: internalProxyToken,
  trustedProxyIps: process.env.YUNPANEL_TRUSTED_PROXY_IPS,
});
const terminalWebSocket = createTerminalWebSocketServer({
  ...terminalAuthenticator,
  terminalCapabilityRegistry,
  terminalProcessManager,
  liveSessions,
  audit: authStore.audit,
});
server.on('upgrade', terminalWebSocket.handleUpgrade);
server.listen(port, host, () => {
  console.log(`[yunpanel-api] listening on http://${host}:${port}`);
  console.log(`[yunpanel-api] server store=${serverStorePath}`);
  console.log(`[yunpanel-api] domain store=${domainStorePath}`);
  console.log(`[yunpanel-api] domain suspension operation store=${domainSuspensionOperationStorePath}`);
  console.log(`[yunpanel-api] domain removal operation store=${domainRemovalOperationStorePath}`);
  console.log(`[yunpanel-api] DNS zone retirement operation store=${dnsZoneRetirementOperationStorePath}`);
  console.log(`[yunpanel-api] job store=${jobStorePath}`);
  console.log(`[yunpanel-api] backup operation store=${backupOperationStorePath}`);
  console.log(`[yunpanel-api] job log store=${jobLogStorePath}`);
  console.log(`[yunpanel-api] certificate store=${certificateStorePath}`);
  console.log(`[yunpanel-api] application store=${applicationStorePath}`);
  console.log(`[yunpanel-api] application runtime binding store=${applicationRuntimeBindingStorePath}`);
  console.log(`[yunpanel-api] website store=${websiteStorePath}`);
  console.log(`[yunpanel-api] website provisioning store=${websiteProvisioningStorePath}`);
  console.log(`[yunpanel-api] website isolation migration store=${websiteIsolationMigrationStorePath}`);
  console.log(`[yunpanel-api] Website SFTP key store=${websiteSftpKeyStorePath}`);
  console.log(`[yunpanel-api] database binding store=${databaseBindingStorePath}`);
  console.log(`[yunpanel-api] database credential store=${databaseCredentialStorePath}`);
  console.log(`[yunpanel-api] website migration policy store=${websiteMigrationPolicyStorePath}`);
  console.log(`[yunpanel-api] website migration ledger store=${websiteMigrationLedgerStorePath}`);
  console.log(`[yunpanel-api] DNS hosting store=${dnsHostingStorePath}`);
  console.log(`[yunpanel-api] DNS credential store=${dnsProviderCredentialStorePath}`);
  console.log(`[yunpanel-api] server DNS identity store=${serverDnsIdentityStorePath}`);
  console.log(`[yunpanel-api] PowerDNS secret store=${powerDnsSecretStorePath}`);
  console.log(`[yunpanel-api] mail Domain store=${mailDomainStorePath}`);
  console.log(`[yunpanel-api] mail Domain removal operation store=${mailDomainRemovalOperationStorePath}`);
  console.log(`[yunpanel-api] mail DKIM root=${mailDkimRootPath}`);
  console.log(`[yunpanel-api] mail DKIM retirement store=${mailDkimRetirementStorePath}`);
  console.log(`[yunpanel-api] mail service identity store=${mailServiceIdentityStorePath}`);
  console.log(`[yunpanel-api] mail SRS secret store=${mailSrsSecretStorePath}`);
  console.log(`[yunpanel-api] Roundcube secret store=${roundcubeSecretStorePath}`);
  console.log(`[yunpanel-api] Roundcube Domain mapping store=${roundcubeDomainMappingStorePath}`);
  console.log(`[yunpanel-api] mailbox store=${mailboxStorePath}`);
  console.log(`[yunpanel-api] mailbox quota store=${mailboxQuotaStorePath}`);
  console.log(`[yunpanel-api] mailbox forwarding store=${mailboxForwardingStorePath}`);
  console.log(`[yunpanel-api] mail alias store=${mailAliasStorePath}`);
  console.log(`[yunpanel-api] Docker workload store=${dockerWorkloadStorePath}`);
  console.log(`[yunpanel-api] Docker Compose project store=${dockerComposeRuntime.paths.projects}`);
  console.log(`[yunpanel-api] Docker Compose environment store=${dockerComposeRuntime.paths.environments}`);
  console.log(`[yunpanel-api] Docker registry credential store=${dockerComposeRuntime.paths.credentials}`);
  console.log(`[yunpanel-api] application environment store=${applicationEnvironmentStorePath}`);
  console.log(`[yunpanel-api] secret store=${applicationEnvironmentRegistry.secretStoreConfigured ? 'configured' : 'not configured'}`);
  console.log(`[yunpanel-api] authentication=${authStore.configured() ? 'configured' : 'local setup required'}`);
  console.log(`[yunpanel-api] phpMyAdmin handoff=${phpMyAdminHandoffRuntime ? 'enabled' : 'disabled'}`);
  console.log(`[yunpanel-api] elFinder handoff=${elFinderHandoffRuntime ? 'enabled' : 'disabled'}`);
  console.log('[yunpanel-api] ttyd sessions=enabled on-demand Unix socket');
  console.log(`[yunpanel-api] local execution=${localRuntime ? `enabled server=${localRuntime.serverId} operations=${localRuntime.operations.length}` : 'disabled'}`);
  console.log(`[yunpanel-api] site files=${localServerId ? `enabled server=${localServerId}` : 'disabled'}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[yunpanel-api] received ${signal}, shutting down`);
  renewalScheduler.stop();
  if (phpMyAdminHandoffRuntime) {
    try { await phpMyAdminHandoffRuntime.close(); }
    catch { console.error('[yunpanel-api] phpMyAdmin handoff shutdown failed'); }
  }
  if (elFinderHandoffRuntime) {
    try { await elFinderHandoffRuntime.close(); }
    catch { console.error('[yunpanel-api] elFinder handoff shutdown failed'); }
  }
  liveSessions.closeAll('server_shutdown');
  ttydSessionManager.closeAll('server_shutdown');
  terminalWebSocket.closeAll('server_shutdown');
  const closePromise = new Promise((resolve) => {
    server.close((error) => resolve(error ?? null));
  });
  let runtimeStopFailed = false;
  if (localRuntime) {
    try { await localRuntime.stop(); }
    catch {
      runtimeStopFailed = true;
      console.error('[yunpanel-api] local runtime shutdown failed');
    }
  }
  const serverCloseError = await closePromise;
  authStore.close();
  if (serverCloseError || runtimeStopFailed) {
    console.error('[yunpanel-api] shutdown incomplete');
    process.exitCode = 1;
  }
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
