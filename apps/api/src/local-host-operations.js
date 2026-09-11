import {
  createAcmeManager,
  createDatabaseManager,
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

export const LOCAL_HOST_OPERATIONS = Object.freeze([
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_SERVICES_INSPECT,
  OPERATIONS.SYSTEM_SERVICE_INSTALL,
  OPERATIONS.SYSTEM_SERVICE_CONTROL,
  OPERATIONS.SYSTEM_UPGRADE,
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
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

function validEnvironmentBundle(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function createLocalHostOperations({
  packageManager = createSystemPackageManager({
    restartUnits: ['yunpanel-api.service', 'yunpanel-web.service'],
  }),
  managedServiceManager = createManagedServiceManager(),
  databaseManager = createDatabaseManager(),
  nginxManager = createNginxManager(),
  acmeManager = createAcmeManager(),
  staticDeploymentManager = null,
  staticDeploymentReceiptStore = createStaticDeploymentReceiptStore(),
  staticRollbackManager = createStaticRollbackManager(),
  nodeDeploymentManager = null,
  nodeRollbackManager = createNodeRollbackManager(),
  nodeRestartManager = createNodeRestartManager(),
  nodeProcessManager = createNodeProcessManager(),
  nodeRuntimeManager = createNodeRuntimeManager(),
  nodeStatusInspector = createNodeStatusInspector(),
  loadApplicationEnvironment = null,
  loadDeploymentCredential = null,
  jobLogStore = null,
} = {}) {
  if (loadApplicationEnvironment !== null && typeof loadApplicationEnvironment !== 'function') {
    throw new Error('loadApplicationEnvironment must be a function when configured');
  }
  if (loadDeploymentCredential !== null && typeof loadDeploymentCredential !== 'function') {
    throw new Error('loadDeploymentCredential must be a function when configured');
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

  const handlers = new Map([
    [OPERATIONS.SYSTEM_PACKAGES_INSPECT, () => packageManager.inspect()],
    [OPERATIONS.SYSTEM_SERVICES_INSPECT, (payload) => managedServiceManager.inspect(payload.serviceId ?? null)],
    [OPERATIONS.SYSTEM_SERVICE_INSTALL, (payload) => managedServiceManager.install(payload.serviceId)],
    [OPERATIONS.SYSTEM_SERVICE_CONTROL, (payload) => managedServiceManager.control(payload.serviceId, payload.action)],
    [OPERATIONS.SYSTEM_UPGRADE, () => packageManager.upgrade()],
    [OPERATIONS.DATABASE_INSPECT, () => databaseManager.inspect()],
    [OPERATIONS.DATABASE_CREATE, (payload) => databaseManager.createDatabase(payload.name)],
    [OPERATIONS.DATABASE_DELETE, (payload) => databaseManager.dropDatabase(payload.name)],
    [OPERATIONS.DOMAIN_STAGE, (payload) => nginxManager.stageDomain(payload)],
    [OPERATIONS.DOMAIN_ACTIVATE, (payload) => nginxManager.activateDomain(payload)],
    [OPERATIONS.SSL_ISSUE, (payload) => acmeManager.issueCertificate(payload)],
    [OPERATIONS.SSL_RENEW, (payload) => acmeManager.renewCertificate(payload)],
    [OPERATIONS.APP_STATIC_DEPLOY, (payload) => deployStaticWithReceipt(payload)],
    [OPERATIONS.APP_STATIC_ROLLBACK, (payload) => staticRollbackManager.rollbackStatic(payload)],
    [OPERATIONS.APP_NODE_STATUS, (payload) => nodeStatusInspector.inspectNodeStatus(payload)],
    [OPERATIONS.APP_NODE_PROCESS, (payload) => nodeProcessManager.controlNodeProcess(payload)],
    [OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, () => nodeRuntimeManager.inspect()],
    [OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, (payload) => nodeRuntimeManager.install(payload.major)],
  ]);

  if (loadApplicationEnvironment) {
    handlers.set(OPERATIONS.APP_NODE_DEPLOY, (payload) => withApplicationEnvironment(payload, async (hydrated) => resolvedNodeDeploymentManager.deployNode(hydrated, {
      gitCredential: await credentialFor(payload.applicationId),
    })));
    handlers.set(OPERATIONS.APP_NODE_ROLLBACK, (payload) => withApplicationEnvironment(payload, (hydrated) => nodeRollbackManager.rollbackNode(hydrated)));
    handlers.set(OPERATIONS.APP_NODE_RESTART, (payload) => withApplicationEnvironment(payload, (hydrated) => nodeRestartManager.restartNode(hydrated)));
  }

  return {
    operations: [...handlers.keys()],
    supports(operation) {
      return handlers.has(operation);
    },
    async executeOperation(operation, payload = {}) {
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
      return handler(payload);
    },
  };
}
