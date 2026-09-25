import { createWebsiteIdentityPathManager } from '@yunpanel/host-runtime';
import { createWebsiteDnsZoneProvisioningHandler } from './website-dns-zone-provisioning-handler.js';
import { createWebsiteCertificateProvisioningHandler } from './website-certificate-provisioning-handler.js';
import { createWebsiteDatabaseProvisioningHandler } from './website-database-provisioning-handler.js';
import { createWebsiteDomainActivationProvisioningHandler } from './website-domain-activation-provisioning-handler.js';
import { createWebsiteMailProvisioningHandler } from './website-mail-provisioning-handler.js';
import { createWebsiteMailDkimKeyProvisioningHandler } from './website-mail-dkim-key-provisioning-handler.js';
import { createWebsiteMailDkimConfigProvisioningHandler } from './website-mail-dkim-config-provisioning-handler.js';
import { createWebsiteMailDnsProvisioningHandler } from './website-mail-dns-provisioning-handler.js';
import { createWebsiteMailHealthProvisioningHandler } from './website-mail-health-provisioning-handler.js';
import { createWebsiteIsolationAuditService, WebsiteIsolationAuditError } from './website-isolation-audit.js';
import { createWebsiteIsolationMigrationRegistry } from './website-isolation-migration-registry.js';
import { createWebsiteIsolationMigrationRuntime } from './website-isolation-migration-runtime.js';
import { createWebsiteNodeReleaseProvisioningHandler } from './website-node-release-provisioning-handler.js';
import { createWebsitePassengerApplicationReleaseProvisioningHandler } from './website-passenger-application-release-provisioning-handler.js';
import { createWebsitePassengerAuthorityProvisioningHandler } from './website-passenger-authority-provisioning-handler.js';
import { createWebsitePassengerEnvironmentProvisioningHandler } from './website-passenger-environment-provisioning-handler.js';
import { createWebsitePassengerEnvironmentStateProvisioningHandler } from './website-passenger-environment-state-provisioning-handler.js';
import { createWebsitePassengerHealthProvisioningHandler } from './website-passenger-health-provisioning-handler.js';
import { createWebsitePythonReleaseProvisioningHandler } from './website-python-release-provisioning-handler.js';
import { createWebsitePythonRuntimeProvisioningHandler } from './website-python-runtime-provisioning-handler.js';
import { createWebsitePythonHealthProvisioningHandler } from './website-python-health-provisioning-handler.js';
import { createWebsitePythonApplicationReleaseProvisioningHandler } from './website-python-application-release-provisioning-handler.js';
import { createWebsiteProvisioningHandlers } from './website-provisioning-handlers-isolation.js';
import {
  createWebsiteProvisioningOrchestrator,
  WebsiteProvisioningOrchestratorError,
} from './website-provisioning-orchestrator.js';
import { createWebsiteProvisioningRegistry } from './website-provisioning-registry.js';
import { createWebsiteRoundcubeProvisioningHandler } from './website-roundcube-provisioning-handler.js';
import { createWebsiteSftpKeyAwareProvisioningHandler } from './website-sftp-provisioning-handler.js';
import { createWebsiteTlsProvisioningHandler } from './website-tls-provisioning-handler.js';
import { createWebsiteWebmailCertificateProvisioningHandler } from './website-webmail-certificate-provisioning-handler.js';

