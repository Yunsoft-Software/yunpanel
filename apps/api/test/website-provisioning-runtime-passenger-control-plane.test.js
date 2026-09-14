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
    websiteRegistry: { getWebsite: async () => null },
    domainRegistry: { getDomain: async () => null },
    runtimeBindingRegistry: {
      getBinding: async () => null,
      activate: async () => ({}),
      removeOwnedPassenger: async () => null,
    },
  };
}

test('Website provisioning runtime can attach Passenger control-plane handlers after startup', () => {
  const runtime = createWebsiteProvisioningRuntime(hostDependencies());
  assert.equal(runtime.handlers.passenger_application_release, undefined);
  assert.equal(runtime.handlers.passenger_authority, undefined);

  const dependencies = controlPlaneDependencies();
  assert.deepEqual(runtime.configurePassengerControlPlane(dependencies), { configured: true });
  assert.equal(typeof runtime.handlers.passenger_application_release.apply, 'function');
  assert.equal(typeof runtime.handlers.passenger_authority.apply, 'function');
  assert.deepEqual(runtime.configurePassengerControlPlane(dependencies), { configured: true });

  assert.throws(
    () => runtime.configurePassengerControlPlane({ ...dependencies, domainRegistry: { getDomain: async () => null } }),
    /cannot be replaced/,
  );
});
