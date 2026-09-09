import { createSystemPackageManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';

export const LOCAL_HOST_OPERATIONS = Object.freeze([
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_UPGRADE,
]);

export function createLocalHostOperations({
  packageManager = createSystemPackageManager({
    restartUnits: ['yunpanel-api.service', 'yunpanel-web.service'],
  }),
} = {}) {
  const handlers = new Map([
    [OPERATIONS.SYSTEM_PACKAGES_INSPECT, () => packageManager.inspect()],
    [OPERATIONS.SYSTEM_UPGRADE, () => packageManager.upgrade()],
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