function configuredLocalServerId(value = process.env.YUNPANEL_LOCAL_SERVER_ID) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function createWebsiteProvisioningRuntime({
  filePath = null,
  isolationMigrationFilePath = null,
  now,
  identityManager,
  isolationWorkspaceManager = null,
  passengerSiteManager,
  nodeReleaseManager,
  pythonReleaseManager = null,
  pythonSiteManager = null,
  pythonHealthInspector = null,
  passengerEnvironmentManager,
  passengerHealthInspector,
  staticDeploymentManager,
  staticPublishIsolationManager,
  elFinderFpmSiteManager,
  elFinderSharedApplicationManager,
  elFinderGatewayManager,
  sftpSiteManager,
  nginxManager,
  applicationRegistry = null,
  applicationEnvironmentRegistry = null,
  websiteRegistry = null,
  domainRegistry = null,
  runtimeBindingRegistry = null,
  sftpKeyService = null,
  siteMutationLock = null,
  authorizeActor = null,
} = {}) {
  const resolvedIdentityManager = identityManager ?? createWebsiteIdentityPathManager();
  const workspaceMigrationManager = isolationWorkspaceManager ?? (
    typeof resolvedIdentityManager.inspectWorkspaceOperation === 'function'
    && typeof resolvedIdentityManager.applyWorkspace === 'function'
    && typeof resolvedIdentityManager.inspectWorkspaceCompensation === 'function'
    && typeof resolvedIdentityManager.compensateWorkspace === 'function'
    && typeof resolvedIdentityManager.inspectIdentityOperation === 'function'
    && typeof resolvedIdentityManager.applyIdentityMigration === 'function'
    && typeof resolvedIdentityManager.inspectIdentityMigrationCompensation === 'function'
    && typeof resolvedIdentityManager.compensateIdentityMigration === 'function'
      ? resolvedIdentityManager
      : createWebsiteIdentityPathManager()
  );
  const durableRegistry = createWebsiteProvisioningRegistry({
    filePath,
    ...(now ? { now } : {}),
  });
  const isolationMigrationRegistry = createWebsiteIsolationMigrationRegistry({
    filePath: isolationMigrationFilePath,
    ...(now ? { now } : {}),
  });
  let isolationAudit = null;
  let isolationMigration = null;
  let isolationAuditDependencies = null;

  async function auditIsolation(websiteId) {
    if (!isolationAudit) {
      throw new WebsiteIsolationAuditError(
        'website_isolation_audit_unavailable',
        'Website isolation audit is not configured',
        503,
      );
    }
    return isolationAudit.audit(websiteId);
  }

  const registry = Object.freeze({
    ...durableRegistry,
    get auditIsolation() {
      return isolationAudit ? auditIsolation : null;
    },
  });
  const nodeReleaseHandler = (gitCredentialProvider = null) => createWebsiteNodeReleaseProvisioningHandler({
    ...(nodeReleaseManager ? { nodeReleaseManager } : {}),
    ...(gitCredentialProvider ? { gitCredentialProvider } : {}),
  });
  const pythonReleaseHandler = (gitCredentialProvider = null) => createWebsitePythonReleaseProvisioningHandler({
    ...(pythonReleaseManager ? { pythonReleaseManager } : {}),
    ...(gitCredentialProvider ? { gitCredentialProvider } : {}),
  });
  const handlers = {
    ...createWebsiteProvisioningHandlers({
      identityManager: resolvedIdentityManager,
      ...(passengerSiteManager ? { passengerSiteManager } : {}),
      ...(staticDeploymentManager ? { staticDeploymentManager } : {}),
      ...(staticPublishIsolationManager ? { staticPublishIsolationManager } : {}),
      ...(elFinderFpmSiteManager ? { elFinderFpmSiteManager } : {}),
      ...(elFinderSharedApplicationManager ? { elFinderSharedApplicationManager } : {}),
      ...(elFinderGatewayManager ? { elFinderGatewayManager } : {}),
      ...(sftpSiteManager ? { sftpSiteManager } : {}),
      ...(nginxManager ? { nginxManager } : {}),
    }),
    dns_zone: createWebsiteDnsZoneProvisioningHandler(),
    node_release: nodeReleaseHandler(),
    passenger_health: createWebsitePassengerHealthProvisioningHandler({
      ...(passengerHealthInspector ? { healthInspector: passengerHealthInspector } : {}),
    }),
    python_release: pythonReleaseHandler(),
    python_runtime: createWebsitePythonRuntimeProvisioningHandler({
      ...(pythonSiteManager ? { pythonSiteManager } : {}),
    }),
    python_health: createWebsitePythonHealthProvisioningHandler({
      ...(pythonHealthInspector ? { healthInspector: pythonHealthInspector } : {}),
    }),
    ...(applicationRegistry ? {
      python_application_release: createWebsitePythonApplicationReleaseProvisioningHandler({
        applicationRegistry,
      }),
    } : {}),
  };
  let domainControlPlane = null;
  let passengerEnvironment = null;
  let passengerControlPlane = null;
  let sftpKeyLifecycle = null;
  let certificateControlPlane = null;
  let webmailCertificateControlPlane = null;
  let databaseControlPlane = null;
  let mailControlPlane = null;
  let mailDkimControlPlane = null;
  let roundcubeControlPlane = null;
  let mailHealthControlPlane = null;
  let mailDnsControlPlane = null;

  function configureSftpKeys(dependencies = {}) {
    const nextService = dependencies.sftpKeyService;
    if (!nextService || typeof nextService.reconcile !== 'function'
      || typeof nextService.inspectMaterialization !== 'function') {
      throw new Error('Website SFTP key lifecycle service is required');
    }
    if (sftpKeyLifecycle) {
      if (sftpKeyLifecycle.sftpKeyService !== nextService) {
        throw new Error('Website SFTP key lifecycle service cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.sftp = createWebsiteSftpKeyAwareProvisioningHandler({
      baseHandler: handlers.sftp,
      sftpKeyService: nextService,
    });
    sftpKeyLifecycle = Object.freeze({ sftpKeyService: nextService });
    return Object.freeze({ configured: true });
  }

  function configureIsolationAudit(dependencies = {}) {
    const nextWebsiteRegistry = dependencies.websiteRegistry;
    const nextApplicationRegistry = dependencies.applicationRegistry;
    const nextLocalServerId = configuredLocalServerId(dependencies.localServerId);
    if (!nextWebsiteRegistry || typeof nextWebsiteRegistry.getWebsite !== 'function'
      || !nextApplicationRegistry || typeof nextApplicationRegistry.getApplication !== 'function') {
      throw new Error('Website isolation audit registries are required');
    }
    if (isolationAuditDependencies) {
      if (isolationAuditDependencies.websiteRegistry !== nextWebsiteRegistry
        || isolationAuditDependencies.applicationRegistry !== nextApplicationRegistry
        || isolationAuditDependencies.localServerId !== nextLocalServerId) {
        throw new Error('Website isolation audit dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }

    const scopedWebsiteRegistry = nextLocalServerId
      ? Object.freeze({
        async getWebsite(websiteId) {
          const website = await nextWebsiteRegistry.getWebsite(websiteId);
          return website?.serverId === nextLocalServerId ? website : null;
        },
      })
      : nextWebsiteRegistry;
    isolationAudit = createWebsiteIsolationAuditService({
      websiteRegistry: scopedWebsiteRegistry,
      applicationRegistry: nextApplicationRegistry,
      provisioningRegistry: registry,
      provisioningHandlers: handlers,
      workspaceMigrationAvailable: true,
      identityMigrationAvailable: true,
      sftpMigrationAvailable: Boolean(
        sftpKeyLifecycle
        && typeof handlers.sftp?.inspectMigrationOperation === 'function'
        && typeof handlers.sftp?.applyMigration === 'function'
        && typeof handlers.sftp?.inspectMigrationCompensation === 'function'
        && typeof handlers.sftp?.compensateMigration === 'function'
      ),
      phpMigrationAvailable: Boolean(
        typeof handlers.php_runtime?.inspectMigrationOperation === 'function'
        && typeof handlers.php_runtime?.applyMigration === 'function'
        && typeof handlers.php_runtime?.inspectMigrationCompensation === 'function'
        && typeof handlers.php_runtime?.compensateMigration === 'function'
      ),
      phpContainerMigrationAvailable: Boolean(
        typeof handlers.php_runtime?.inspectContainerMigrationOperation === 'function'
        && typeof handlers.php_runtime?.applyContainerMigration === 'function'
        && typeof handlers.php_runtime?.inspectContainerMigrationCompensation === 'function'
        && typeof handlers.php_runtime?.compensateContainerMigration === 'function'
      ),
      staticControlMigrationAvailable: Boolean(
        typeof handlers.static_runtime?.inspectControlMigrationOperation === 'function'
        && typeof handlers.static_runtime?.applyControlMigration === 'function'
        && typeof handlers.static_runtime?.inspectControlMigrationCompensation === 'function'
        && typeof handlers.static_runtime?.compensateControlMigration === 'function'
      ),
      staticReleaseMigrationAvailable: Boolean(
        typeof handlers.static_runtime?.inspectReleaseMigrationOperation === 'function'
        && typeof handlers.static_runtime?.applyReleaseMigration === 'function'
        && typeof handlers.static_runtime?.inspectReleaseMigrationCompensation === 'function'
        && typeof handlers.static_runtime?.compensateReleaseMigration === 'function'
      ),
    });
    isolationMigration = createWebsiteIsolationMigrationRuntime({
      registry: isolationMigrationRegistry,
      auditService: isolationAudit,
      workspaceManager: workspaceMigrationManager,
      migrationHandlers: handlers,
    });
    isolationAuditDependencies = Object.freeze({
      websiteRegistry: nextWebsiteRegistry,
      applicationRegistry: nextApplicationRegistry,
      localServerId: nextLocalServerId,
    });
    return Object.freeze({ configured: true });
  }

  function configureDomainControlPlane(dependencies = {}) {
    const nextDomainRegistry = dependencies.domainRegistry;
    if (!nextDomainRegistry) throw new Error('Website Domain provisioning registry is required');
    if (domainControlPlane) {
      if (domainControlPlane.domainRegistry !== nextDomainRegistry) {
        throw new Error('Website Domain provisioning registry cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.domain_activation = createWebsiteDomainActivationProvisioningHandler({
      domainRegistry: nextDomainRegistry,
    });
    domainControlPlane = Object.freeze({ domainRegistry: nextDomainRegistry });
    return Object.freeze({ configured: true });
  }

  function configurePassengerEnvironment(dependencies = {}) {
    const nextRegistry = dependencies.applicationEnvironmentRegistry;
    if (!nextRegistry || typeof nextRegistry.materializeDeploymentCredential !== 'function') {
      throw new Error('Passenger Website environment registry is required');
    }
    if (passengerEnvironment) {
      if (passengerEnvironment.applicationEnvironmentRegistry !== nextRegistry) {
        throw new Error('Passenger Website environment registry cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.passenger_environment = createWebsitePassengerEnvironmentProvisioningHandler({
      applicationEnvironmentRegistry: nextRegistry,
      ...(passengerEnvironmentManager ? { environmentManager: passengerEnvironmentManager } : {}),
    });
    handlers.node_release = nodeReleaseHandler(
      (applicationId) => nextRegistry.materializeDeploymentCredential(applicationId),
    );
    handlers.python_release = pythonReleaseHandler(
      (applicationId) => nextRegistry.materializeDeploymentCredential(applicationId),
    );
    passengerEnvironment = Object.freeze({ applicationEnvironmentRegistry: nextRegistry });
    return Object.freeze({ configured: true });
  }

  function configurePassengerControlPlane(dependencies = {}) {
    const {
      applicationRegistry: nextApplicationRegistry,
      websiteRegistry: nextWebsiteRegistry,
      domainRegistry: nextDomainRegistry,
      runtimeBindingRegistry: nextRuntimeBindingRegistry,
    } = dependencies;
    if (!nextApplicationRegistry || !nextWebsiteRegistry || !nextDomainRegistry || !nextRuntimeBindingRegistry) {
      throw new Error('Passenger Website provisioning control-plane dependencies are required');
    }
    if (!passengerEnvironment) {
      throw new Error('Passenger Website environment must be configured before Passenger control-plane handlers');
    }
    const nextEnvironmentRegistry = passengerEnvironment.applicationEnvironmentRegistry;
    configureDomainControlPlane({ domainRegistry: nextDomainRegistry });
    configureIsolationAudit({
      applicationRegistry: nextApplicationRegistry,
      websiteRegistry: nextWebsiteRegistry,
      localServerId: dependencies.localServerId,
    });
    if (passengerControlPlane) {
      if (passengerControlPlane.applicationRegistry !== nextApplicationRegistry
        || passengerControlPlane.applicationEnvironmentRegistry !== nextEnvironmentRegistry
        || passengerControlPlane.websiteRegistry !== nextWebsiteRegistry
        || passengerControlPlane.domainRegistry !== nextDomainRegistry
        || passengerControlPlane.runtimeBindingRegistry !== nextRuntimeBindingRegistry) {
        throw new Error('Passenger Website provisioning control-plane dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.passenger_application_release = createWebsitePassengerApplicationReleaseProvisioningHandler({
      applicationRegistry: nextApplicationRegistry,
    });
    handlers.passenger_environment_state = createWebsitePassengerEnvironmentStateProvisioningHandler({
      applicationRegistry: nextApplicationRegistry,
      applicationEnvironmentRegistry: nextEnvironmentRegistry,
    });
    handlers.passenger_authority = createWebsitePassengerAuthorityProvisioningHandler({
      applicationRegistry: nextApplicationRegistry,
      applicationEnvironmentRegistry: nextEnvironmentRegistry,
      websiteRegistry: nextWebsiteRegistry,
      domainRegistry: nextDomainRegistry,
      runtimeBindingRegistry: nextRuntimeBindingRegistry,
    });
    passengerControlPlane = Object.freeze({
      applicationRegistry: nextApplicationRegistry,
      applicationEnvironmentRegistry: nextEnvironmentRegistry,
      websiteRegistry: nextWebsiteRegistry,
      domainRegistry: nextDomainRegistry,
      runtimeBindingRegistry: nextRuntimeBindingRegistry,
    });
    return Object.freeze({ configured: true });
  }

  let pythonControlPlane = null;
  function configurePythonControlPlane(dependencies = {}) {
    const nextApplicationRegistry = dependencies.applicationRegistry;
    if (!nextApplicationRegistry) throw new Error('Python Website application registry is required');
    if (pythonControlPlane) {
      if (pythonControlPlane.applicationRegistry !== nextApplicationRegistry) {
        throw new Error('Python Website application registry cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.python_application_release = createWebsitePythonApplicationReleaseProvisioningHandler({
      applicationRegistry: nextApplicationRegistry,
    });
    pythonControlPlane = Object.freeze({ applicationRegistry: nextApplicationRegistry });
    return Object.freeze({ configured: true });
  }

  function configureCertificateControlPlane(dependencies = {}) {
    const {
      jobRegistry: nextJobRegistry,
      certificateRegistry: nextCertificateRegistry,
      domainRegistry: nextDomainRegistry,
      acmeEmail: nextAcmeEmail = null,
      waitForTerminalJob: nextWaitForTerminalJob,
      waitForAttachment: nextWaitForAttachment,
    } = dependencies;
    if (!nextJobRegistry || !nextCertificateRegistry || !nextDomainRegistry) {
      throw new Error('Website certificate provisioning dependencies are required');
    }
    if (certificateControlPlane) {
      if (certificateControlPlane.jobRegistry !== nextJobRegistry
        || certificateControlPlane.certificateRegistry !== nextCertificateRegistry
        || certificateControlPlane.domainRegistry !== nextDomainRegistry
        || certificateControlPlane.acmeEmail !== nextAcmeEmail
        || certificateControlPlane.waitForTerminalJob !== nextWaitForTerminalJob
        || certificateControlPlane.waitForAttachment !== nextWaitForAttachment) {
        throw new Error('Website certificate provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.certificate = createWebsiteCertificateProvisioningHandler({
      jobRegistry: nextJobRegistry,
      certificateRegistry: nextCertificateRegistry,
      domainRegistry: nextDomainRegistry,
      acmeEmail: nextAcmeEmail,
      ...(nextWaitForTerminalJob ? { waitForTerminalJob: nextWaitForTerminalJob } : {}),
      ...(nextWaitForAttachment ? { waitForAttachment: nextWaitForAttachment } : {}),
    });
    handlers.tls_activation = createWebsiteTlsProvisioningHandler({
      certificateRegistry: nextCertificateRegistry,
      domainRegistry: nextDomainRegistry,
      nginxProvisioningHandler: handlers.nginx,
    });
    certificateControlPlane = Object.freeze({
      jobRegistry: nextJobRegistry,
      certificateRegistry: nextCertificateRegistry,
      domainRegistry: nextDomainRegistry,
      acmeEmail: nextAcmeEmail,
      waitForTerminalJob: nextWaitForTerminalJob,
      waitForAttachment: nextWaitForAttachment,
    });
    return Object.freeze({ configured: true });
  }

  function configureWebmailCertificateControlPlane(dependencies = {}) {
    const {
      jobRegistry: nextJobRegistry,
      certificateRegistry: nextCertificateRegistry,
      domainRegistry: nextDomainRegistry,
      mailDomainRegistry: nextMailDomainRegistry,
      acmeEmail: nextAcmeEmail = null,
      waitForTerminalJob: nextWaitForTerminalJob,
      waitForActive: nextWaitForActive,
    } = dependencies;
    if (!nextJobRegistry || !nextCertificateRegistry || !nextDomainRegistry || !nextMailDomainRegistry) {
      throw new Error('Website webmail certificate provisioning dependencies are required');
    }
    if (!handlers.certificate) {
      throw new Error('Website certificate provisioning must be configured before webmail certificate provisioning');
    }
    if (webmailCertificateControlPlane) {
      if (webmailCertificateControlPlane.jobRegistry !== nextJobRegistry
        || webmailCertificateControlPlane.certificateRegistry !== nextCertificateRegistry
        || webmailCertificateControlPlane.domainRegistry !== nextDomainRegistry
        || webmailCertificateControlPlane.mailDomainRegistry !== nextMailDomainRegistry
        || webmailCertificateControlPlane.acmeEmail !== nextAcmeEmail
        || webmailCertificateControlPlane.waitForTerminalJob !== nextWaitForTerminalJob
        || webmailCertificateControlPlane.waitForActive !== nextWaitForActive) {
        throw new Error('Website webmail certificate provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.webmail_certificate = createWebsiteWebmailCertificateProvisioningHandler({
      jobRegistry: nextJobRegistry,
      certificateRegistry: nextCertificateRegistry,
      domainRegistry: nextDomainRegistry,
      mailDomainRegistry: nextMailDomainRegistry,
      acmeEmail: nextAcmeEmail,
      ...(nextWaitForTerminalJob ? { waitForTerminalJob: nextWaitForTerminalJob } : {}),
      ...(nextWaitForActive ? { waitForActive: nextWaitForActive } : {}),
    });
    webmailCertificateControlPlane = Object.freeze({
      jobRegistry: nextJobRegistry,
      certificateRegistry: nextCertificateRegistry,
      domainRegistry: nextDomainRegistry,
      mailDomainRegistry: nextMailDomainRegistry,
      acmeEmail: nextAcmeEmail,
      waitForTerminalJob: nextWaitForTerminalJob,
      waitForActive: nextWaitForActive,
    });
    return Object.freeze({ configured: true });
  }

  function configureDatabaseControlPlane(dependencies = {}) {
    const {
      jobRegistry: nextJobRegistry,
      databaseBindingRegistry: nextBindingRegistry,
      databaseCredentialRegistry: nextCredentialRegistry,
      databaseCredentialApplyService: nextApplyService,
      databaseCredentialMaterializer: nextMaterializer,
      databaseInventoryProvider: nextInventoryProvider,
      databaseHealthProvider: nextHealthProvider,
      evidenceInspector: nextEvidenceInspector,
      waitForTerminalJob: nextWaitForTerminalJob,
    } = dependencies;
    if (!nextJobRegistry || !nextBindingRegistry || !nextCredentialRegistry || !nextApplyService
      || !nextMaterializer || typeof nextInventoryProvider !== 'function'
      || typeof nextHealthProvider !== 'function') {
      throw new Error('Website database provisioning dependencies are required');
    }
    if (databaseControlPlane) {
      if (databaseControlPlane.jobRegistry !== nextJobRegistry
        || databaseControlPlane.databaseBindingRegistry !== nextBindingRegistry
        || databaseControlPlane.databaseCredentialRegistry !== nextCredentialRegistry
        || databaseControlPlane.databaseCredentialApplyService !== nextApplyService
        || databaseControlPlane.databaseCredentialMaterializer !== nextMaterializer
        || databaseControlPlane.databaseInventoryProvider !== nextInventoryProvider
        || databaseControlPlane.databaseHealthProvider !== nextHealthProvider
        || databaseControlPlane.evidenceInspector !== nextEvidenceInspector
        || databaseControlPlane.waitForTerminalJob !== nextWaitForTerminalJob) {
        throw new Error('Website database provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.website_database = createWebsiteDatabaseProvisioningHandler({
      jobRegistry: nextJobRegistry,
      databaseBindingRegistry: nextBindingRegistry,
      databaseCredentialRegistry: nextCredentialRegistry,
      databaseCredentialApplyService: nextApplyService,
      databaseCredentialMaterializer: nextMaterializer,
      databaseInventoryProvider: nextInventoryProvider,
      databaseHealthProvider: nextHealthProvider,
      ...(nextEvidenceInspector ? { evidenceInspector: nextEvidenceInspector } : {}),
      ...(nextWaitForTerminalJob ? { waitForTerminalJob: nextWaitForTerminalJob } : {}),
    });
    databaseControlPlane = Object.freeze({
      jobRegistry: nextJobRegistry,
      databaseBindingRegistry: nextBindingRegistry,
      databaseCredentialRegistry: nextCredentialRegistry,
      databaseCredentialApplyService: nextApplyService,
      databaseCredentialMaterializer: nextMaterializer,
      databaseInventoryProvider: nextInventoryProvider,
      databaseHealthProvider: nextHealthProvider,
      evidenceInspector: nextEvidenceInspector,
      waitForTerminalJob: nextWaitForTerminalJob,
    });
    return Object.freeze({ configured: true });
  }

  function configureMailControlPlane(dependencies = {}) {
    const {
      jobRegistry: nextJobRegistry,
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailConfigurationService: nextMailConfigurationService,
      waitForTerminalJob: nextWaitForTerminalJob,
      waitForMailDomain: nextWaitForMailDomain,
    } = dependencies;
    if (!nextJobRegistry || !nextMailDomainRegistry || !nextDomainRegistry || !nextMailConfigurationService) {
      throw new Error('Website managed-mail provisioning dependencies are required');
    }
    if (mailControlPlane) {
      if (mailControlPlane.jobRegistry !== nextJobRegistry
        || mailControlPlane.mailDomainRegistry !== nextMailDomainRegistry
        || mailControlPlane.domainRegistry !== nextDomainRegistry
        || mailControlPlane.mailConfigurationService !== nextMailConfigurationService
        || mailControlPlane.waitForTerminalJob !== nextWaitForTerminalJob
        || mailControlPlane.waitForMailDomain !== nextWaitForMailDomain) {
        throw new Error('Website managed-mail provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.mail_config = createWebsiteMailProvisioningHandler({
      jobRegistry: nextJobRegistry,
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailConfigurationService: nextMailConfigurationService,
      ...(nextWaitForTerminalJob ? { waitForTerminalJob: nextWaitForTerminalJob } : {}),
      ...(nextWaitForMailDomain ? { waitForMailDomain: nextWaitForMailDomain } : {}),
    });
    mailControlPlane = Object.freeze({
      jobRegistry: nextJobRegistry,
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailConfigurationService: nextMailConfigurationService,
      waitForTerminalJob: nextWaitForTerminalJob,
      waitForMailDomain: nextWaitForMailDomain,
    });
    return Object.freeze({ configured: true });
  }

  function configureMailDkimControlPlane(dependencies = {}) {
    const {
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailDkimRegistry: nextMailDkimRegistry,
      jobRegistry: nextJobRegistry = null,
      mailDkimConfigurationService: nextMailDkimConfigurationService = null,
      waitForTerminalJob: nextWaitForTerminalJob,
    } = dependencies;
    if (!nextMailDomainRegistry || !nextDomainRegistry || !nextMailDkimRegistry) {
      throw new Error('Website DKIM provisioning dependencies are required');
    }
    const configureSigning = nextJobRegistry !== null || nextMailDkimConfigurationService !== null;
    if (configureSigning && (!nextJobRegistry || !nextMailDkimConfigurationService || !handlers.mail_config)) {
      throw new Error('Website DKIM signing provisioning requires mail jobs, configuration, and managed-mail control plane');
    }
    if (mailDkimControlPlane) {
      if (mailDkimControlPlane.mailDomainRegistry !== nextMailDomainRegistry
        || mailDkimControlPlane.domainRegistry !== nextDomainRegistry
        || mailDkimControlPlane.mailDkimRegistry !== nextMailDkimRegistry
        || mailDkimControlPlane.jobRegistry !== nextJobRegistry
        || mailDkimControlPlane.mailDkimConfigurationService !== nextMailDkimConfigurationService
        || mailDkimControlPlane.waitForTerminalJob !== nextWaitForTerminalJob) {
        throw new Error('Website DKIM provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.mail_dkim_key = createWebsiteMailDkimKeyProvisioningHandler({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailDkimRegistry: nextMailDkimRegistry,
    });
    if (configureSigning) {
      handlers.mail_dkim_config = createWebsiteMailDkimConfigProvisioningHandler({
        jobRegistry: nextJobRegistry,
        mailDomainRegistry: nextMailDomainRegistry,
        domainRegistry: nextDomainRegistry,
        mailDkimRegistry: nextMailDkimRegistry,
        mailDkimConfigurationService: nextMailDkimConfigurationService,
        mailConfigProvisioningHandler: handlers.mail_config,
        ...(nextWaitForTerminalJob ? { waitForTerminalJob: nextWaitForTerminalJob } : {}),
      });
    }
    mailDkimControlPlane = Object.freeze({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailDkimRegistry: nextMailDkimRegistry,
      jobRegistry: nextJobRegistry,
      mailDkimConfigurationService: nextMailDkimConfigurationService,
      waitForTerminalJob: nextWaitForTerminalJob,
    });
    return Object.freeze({ configured: true });
  }

  function configureRoundcubeControlPlane(dependencies = {}) {
    const {
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      roundcubeDomainMappingRegistry: nextMappingRegistry,
      roundcubeDomainMappingService: nextMappingService,
      roundcubeWebmailEndpointResolver: nextEndpointResolver,
      jobRegistry: nextJobRegistry,
      waitForTerminalJob: nextWaitForTerminalJob,
    } = dependencies;
    if (!nextMailDomainRegistry || !nextDomainRegistry || !nextMappingRegistry
      || !nextMappingService || !nextEndpointResolver || !nextJobRegistry) {
      throw new Error('Website Roundcube provisioning dependencies are required');
    }
    if (!handlers.webmail_certificate) {
      throw new Error('Website webmail certificate provisioning must be configured before Roundcube provisioning');
    }
    if (roundcubeControlPlane) {
      if (roundcubeControlPlane.mailDomainRegistry !== nextMailDomainRegistry
        || roundcubeControlPlane.domainRegistry !== nextDomainRegistry
        || roundcubeControlPlane.roundcubeDomainMappingRegistry !== nextMappingRegistry
        || roundcubeControlPlane.roundcubeDomainMappingService !== nextMappingService
        || roundcubeControlPlane.roundcubeWebmailEndpointResolver !== nextEndpointResolver
        || roundcubeControlPlane.jobRegistry !== nextJobRegistry
        || roundcubeControlPlane.waitForTerminalJob !== nextWaitForTerminalJob) {
        throw new Error('Website Roundcube provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.roundcube_mapping = createWebsiteRoundcubeProvisioningHandler({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      roundcubeDomainMappingRegistry: nextMappingRegistry,
      roundcubeDomainMappingService: nextMappingService,
      roundcubeWebmailEndpointResolver: nextEndpointResolver,
      jobRegistry: nextJobRegistry,
      ...(nextWaitForTerminalJob ? { waitForTerminalJob: nextWaitForTerminalJob } : {}),
    });
    roundcubeControlPlane = Object.freeze({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      roundcubeDomainMappingRegistry: nextMappingRegistry,
      roundcubeDomainMappingService: nextMappingService,
      roundcubeWebmailEndpointResolver: nextEndpointResolver,
      jobRegistry: nextJobRegistry,
      waitForTerminalJob: nextWaitForTerminalJob,
    });
    return Object.freeze({ configured: true });
  }

  function configureMailHealthControlPlane(dependencies = {}) {
    const {
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailConfigurationService: nextMailConfigurationService,
      mailReadinessInspector: nextMailReadinessInspector,
      mailProtocolHealthInspector: nextMailProtocolHealthInspector,
      roundcubeWebmailEndpointResolver: nextEndpointResolver,
      mailDiscoveryEndpointResolver: nextDiscoveryEndpointResolver,
    } = dependencies;
    if (!nextMailDomainRegistry || !nextDomainRegistry || !nextMailConfigurationService
      || !nextMailReadinessInspector || !nextMailProtocolHealthInspector
      || !nextEndpointResolver || !nextDiscoveryEndpointResolver) {
      throw new Error('Website local mail health provisioning dependencies are required');
    }
    if (!handlers.mail_config || !handlers.mail_dkim_config || !handlers.roundcube_mapping) {
      throw new Error('Website local mail health provisioning requires mail, DKIM, and Roundcube control planes');
    }
    if (mailHealthControlPlane) {
      if (mailHealthControlPlane.mailDomainRegistry !== nextMailDomainRegistry
        || mailHealthControlPlane.domainRegistry !== nextDomainRegistry
        || mailHealthControlPlane.mailConfigurationService !== nextMailConfigurationService
        || mailHealthControlPlane.mailReadinessInspector !== nextMailReadinessInspector
        || mailHealthControlPlane.mailProtocolHealthInspector !== nextMailProtocolHealthInspector
        || mailHealthControlPlane.roundcubeWebmailEndpointResolver !== nextEndpointResolver
        || mailHealthControlPlane.mailDiscoveryEndpointResolver !== nextDiscoveryEndpointResolver) {
        throw new Error('Website local mail health provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    handlers.mail_health = createWebsiteMailHealthProvisioningHandler({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailConfigurationService: nextMailConfigurationService,
      mailReadinessInspector: nextMailReadinessInspector,
      mailProtocolHealthInspector: nextMailProtocolHealthInspector,
      roundcubeWebmailEndpointResolver: nextEndpointResolver,
      mailDiscoveryEndpointResolver: nextDiscoveryEndpointResolver,
    });
    mailHealthControlPlane = Object.freeze({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailConfigurationService: nextMailConfigurationService,
      mailReadinessInspector: nextMailReadinessInspector,
      mailProtocolHealthInspector: nextMailProtocolHealthInspector,
      roundcubeWebmailEndpointResolver: nextEndpointResolver,
      mailDiscoveryEndpointResolver: nextDiscoveryEndpointResolver,
    });
    return Object.freeze({ configured: true });
  }

  function configureMailDnsControlPlane(dependencies = {}) {
    const {
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailDkimRegistry: nextMailDkimRegistry,
      dnsZoneReapplyRuntime: nextDnsZoneReapplyRuntime,
    } = dependencies;
    if (!nextMailDomainRegistry || !nextDomainRegistry || !nextMailDkimRegistry || !nextDnsZoneReapplyRuntime) {
      throw new Error('Website local mail DNS provisioning dependencies are required');
    }
    if (mailDnsControlPlane) {
      if (mailDnsControlPlane.mailDomainRegistry !== nextMailDomainRegistry
        || mailDnsControlPlane.domainRegistry !== nextDomainRegistry
        || mailDnsControlPlane.mailDkimRegistry !== nextMailDkimRegistry
        || mailDnsControlPlane.dnsZoneReapplyRuntime !== nextDnsZoneReapplyRuntime) {
        throw new Error('Website local mail DNS provisioning dependencies cannot be replaced');
      }
      return Object.freeze({ configured: true });
    }
    const handler = createWebsiteMailDnsProvisioningHandler({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailDkimRegistry: nextMailDkimRegistry,
      dnsZoneReapplyRuntime: nextDnsZoneReapplyRuntime,
    });
    handlers.mail_dns_reapply = handler;
    mailDnsControlPlane = Object.freeze({
      mailDomainRegistry: nextMailDomainRegistry,
      domainRegistry: nextDomainRegistry,
      mailDkimRegistry: nextMailDkimRegistry,
      dnsZoneReapplyRuntime: nextDnsZoneReapplyRuntime,
    });
    return Object.freeze({ configured: true });
  }

  if (domainRegistry) configureDomainControlPlane({ domainRegistry });
  if (sftpKeyService) configureSftpKeys({ sftpKeyService });
  if (applicationEnvironmentRegistry) configurePassengerEnvironment({ applicationEnvironmentRegistry });
  if (applicationRegistry && websiteRegistry) {
    configureIsolationAudit({ applicationRegistry, websiteRegistry });
  }
  if (applicationRegistry || websiteRegistry || runtimeBindingRegistry) {
    configurePassengerControlPlane({ applicationRegistry, websiteRegistry, domainRegistry, runtimeBindingRegistry });
  }

  const orchestrator = createWebsiteProvisioningOrchestrator({ registry, handlers });

  function submittedActor(value) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 128
      || typeof value.userId !== 'string' || value.userId.length < 1 || value.userId.length > 128
      || !['owner', 'site_manager'].includes(value.role)) {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_actor_invalid',
        'Website provisioning actor evidence is invalid',
        400,
      );
    }
    return Object.freeze({
      sessionId: value.sessionId,
      userId: value.userId,
      role: value.role,
    });
  }

  async function requireLiveActor(actor, websiteId) {
    const submitted = submittedActor(actor);
    if (authorizeActor === null) return submitted;
    if (typeof authorizeActor !== 'function') {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_actor_authorizer_unavailable',
        'Website provisioning actor authorization is unavailable',
        503,
      );
    }
    if (!submitted) {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_actor_required',
        'Live Website provisioning authorization is required',
        403,
      );
    }
    let current;
    try { current = await authorizeActor(submitted, websiteId); }
    catch {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_actor_forbidden',
        'Website access changed before provisioning could continue',
        403,
      );
    }
    if (!current || current.sessionId !== submitted.sessionId
      || current.userId !== submitted.userId || current.role !== submitted.role) {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_actor_forbidden',
        'Website access changed before provisioning could continue',
        403,
      );
    }
    return Object.freeze({
      sessionId: current.sessionId,
      userId: current.userId,
      role: current.role,
    });
  }

  async function withOperationMutationLock(operationId, actor, action, { authorize = true } = {}) {
    const operation = await registry.get(operationId);
    if (!operation) return action();
    const applicationId = operation.resources?.application?.id
      ?? operation.resources?.website?.applicationId
      ?? null;
    const execute = async () => {
      const liveActor = authorize ? await requireLiveActor(actor, operation.websiteId) : null;
      if (liveActor) {
        if (typeof registry.refreshActor !== 'function') {
          throw new WebsiteProvisioningOrchestratorError(
            'website_provisioning_actor_journal_unavailable',
            'Website provisioning actor journal is unavailable',
            503,
          );
        }
        await registry.refreshActor({ operationId, actor: liveActor });
      }
      return action(liveActor);
    };
    if (!siteMutationLock) return execute();
    if (typeof siteMutationLock.withSiteLock !== 'function') {
      throw new WebsiteProvisioningOrchestratorError(
        'website_provisioning_lock_unavailable',
        'Website provisioning site mutation lock is invalid',
        503,
      );
    }
    return siteMutationLock.withSiteLock({
      applicationId,
      websiteId: operation.websiteId,
    }, execute);
  }

  async function runNext(operationId, actor = null) {
    return withOperationMutationLock(
      operationId,
      actor,
      (liveActor) => orchestrator.runNext(operationId, liveActor),
    );
  }

  async function retryStep(operationId, stepId, actor = null) {
    return withOperationMutationLock(operationId, actor, async (liveActor) => {
      await registry.retryStep({ operationId, stepId });
      return orchestrator.runNext(operationId, liveActor);
    });
  }

  async function compensateStep(operationId, stepId, actor = null) {
    return withOperationMutationLock(
      operationId,
      actor,
      (liveActor) => orchestrator.compensateStep(operationId, stepId, liveActor),
    );
  }

  async function init() {
    await registry.init();
    if (isolationMigration) await isolationMigration.init();
    const interrupted = await registry.listInterrupted();
    const reconciled = [];
    for (const operation of interrupted) {
      // listInterrupted only returns applying/compensating operations. runNext therefore
      // takes the inspect-first reconciliation path and never starts a new pending host mutation.
      reconciled.push(await withOperationMutationLock(
        operation.operationId,
        null,
        () => orchestrator.runNext(operation.operationId),
        { authorize: false },
      ));
    }
    return Object.freeze(reconciled);
  }

  return Object.freeze({
    registry,
    handlers,
    orchestrator,
    get isolationMigration() {
      return isolationMigration;
    },
    configureSftpKeys,
    configureIsolationAudit,
    configureDomainControlPlane,
    configurePassengerEnvironment,
    configurePassengerControlPlane,
    configurePythonControlPlane,
    configureCertificateControlPlane,
    configureWebmailCertificateControlPlane,
    configureDatabaseControlPlane,
    configureMailControlPlane,
    configureMailDkimControlPlane,
    configureRoundcubeControlPlane,
    configureMailHealthControlPlane,
    configureMailDnsControlPlane,
    init,
    get: (operationId) => registry.get(operationId),
    create: (plan) => registry.create(plan),
    auditIsolation,
    runNext,
    retryStep,
    compensateStep,
    supportsCompensation: (stepKind) => orchestrator.supportsCompensation(stepKind),
    listInterrupted: () => registry.listInterrupted(),
  });
}

export const websiteProvisioningRuntimeInternals = Object.freeze({
  configuredLocalServerId,
});
