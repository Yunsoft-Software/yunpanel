import {
  createAcmeManager,
  createCloudflareDnsManager,
  createDatabaseManager,
  createMailConfigActivator,
  createMailConfigBackupManager,
  createMailConfigManager,
  createMailDataBackupManager,
  createMailDataRestoreManager,
  createMailDkimActivator,
  createManagedServiceManager,
  createNginxManager,
  createNodeDeploymentManager,
  createNodeRestartManager,
  createNodeProcessManager,
  createNodeRuntimeManager,
  createNodeRollbackManager,
  createNodeStatusInspector,
  createStaticDeploymentManager,
  createStaticDeploymentReceiptStore,
  createStaticRollbackManager,
  createSystemPackageManager,
} from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { normalizeGitDeploymentCredential } from '@yunpanel/shared';
import { createLocalRoundcubeConfigOperation } from './local-roundcube-config-operation.js';

export const LOCAL_HOST_OPERATIONS = Object.freeze([
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_SERVICES_INSPECT,
  OPERATIONS.SYSTEM_SERVICE_INSTALL,
  OPERATIONS.SYSTEM_SERVICE_CONTROL,
  OPERATIONS.SYSTEM_UPGRADE,
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
  OPERATIONS.DNS_RECORD_APPLY,
  OPERATIONS.DOMAIN_STAGE,
  OPERATIONS.DOMAIN_ACTIVATE,
  OPERATIONS.SSL_ISSUE,
  OPERATIONS.SSL_RENEW,
  OPERATIONS.APP_STATIC_DEPLOY,
  OPERATIONS.APP_STATIC_ROLLBACK,
  OPERATIONS.APP_NODE_STATUS,
  OPERATIONS.APP_NODE_PROCESS,
  OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT,
  OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL,
]);

export const LOCAL_NODE_ENVIRONMENT_OPERATIONS = Object.freeze([
  OPERATIONS.APP_NODE_DEPLOY,
  OPERATIONS.APP_NODE_ROLLBACK,
  OPERATIONS.APP_NODE_RESTART,
]);

export const LOCAL_MAIL_CONFIGURATION_OPERATIONS = Object.freeze([
  OPERATIONS.MAIL_CONFIG_APPLY,
  OPERATIONS.MAIL_DKIM_APPLY,
]);

export const LOCAL_MAIL_DATA_OPERATIONS = Object.freeze([
  OPERATIONS.MAIL_DATA_BACKUP,
  OPERATIONS.MAIL_DATA_RESTORE,
]);

export const LOCAL_ROUNDCUBE_CONFIGURATION_OPERATIONS = Object.freeze([
  OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
]);

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function validEnvironmentBundle(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertMailExecutionContext(payload, execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || typeof execution.jobId !== 'string' || !EXECUTION_ID_PATTERN.test(execution.jobId)
    || execution.resourceType !== 'mail_domain' || execution.resourceId !== payload.mailDomainId) {
    const error = new Error('Managed mail execution context does not match the queued resource');
    error.code = 'mail_execution_context_invalid';
    throw error;
  }
  return execution;
}

