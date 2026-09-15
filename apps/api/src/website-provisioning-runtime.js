import { createWebsiteDnsZoneProvisioningHandler } from './website-dns-zone-provisioning-handler.js';
import { createWebsiteDomainActivationProvisioningHandler } from './website-domain-activation-provisioning-handler.js';
import { createWebsiteNodeReleaseProvisioningHandler } from './website-node-release-provisioning-handler.js';
import { createWebsitePassengerApplicationReleaseProvisioningHandler } from './website-passenger-application-release-provisioning-handler.js';
import { createWebsitePassengerAuthorityProvisioningHandler } from './website-passenger-authority-provisioning-handler.js';
import { createWebsitePassengerEnvironmentProvisioningHandler } from './website-passenger-environment-provisioning-handler.js';
import { createWebsitePassengerEnvironmentStateProvisioningHandler } from './website-passenger-environment-state-provisioning-handler.js';
import { createWebsitePassengerHealthProvisioningHandler } from './website-passenger-health-provisioning-handler.js';
import { createWebsiteProvisioningHandlers } from './website-provisioning-handlers-isolation.js';
import { createWebsiteProvisioningOrchestrator } from './website-provisioning-orchestrator.js';
import { createWebsiteProvisioningRegistry } from './website-provisioning-registry.js';

export function createWebsiteProvisioningRuntime({
  filePath = null,
  now,
  identityManager,
  passengerSiteManager,
  nodeReleaseManager,
  passengerEnvironmentManager,
  passengerHealthInspector,
  staticDeploymentManager,
  nginxManager,
  applicationRegistry = null,
  applicationEnvironmentRegistry = null,
  websiteRegistry = null,
  domainRegistry = null,
  runtimeBindingRegistry = null,
} = {}) {
  const registry = createWebsiteProvisioningRegistry({
    filePath,
    ...(now ? { now } : {}),
  });
  const nodeReleaseHandler = (gitCredentialProvider = null) => createWebsiteNodeReleaseProvisioningHandler({
    ...(nodeReleaseManager ? { nodeReleaseManager } : {}),
    ...(gitCredentialProvider ? { gitCredentialProvider } : {}),
  });
  const handlers = {
    ...createWebsiteProvisioningHandlers({
      ...(identityManager ? { identityManager } : {}),
      ...(passengerSiteManager ? { passengerSiteManager } : {}),
      ...(staticDeploymentManager ? { staticDeploymentManager } : {}),
      ...(nginxManager ? { nginxManager } : {}),
    }),
    dns_zone: createWebsiteDnsZoneProvisioningHandler(),
    node_release: nodeReleaseHandler(),
    passenger_health: createWebsitePassengerHealthProvisioningHandler({
      ...(passengerHealthInspector ? { healthInspector: passengerHealthInspector } : {}),
    }),
  };
  let domainControlPlane = null;
  let passengerEnvironment = null;
  let passengerControlPlane = null;

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

  if (domainRegistry) configureDomainControlPlane({ domainRegistry });
  if (applicationEnvironmentRegistry) configurePassengerEnvironment({ applicationEnvironmentRegistry });
  if (applicationRegistry || websiteRegistry || runtimeBindingRegistry) {
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
    configureDomainControlPlane,
    configurePassengerEnvironment,
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
