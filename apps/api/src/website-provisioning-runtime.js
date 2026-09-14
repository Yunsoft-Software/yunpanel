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
  const handlers = {
    ...createWebsiteProvisioningHandlers({
      ...(identityManager ? { identityManager } : {}),
      ...(passengerSiteManager ? { passengerSiteManager } : {}),
      ...(staticDeploymentManager ? { staticDeploymentManager } : {}),
      ...(nginxManager ? { nginxManager } : {}),
    }),
    node_release: createWebsiteNodeReleaseProvisioningHandler({
      ...(nodeReleaseManager ? { nodeReleaseManager } : {}),
    }),
  };
  let passengerControlPlane = null;

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
    if (passengerControlPlane) {
      if (passengerControlPlane.applicationRegistry !== nextApplicationRegistry
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
    handlers.passenger_authority = createWebsitePassengerAuthorityProvisioningHandler({
      applicationRegistry: nextApplicationRegistry,
      websiteRegistry: nextWebsiteRegistry,
      domainRegistry: nextDomainRegistry,
      runtimeBindingRegistry: nextRuntimeBindingRegistry,
    });
    passengerControlPlane = Object.freeze({
      applicationRegistry: nextApplicationRegistry,
      websiteRegistry: nextWebsiteRegistry,
      domainRegistry: nextDomainRegistry,
      runtimeBindingRegistry: nextRuntimeBindingRegistry,
    });
    return Object.freeze({ configured: true });
  }

  if (applicationRegistry || websiteRegistry || domainRegistry || runtimeBindingRegistry) {
    configurePassengerControlPlane({ applicationRegistry, websiteRegistry, domainRegistry, runtimeBindingRegistry });
  }

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
    configurePassengerControlPlane,
    init,
    get: (operationId) => registry.get(operationId),
    create: (plan) => registry.create(plan),
    runNext: (operationId) => orchestrator.runNext(operationId),
    retryStep: (operationId, stepId) => orchestrator.retryStep(operationId, stepId),
    compensateStep: (operationId, stepId) => orchestrator.compensateStep(operationId, stepId),
    listInterrupted: () => registry.listInterrupted(),
  });
}