export function createLocalHostOperations({
  packageManager = createSystemPackageManager({
    restartUnits: ['yunpanel-api.service', 'yunpanel-web.service'],
  }),
  managedServiceManager = createManagedServiceManager(),
  databaseManager = createDatabaseManager(),
  nginxManager = createNginxManager(),
  acmeManager = createAcmeManager(),
  cloudflareDnsManager = createCloudflareDnsManager(),
  staticDeploymentManager = null,
  staticDeploymentReceiptStore = createStaticDeploymentReceiptStore(),
  staticRollbackManager = createStaticRollbackManager(),
  nodeDeploymentManager = null,
  nodeRollbackManager = createNodeRollbackManager(),
  nodeRestartManager = createNodeRestartManager(),
  nodeProcessManager = createNodeProcessManager(),
  nodeRuntimeManager = createNodeRuntimeManager(),
  nodeStatusInspector = createNodeStatusInspector(),
  mailConfigManager = null,
  mailConfigBackupManager = null,
  mailConfigActivator = null,
  mailDkimActivator = null,
  mailDataBackupManager = null,
  mailDataRestoreManager = null,
  roundcubeConfigOperation = null,
  loadManagedMailConfiguration = null,
  loadManagedDkimConfiguration = null,
  loadRoundcubeConfiguration = null,
  loadApplicationEnvironment = null,
  loadDeploymentCredential = null,
  loadDnsProviderCredential = null,
  jobLogStore = null,
} = {}) {
  if (loadApplicationEnvironment !== null && typeof loadApplicationEnvironment !== 'function') {
    throw new Error('loadApplicationEnvironment must be a function when configured');
  }
  if (loadDeploymentCredential !== null && typeof loadDeploymentCredential !== 'function') {
    throw new Error('loadDeploymentCredential must be a function when configured');
  }
  if (loadDnsProviderCredential !== null && typeof loadDnsProviderCredential !== 'function') {
    throw new Error('loadDnsProviderCredential must be a function when configured');
  }
  if (loadManagedMailConfiguration !== null && typeof loadManagedMailConfiguration !== 'function') {
    throw new Error('loadManagedMailConfiguration must be a function when configured');
  }
  if (loadManagedDkimConfiguration !== null && typeof loadManagedDkimConfiguration !== 'function') {
    throw new Error('loadManagedDkimConfiguration must be a function when configured');
  }
  if (loadRoundcubeConfiguration !== null && typeof loadRoundcubeConfiguration !== 'function') {
    throw new Error('loadRoundcubeConfiguration must be a function when configured');
  }
  if (roundcubeConfigOperation !== null && typeof roundcubeConfigOperation?.execute !== 'function') {
    throw new Error('roundcubeConfigOperation must provide execute() when configured');
  }
  if (!cloudflareDnsManager || typeof cloudflareDnsManager.applyRecord !== 'function') {
    throw new Error('cloudflareDnsManager must provide applyRecord()');
  }
  if (jobLogStore !== null && typeof jobLogStore.record !== 'function') {
    throw new Error('jobLogStore must provide record() when configured');
  }
  if (!staticDeploymentReceiptStore || typeof staticDeploymentReceiptStore.write !== 'function') {
    throw new Error('staticDeploymentReceiptStore must provide write()');
  }
  const deploymentLog = jobLogStore ? (entry) => jobLogStore.record(entry) : null;
  const resolvedStaticDeploymentManager = staticDeploymentManager ?? createStaticDeploymentManager({ recordLog: deploymentLog });
  const resolvedNodeDeploymentManager = nodeDeploymentManager ?? createNodeDeploymentManager({ recordLog: deploymentLog });
  const resolvedMailConfigManager = mailConfigManager ?? createMailConfigManager();
  const resolvedMailConfigBackupManager = mailConfigBackupManager ?? createMailConfigBackupManager();
  const resolvedMailConfigActivator = mailConfigActivator ?? createMailConfigActivator({
    configManager: resolvedMailConfigManager,
    backupManager: resolvedMailConfigBackupManager,
  });
  const resolvedMailDkimActivator = mailDkimActivator ?? createMailDkimActivator();
  const resolvedMailDataBackupManager = mailDataBackupManager ?? createMailDataBackupManager();
  const resolvedMailDataRestoreManager = mailDataRestoreManager ?? createMailDataRestoreManager({
    backupManager: resolvedMailDataBackupManager,
  });
  const resolvedRoundcubeConfigOperation = roundcubeConfigOperation ?? (loadRoundcubeConfiguration
    ? createLocalRoundcubeConfigOperation({ loadConfiguration: loadRoundcubeConfiguration })
    : null);

  if (!resolvedMailConfigManager || typeof resolvedMailConfigManager.stageConfiguration !== 'function') {
    throw new Error('mailConfigManager must provide stageConfiguration()');
  }
  if (!resolvedMailConfigBackupManager || typeof resolvedMailConfigBackupManager.backupConfiguration !== 'function') {
    throw new Error('mailConfigBackupManager must provide backupConfiguration()');
  }
  if (!resolvedMailConfigActivator || typeof resolvedMailConfigActivator.activateConfiguration !== 'function') {
    throw new Error('mailConfigActivator must provide activateConfiguration()');
  }
  if (!resolvedMailDkimActivator || typeof resolvedMailDkimActivator.activate !== 'function') {
    throw new Error('mailDkimActivator must provide activate()');
  }
  if (!resolvedMailDataBackupManager || typeof resolvedMailDataBackupManager.backup !== 'function') {
    throw new Error('mailDataBackupManager must provide backup()');
  }
  if (!resolvedMailDataRestoreManager || typeof resolvedMailDataRestoreManager.restore !== 'function') {
    throw new Error('mailDataRestoreManager must provide restore()');
  }

  async function withApplicationEnvironment(payload, execute) {
    const environment = await loadApplicationEnvironment(payload.applicationId, payload.environmentRevision ?? null);
    if (!validEnvironmentBundle(environment)) {
      const error = new Error('Application environment provider returned an invalid bundle');
      error.code = 'invalid_environment_bundle';
      throw error;
    }
    return execute({ ...payload, environment });
  }

  async function credentialFor(applicationId) {
    if (!loadDeploymentCredential) return null;
    try { return normalizeGitDeploymentCredential(await loadDeploymentCredential(applicationId)); }
    catch {
      const error = new Error('Deployment credential provider returned an invalid credential');
      error.code = 'invalid_git_credential';
      throw error;
    }
  }

  async function deployStaticWithReceipt(payload) {
    const gitCredential = await credentialFor(payload.applicationId);
    const result = await resolvedStaticDeploymentManager.deployStatic(payload, { gitCredential });
    try {
      await staticDeploymentReceiptStore.write({
        applicationId: payload.applicationId,
        deploymentId: payload.deploymentId,
        result,
      });
    } catch {
      // A recovery receipt is additional crash evidence, not part of the host
      // deployment transaction. Never recast a completed deploy as failed just
      // because its optional recovery receipt could not be persisted.
    }
    return result;
  }

  async function executeCertificate(payload, execute) {
    if (payload.challenge?.type !== 'dns-01') return execute(payload);
    if (!loadDnsProviderCredential) {
      const error = new Error('DNS provider credential loader is unavailable');
      error.code = 'dns_provider_credential_unavailable';
      throw error;
    }
    const dnsCredential = await loadDnsProviderCredential(payload.challenge.credentialId);
    return execute(payload, { dnsCredential });
  }

  async function executeDnsRecord(payload) {
    if (!loadDnsProviderCredential) {
      const error = new Error('DNS provider credential loader is unavailable');
      error.code = 'dns_provider_credential_unavailable';
      throw error;
    }
    const dnsCredential = await loadDnsProviderCredential(payload.credentialId);
    return cloudflareDnsManager.applyRecord(payload, { dnsCredential });
  }

  async function executeManagedMailConfiguration(payload, execution) {
    assertMailExecutionContext(payload, execution);
    const bundle = await loadManagedMailConfiguration(payload);
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || !bundle.preview || !Array.isArray(bundle.sensitiveArtifacts)) {
      const error = new Error('Managed mail configuration provider returned an invalid private bundle');
      error.code = 'mail_configuration_bundle_invalid';
      throw error;
    }
    if (bundle.preview.sha256 !== payload.configurationSha256) {
      const error = new Error('Managed mail configuration provider returned stale desired state');
      error.code = 'mail_configuration_preview_stale';
      throw error;
    }

    await resolvedMailConfigManager.stageConfiguration(bundle.preview, {
      sensitiveArtifacts: bundle.sensitiveArtifacts,
    });
    await resolvedMailConfigBackupManager.backupConfiguration(bundle.preview, {
      transactionId: execution.jobId,
    });
    const activation = await resolvedMailConfigActivator.activateConfiguration(bundle.preview, {
      transactionId: execution.jobId,
    });
    if (!activation || activation.applied !== true || activation.sideEffects !== true
      || activation.previewSha256 !== payload.configurationSha256) {
      const error = new Error('Managed mail activation did not confirm the queued configuration');
      error.code = 'mail_config_activation_unconfirmed';
      throw error;
    }
    return Object.freeze({
      version: 1,
      mailDomainId: payload.mailDomainId,
      desiredStatus: payload.desiredStatus,
      previewDigest: payload.previewDigest,
      configurationSha256: payload.configurationSha256,
      planSha256: activation.planSha256,
      readinessSha256: activation.readinessSha256,
      applied: true,
      sideEffects: true,
    });
  }

  async function executeManagedDkimConfiguration(payload, execution) {
    assertMailExecutionContext(payload, execution);
    const bundle = await loadManagedDkimConfiguration(payload);
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || !bundle.preview || !Array.isArray(bundle.keys)) {
      const error = new Error('Managed DKIM provider returned an invalid private bundle');
      error.code = 'mail_dkim_bundle_invalid';
      throw error;
    }
    if (bundle.preview.sha256 !== payload.configurationSha256) {
      const error = new Error('Managed DKIM provider returned stale desired state');
      error.code = 'mail_dkim_preview_stale';
      throw error;
    }
    const activation = await resolvedMailDkimActivator.activate(bundle, {
      transactionId: execution.jobId,
    });
    if (!activation || activation.applied !== true || activation.sideEffects !== true
      || activation.previewSha256 !== payload.configurationSha256) {
      const error = new Error('Managed DKIM activation did not confirm the queued configuration');
      error.code = 'mail_dkim_activation_unconfirmed';
      throw error;
    }
    return Object.freeze({
      version: 1,
      mailDomainId: payload.mailDomainId,
      expectedKeyRevision: payload.expectedKeyRevision,
      previewDigest: payload.previewDigest,
      configurationSha256: payload.configurationSha256,
      applied: true,
      sideEffects: true,
    });
  }

  async function executeMailDataBackup(payload, execution) {
    assertMailExecutionContext(payload, execution);
    const manifest = await resolvedMailDataBackupManager.backup({
      backupId: execution.jobId,
      scope: payload.scope,
      identity: payload.identity,
      expectedSnapshotSha256: payload.expectedSnapshotSha256,
    });
    if (!manifest || manifest.backupId !== execution.jobId || manifest.scope !== payload.scope
      || manifest.identity !== payload.identity || manifest.sourceSnapshotSha256 !== payload.expectedSnapshotSha256
      || typeof manifest.sourcePresent !== 'boolean') {
      const error = new Error('Mail data backup did not confirm the queued snapshot');
      error.code = 'mail_data_backup_unconfirmed';
      throw error;
    }
    return Object.freeze({
      version: 1,
      backupId: manifest.backupId,
      mailDomainId: payload.mailDomainId,
      scope: payload.scope,
      identity: payload.identity,
      sourcePresent: manifest.sourcePresent,
      sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      contentSha256: manifest.contentSha256,
      bytes: manifest.bytes,
      files: manifest.files,
      directories: manifest.directories,
      backedUp: true,
      sideEffects: true,
    });
  }

  async function executeMailDataRestore(payload, execution) {
    assertMailExecutionContext(payload, execution);
    const activation = await resolvedMailDataRestoreManager.restore({
      transactionId: execution.jobId,
      backupId: payload.backupId,
      scope: payload.scope,
      identity: payload.identity,
      expectedTargetSnapshotSha256: payload.expectedTargetSnapshotSha256,
    });
    if (!activation || activation.transactionId !== execution.jobId || activation.backupId !== payload.backupId
      || activation.scope !== payload.scope || activation.identity !== payload.identity
      || activation.restoredPresent !== true || activation.applied !== true || activation.sideEffects !== true) {
      const error = new Error('Mail data restore did not confirm the queued restore');
      error.code = 'mail_data_restore_unconfirmed';
      throw error;
    }
    return Object.freeze({
      version: 1,
      transactionId: activation.transactionId,
      backupId: activation.backupId,
      preRestoreBackupId: activation.preRestoreBackupId,
      mailDomainId: payload.mailDomainId,
      scope: payload.scope,
      identity: payload.identity,
      contentSha256: activation.contentSha256,
      bytes: activation.bytes,
      files: activation.files,
      directories: activation.directories,
      restoredPresent: true,
      applied: true,
      sideEffects: true,
    });
  }

  const handlers = new Map([
    [OPERATIONS.SYSTEM_PACKAGES_INSPECT, () => packageManager.inspect()],
    [OPERATIONS.SYSTEM_SERVICES_INSPECT, (payload) => managedServiceManager.inspect(payload.serviceId ?? null)],
    [OPERATIONS.SYSTEM_SERVICE_INSTALL, (payload) => managedServiceManager.install(payload.serviceId)],
    [OPERATIONS.SYSTEM_SERVICE_CONTROL, (payload) => managedServiceManager.control(payload.serviceId, payload.action)],
    [OPERATIONS.SYSTEM_UPGRADE, () => packageManager.upgrade()],
    [OPERATIONS.DATABASE_INSPECT, () => databaseManager.inspect()],
    [OPERATIONS.DATABASE_CREATE, (payload) => databaseManager.createDatabase(payload.name)],
    [OPERATIONS.DATABASE_DELETE, (payload) => databaseManager.dropDatabase(payload.name)],
    [OPERATIONS.DNS_RECORD_APPLY, executeDnsRecord],
    [OPERATIONS.DOMAIN_STAGE, (payload) => nginxManager.stageDomain(payload)],
    [OPERATIONS.DOMAIN_ACTIVATE, (payload) => nginxManager.activateDomain(payload)],
    [OPERATIONS.SSL_ISSUE, (payload) => executeCertificate(payload, (input, execution) => acmeManager.issueCertificate(input, execution))],
    [OPERATIONS.SSL_RENEW, (payload) => executeCertificate(payload, (input, execution) => acmeManager.renewCertificate(input, execution))],
    [OPERATIONS.APP_STATIC_DEPLOY, (payload) => deployStaticWithReceipt(payload)],
    [OPERATIONS.APP_STATIC_ROLLBACK, (payload) => staticRollbackManager.rollbackStatic(payload)],
    [OPERATIONS.APP_NODE_STATUS, (payload) => nodeStatusInspector.inspectNodeStatus(payload)],
    [OPERATIONS.APP_NODE_PROCESS, (payload) => nodeProcessManager.controlNodeProcess(payload)],
    [OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, () => nodeRuntimeManager.inspect()],
    [OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, (payload) => nodeRuntimeManager.install(payload.major)],
    [OPERATIONS.MAIL_DATA_BACKUP, executeMailDataBackup],
    [OPERATIONS.MAIL_DATA_RESTORE, executeMailDataRestore],
  ]);

  if (loadApplicationEnvironment) {
    handlers.set(OPERATIONS.APP_NODE_DEPLOY, (payload) => withApplicationEnvironment(payload, async (hydrated) => resolvedNodeDeploymentManager.deployNode(hydrated, {
      gitCredential: await credentialFor(payload.applicationId),
    })));
    handlers.set(OPERATIONS.APP_NODE_ROLLBACK, (payload) => withApplicationEnvironment(payload, (hydrated) => nodeRollbackManager.rollbackNode(hydrated)));
    handlers.set(OPERATIONS.APP_NODE_RESTART, (payload) => withApplicationEnvironment(payload, (hydrated) => nodeRestartManager.restartNode(hydrated)));
  }
  if (loadManagedMailConfiguration) {
    handlers.set(OPERATIONS.MAIL_CONFIG_APPLY, executeManagedMailConfiguration);
  }
  if (loadManagedDkimConfiguration) {
    handlers.set(OPERATIONS.MAIL_DKIM_APPLY, executeManagedDkimConfiguration);
  }
  if (resolvedRoundcubeConfigOperation) {
    handlers.set(OPERATIONS.ROUNDCUBE_CONFIG_APPLY, (payload, execution) => resolvedRoundcubeConfigOperation.execute(payload, execution));
  }

  return {
    operations: [...handlers.keys()],
    supports(operation) {
      return handlers.has(operation);
    },
    async executeOperation(operation, payload = {}, execution = null) {
      const handler = handlers.get(operation);
      if (!handler) {
        const error = new Error('Host operation has not been migrated to the local runtime');
        error.code = 'local_operation_not_migrated';
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        const error = new Error('Local host operation payload must be an object');
        error.code = 'invalid_local_operation_payload';
        throw error;
      }
      return handler(payload, execution);
    },
  };
}

export const localHostOperationInternals = Object.freeze({
  assertMailExecutionContext,
});
