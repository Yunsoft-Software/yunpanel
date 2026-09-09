import {
  createAcmeManager,
  createManagedServiceManager,
  createNginxManager,
  createNodeDeploymentManager,
  createNodeRestartManager,
  createNodeRollbackManager,
  createNodeStatusInspector,
  createStaticDeploymentManager,
  createStaticRollbackManager,
  createSystemPackageManager,
} from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';

export const LOCAL_HOST_OPERATIONS = Object.freeze([
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_SERVICES_INSPECT,
  OPERATIONS.SYSTEM_SERVICE_INSTALL,
  OPERATIONS.SYSTEM_SERVICE_CONTROL,
  OPERATIONS.SYSTEM_UPGRADE,
  OPERATIONS.DOMAIN_STAGE,
  OPERATIONS.DOMAIN_ACTIVATE,
  OPERATIONS.SSL_ISSUE,
  OPERATIONS.SSL_RENEW,
  OPERATIONS.APP_STATIC_DEPLOY,
  OPERATIONS.APP_STATIC_ROLLBACK,
  OPERATIONS.APP_NODE_STATUS,
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
  nginxManager = createNginxManager(),
  acmeManager = createAcmeManager(),
  staticDeploymentManager = createStaticDeploymentManager(),
  staticRollbackManager = createStaticRollbackManager(),
  nodeDeploymentManager = createNodeDeploymentManager(),
  nodeRollbackManager = createNodeRollbackManager(),
  nodeRestartManager = createNodeRestartManager(),
  nodeStatusInspector = createNodeStatusInspector(),
  loadApplicationEnvironment = null,
} = {}) {
  if (loadApplicationEnvironment !== null && typeof loadApplicationEnvironment !== 'function') {
    throw new Error('loadApplicationEnvironment must be a function when configured');
  }

  async function withApplicationEnvironment(payload, execute) {
    const environment = await loadApplicationEnvironment(payload.applicationId);
    if (!validEnvironmentBundle(environment)) {
      const error = new Error('Application environment provider returned an invalid bundle');
      error.code = 'invalid_environment_bundle';
      throw error;
    }
    return execute({ ...payload, environment });
  }

  const handlers = new Map([
    [OPERATIONS.SYSTEM_PACKAGES_INSPECT, () => packageManager.inspect()],
    [OPERATIONS.SYSTEM_SERVICES_INSPECT, (payload) => managedServiceManager.inspect(payload.serviceId ?? null)],
    [OPERATIONS.SYSTEM_SERVICE_INSTALL, (payload) => managedServiceManager.install(payload.serviceId)],
    [OPERATIONS.SYSTEM_SERVICE_CONTROL, (payload) => managedServiceManager.control(payload.serviceId, payload.action)],
    [OPERATIONS.SYSTEM_UPGRADE, () => packageManager.upgrade()],
    [OPERATIONS.DOMAIN_STAGE, (payload) => nginxManager.stageDomain(payload)],
    [OPERATIONS.DOMAIN_ACTIVATE, (payload) => nginxManager.activateDomain(payload)],
    [OPERATIONS.SSL_ISSUE, (payload) => acmeManager.issueCertificate(payload)],
    [OPERATIONS.SSL_RENEW, (payload) => acmeManager.renewCertificate(payload)],
    [OPERATIONS.APP_STATIC_DEPLOY, (payload) => staticDeploymentManager.deployStatic(payload)],
    [OPERATIONS.APP_STATIC_ROLLBACK, (payload) => staticRollbackManager.rollbackStatic(payload)],
    [OPERATIONS.APP_NODE_STATUS, (payload) => nodeStatusInspector.inspectNodeStatus(payload)],
  ]);

  if (loadApplicationEnvironment) {
    handlers.set(OPERATIONS.APP_NODE_DEPLOY, (payload) => withApplicationEnvironment(payload, (hydrated) => nodeDeploymentManager.deployNode(hydrated)));
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
