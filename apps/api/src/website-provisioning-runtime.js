import { createWebsiteProvisioningHandlers } from './website-provisioning-handlers.js';
import { createWebsiteProvisioningOrchestrator } from './website-provisioning-orchestrator.js';
import { createWebsiteProvisioningRegistry } from './website-provisioning-registry.js';

export function createWebsiteProvisioningRuntime({
  filePath = null,
  now,
  identityManager,
  passengerSiteManager,
  nginxManager,
} = {}) {
  const registry = createWebsiteProvisioningRegistry({
    filePath,
    ...(now ? { now } : {}),
  });
  const handlers = createWebsiteProvisioningHandlers({
    ...(identityManager ? { identityManager } : {}),
    ...(passengerSiteManager ? { passengerSiteManager } : {}),
    ...(nginxManager ? { nginxManager } : {}),
  });
  const orchestrator = createWebsiteProvisioningOrchestrator({ registry, handlers });

  return Object.freeze({
    registry,
    handlers,
    orchestrator,
    init: () => registry.init(),
    get: (operationId) => registry.get(operationId),
    create: (plan) => registry.create(plan),
    runNext: (operationId) => orchestrator.runNext(operationId),
    retryStep: (operationId, stepId) => orchestrator.retryStep(operationId, stepId),
    listInterrupted: () => registry.listInterrupted(),
  });
}
