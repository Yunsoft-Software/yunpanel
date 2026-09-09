import { createAcmeManager, createNginxManager, createNodeStatusInspector, createSystemPackageManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';

export const LOCAL_HOST_OPERATIONS = Object.freeze([
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_UPGRADE,
  OPERATIONS.DOMAIN_STAGE,
  OPERATIONS.DOMAIN_ACTIVATE,
  OPERATIONS.SSL_ISSUE,
  OPERATIONS.SSL_RENEW,
  OPERATIONS.APP_NODE_STATUS,
]);

export function createLocalHostOperations({
  packageManager = createSystemPackageManager({
    restartUnits: ['yunpanel-api.service', 'yunpanel-web.service'],
  }),
  nginxManager = createNginxManager(),
  acmeManager = createAcmeManager(),
  nodeStatusInspector = createNodeStatusInspector(),
} = {}) {
  const handlers = new Map([
    [OPERATIONS.SYSTEM_PACKAGES_INSPECT, () => packageManager.inspect()],
    [OPERATIONS.SYSTEM_UPGRADE, () => packageManager.upgrade()],
    [OPERATIONS.DOMAIN_STAGE, (payload) => nginxManager.stageDomain(payload)],
    [OPERATIONS.DOMAIN_ACTIVATE, (payload) => nginxManager.activateDomain(payload)],
    [OPERATIONS.SSL_ISSUE, (payload) => acmeManager.issueCertificate(payload)],
    [OPERATIONS.SSL_RENEW, (payload) => acmeManager.renewCertificate(payload)],
    [OPERATIONS.APP_NODE_STATUS, (payload) => nodeStatusInspector.inspectNodeStatus(payload)],
  ]);

  return {
    operations: [...LOCAL_HOST_OPERATIONS],
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
