import { createWebsiteNodeReleaseProvisioningHandler } from './website-node-release-provisioning-handler.js';
import { createWebsitePassengerApplicationReleaseProvisioningHandler } from './website-passenger-application-release-provisioning-handler.js';
import { createWebsitePassengerAuthorityProvisioningHandler } from './website-passenger-authority-provisioning-handler.js';
import { createWebsiteProvisioningHandlers } from './website-provisioning-handlers.js';
import { createWebsiteProvisioningOrchestrator } from './website-provisioning-orchestrator.js';
import { createWebsiteProvisioningRegistry } from './website-provisioning-registry.js';

export function createWebsiteProvisioningRuntime({
  filePath = null,
  now,
  identityManager,
  passengerSiteManager,
  nodeReleaseManager,
  staticDeploymentManager,
  nginxManager,
  applicationRegistry = null,
  websiteRegistry = null,
  domainRegistry = null,
  runtimeBindingRegistry = null,
} = {}) {
  const registry = createWebsiteProvisioningRegistry({
    filePath,
    ...(now ? { now } : {}),
  });
  const passengerControlPlaneReady = Boolean(
    applicationRegistry && websiteRegistry && domainRegistry && runtimeBindingRegistry,
  );
  const handlers = Object.freeze({
    ...createWebsiteProvisioningHandlers({
      ...(identityManager ? { identityManager } : {}),
      ...(passengerSiteManager ? { passengerSiteManager } : {}),
      ...(staticDeploymentManager ? { staticDeploymentManager } : {}),
      ...(nginxManager ? { nginxManager } : {}),
    }),
    node_release: createWebsiteNodeReleaseProvisioningHandler({
      ...(nodeReleaseManager ? { nodeReleaseManager } : {}),
    }),
    ...(applicationRegistry ? {
      passenger_application_release: createWebsitePassengerApplicationReleaseProvisioningHandler({ applicationRegistry }),
    } : {}),
    ...(passengerControlPlaneReady ? {
      passenger_authority: createWebsitePassengerAuthorityProvisioningHandler({
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        runtimeBindingRegistry,
      }),
    } : {}),
  });
  const orchestrator = createWebsiteProvisioningOrchestrator({ registry, handlers });

  async function init() {
    await registry.init();
    const interrupted = await registry.listInterrupted();
    const reconciled = [];
    for (const operation of interrupted) {
      // listInterrupted only returns applying/compensating operations. runNext therefore
      // takes the inspect-first reconciliation path and never starts a new pending host mutation.
      reconciled.push(await orchestrator.runNext(operation.operationId));
    }
    return Object.freeze(reconciled);
  }

  return Object.freeze({
    registry,
    handlers,
    orchestrator,
    init,
    get: (operationId) => registry.get(operationId),
    create: (plan) => registry.create(plan),
    runNext: (operationId) => orchestrator.runNext(operationId),
    retryStep: (operationId, stepId) => orchestrator.retryStep(operationId, stepId),
    compensateStep: (operationId, stepId) => orchestrator.compensateStep(operationId, stepId),
    listInterrupted: () => registry.listInterrupted(),
  });
}
