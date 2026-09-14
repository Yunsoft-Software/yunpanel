import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';

function hostDependencies() {
  return {
    identityManager: {
      apply: async () => ({}), inspect: async () => ({}), compensate: async () => ({}), inspectCompensation: async () => ({}),
    },
    passengerSiteManager: { apply: async () => ({}), inspect: async () => ({}) },
    nodeReleaseManager: {
      prepare: async () => ({}), inspectDeployment: async () => ({}), compensate: async () => ({}), inspectCompensation: async () => ({}),
    },
    passengerEnvironmentManager: {
      operation: async () => null,
      inspect: async () => ({}),
      apply: async () => ({}),
      inspectCompensation: async () => ({}),
      compensate: async () => ({}),
    },
    staticDeploymentManager: {
      deployStatic: async () => ({}), inspectCurrent: async () => ({}), inspectDeployment: async () => ({}),
      compensateDeployment: async () => ({}), inspectCompensation: async () => ({}),
    },
    nginxManager: {
      stageDomain: async () => ({}), inspectStagedDomain: async () => ({}), inspectActiveDomain: async () => ({}),
      activateDomain: async () => ({}), compensateDomain: async () => ({}), inspectDomainCompensation: async () => ({}),
    },
  };
}

function controlPlaneDependencies() {
  return {
    applicationRegistry: {
      getApplication: async () => null,
      activatePassengerRelease: async () => ({}),
      resetPassengerInitialRelease: async () => ({}),
    },
    applicationEnvironmentRegistry: {
      environmentStatus: async () => ({ savedRevision: 0 }),
      materialize: async () => ({}),
    },
    websiteRegistry: { getWebsite: async () => null },
    domainRegistry: {
      getDomain: async () => null,
      activateProvisionedDomains: async () => [],
      resetProvisionedDomains: async () => [],
    },
    runtimeBindingRegistry: {
      getBinding: async () => null,
      activate: async () => ({}),
      removeOwnedPassenger: async () => null,
    },
  };
}

test('Website provisioning runtime can attach Domain, environment and Passenger control-plane handlers after startup', () => {
  const runtime = createWebsiteProvisioningRuntime(hostDependencies());
  assert.equal(runtime.handlers.domain_activation, undefined);
  assert.equal(runtime.handlers.passenger_environment, undefined);
  assert.equal(runtime.handlers.passenger_application_release, undefined);
  assert.equal(runtime.handlers.passenger_authority, undefined);

  const dependencies = controlPlaneDependencies();
  assert.deepEqual(runtime.configureDomainControlPlane(dependencies), { configured: true });
  assert.deepEqual(runtime.configurePassengerEnvironment(dependencies), { configured: true });
  assert.deepEqual(runtime.configurePassengerControlPlane(dependencies), { configured: true });
  assert.equal(typeof runtime.handlers.domain_activation.apply, 'function');
  assert.equal(typeof runtime.handlers.passenger_environment.apply, 'function');
  assert.equal(typeof runtime.handlers.passenger_application_release.apply, 'function');
  assert.equal(typeof runtime.handlers.passenger_authority.apply, 'function');
  assert.deepEqual(runtime.configurePassengerEnvironment(dependencies), { configured: true });
  assert.deepEqual(runtime.configurePassengerControlPlane(dependencies), { configured: true });

  assert.throws(
    () => runtime.configurePassengerEnvironment({
      applicationEnvironmentRegistry: { environmentStatus: async () => ({ savedRevision: 0 }), materialize: async () => ({}) },
    }),
    /cannot be replaced/,
  );
  assert.throws(
    () => runtime.configurePassengerControlPlane({
      ...dependencies,
      domainRegistry: {
        getDomain: async () => null,
        activateProvisionedDomains: async () => [],
        resetProvisionedDomains: async () => [],
      },
    }),
    /cannot be replaced/,
  );
});
