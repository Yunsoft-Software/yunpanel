import { databaseManager, inspectHostInventory, inventoryInternals, managedServiceManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { acmeManager } from './acme-manager.js';
import { inspectDocker } from './docker-inspector.js';
import { inspectNginx } from './nginx-inspector.js';
import { nginxManager } from './nginx-manager.js';
import { nodeDeploymentManager } from './node-deployment-manager.js';
import { nodeRestartManager } from './node-restart-manager.js';
import { nodeProcessManager } from './node-process-manager.js';
import { nodeRuntimeManager } from './node-runtime-manager.js';
import { nodeRollbackManager } from './node-rollback-manager.js';
import { nodeStatusInspector } from './node-status-inspector.js';
import { staticDeploymentManager } from './static-deployment-manager.js';
import { staticRollbackManager } from './static-rollback-manager.js';
import { systemPackageManager } from './system-package-manager.js';
import { inspectAllowlistedServices } from './systemd-inspector.js';

export const operationHandlers = Object.freeze({
  [OPERATIONS.SERVER_INSPECT]: () => inspectHostInventory({ mode: process.env.YUN_AGENT_MODE ?? 'protected' }),
  [OPERATIONS.SERVER_SERVICES]: inspectAllowlistedServices,
  [OPERATIONS.SERVER_DOCKER]: inspectDocker,
  [OPERATIONS.SERVER_NGINX]: inspectNginx,
  [OPERATIONS.SYSTEM_PACKAGES_INSPECT]: () => systemPackageManager.inspect(),
  [OPERATIONS.SYSTEM_SERVICES_INSPECT]: (payload) => managedServiceManager.inspect(payload.serviceId ?? null),
  [OPERATIONS.SYSTEM_SERVICE_INSTALL]: (payload) => managedServiceManager.install(payload.serviceId),
  [OPERATIONS.SYSTEM_SERVICE_CONTROL]: (payload) => managedServiceManager.control(payload.serviceId, payload.action),
  [OPERATIONS.SYSTEM_UPGRADE]: () => systemPackageManager.upgrade(),
  [OPERATIONS.DATABASE_INSPECT]: () => databaseManager.inspect(),
  [OPERATIONS.DATABASE_CREATE]: (payload) => databaseManager.createDatabase(payload.name),
  [OPERATIONS.DATABASE_DELETE]: (payload) => databaseManager.dropDatabase(payload.name),
  [OPERATIONS.DOMAIN_STAGE]: (payload) => nginxManager.stageDomain(payload),
  [OPERATIONS.DOMAIN_ACTIVATE]: (payload) => nginxManager.activateDomain(payload),
  [OPERATIONS.SSL_ISSUE]: (payload) => acmeManager.issueCertificate(payload),
  [OPERATIONS.SSL_RENEW]: (payload) => acmeManager.renewCertificate(payload),
  [OPERATIONS.APP_STATIC_DEPLOY]: (payload) => {
    const { gitCredential = null, ...jobPayload } = payload;
    return staticDeploymentManager.deployStatic(jobPayload, { gitCredential });
  },
  [OPERATIONS.APP_STATIC_ROLLBACK]: (payload) => staticRollbackManager.rollbackStatic(payload),
  [OPERATIONS.APP_NODE_DEPLOY]: (payload) => {
    const { gitCredential = null, ...jobPayload } = payload;
    return nodeDeploymentManager.deployNode(jobPayload, { gitCredential });
  },
  [OPERATIONS.APP_NODE_ROLLBACK]: (payload) => nodeRollbackManager.rollbackNode(payload),
  [OPERATIONS.APP_NODE_RESTART]: (payload) => nodeRestartManager.restartNode(payload),
  [OPERATIONS.APP_NODE_STATUS]: (payload) => nodeStatusInspector.inspectNodeStatus(payload),
  [OPERATIONS.APP_NODE_PROCESS]: (payload) => nodeProcessManager.controlNodeProcess(payload),
  [OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT]: () => nodeRuntimeManager.inspect(),
  [OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL]: (payload) => nodeRuntimeManager.install(payload.major),
});

export async function executeOperation(operation, payload) {
  const handler = operationHandlers[operation];
  if (!handler) {
    const error = new Error('Operation handler is not available');
    error.code = 'operation_unavailable';
    throw error;
  }
  return handler(payload);
}

export { inventoryInternals };
