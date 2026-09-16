import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const previousReleaseId = '3854e385-adfc-42bd-bccf-f655f24cd68f';

const intent = Object.freeze({
  adapter: 'static',
  mode: 'deploy',
  websiteId,
  runtimeType: 'static',
  applicationId,
  deploymentId: operationId,
  homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
  buildRoot: `/var/lib/yunpanel/build/${applicationId}`,
  publishRoot: `/var/www/yunpanel/apps/${applicationId}`,
  repositoryUrl: 'https://github.com/example/static-app.git',
  branch: 'main',
  build: Object.freeze({
    mode: 'none',
    installMode: null,
    buildScript: null,
    outputDir: '.',
    healthFile: 'index.html',
  }),
  retention: 5,
});

function plan() {
  return {
    operationId,
    websiteId,
    steps: [{
      id: 'runtime',
      kind: 'static_runtime',
      state: 'pending',
      intent,
      compensation: { state: 'pending' },
    }],
  };
}

function identityManager() {
  return {
    inspect: async () => ({ satisfied: false }),
    apply: async () => ({ satisfied: false }),
    compensate: async () => ({ satisfied: false }),
    inspectCompensation: async () => ({ satisfied: false }),
  };
}

function passengerSiteManager() {
  return {
    inspect: async () => ({ satisfied: false }),
    apply: async () => ({ satisfied: false }),
  };
}

function nginxManager() {
  return {
    stageDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64) }),
    inspectStagedDomain: async () => ({ satisfied: false, result: null }),
    inspectActiveDomain: async () => ({ satisfied: false, result: null }),
    activateDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64), active: true }),
    compensateDomain: async () => ({ satisfied: true }),
    inspectDomainCompensation: async () => ({ satisfied: true }),
  };
}

function completeStaticManager(overrides = {}) {
  return {
    deployStatic: async () => { throw new Error('unused'); },
    inspectCurrent: async () => ({ satisfied: false }),
    inspectDeployment: async () => ({ satisfied: false }),
    compensateDeployment: async () => ({ satisfied: false, reason: 'unused' }),
    inspectCompensation: async () => ({ satisfied: false, reason: 'unused' }),
    ...overrides,
  };
}

function staticPublishIsolationManager() {
  return {
    apply: async () => ({
      satisfied: true,
      adapter: 'static-publish-isolation',
      releaseCount: 1,
      currentRelease: `/var/www/yunpanel/apps/${applicationId}/current`,
    }),
    inspect: async () => ({
      satisfied: true,
      adapter: 'static-publish-isolation',
      releaseCount: 1,
      currentRelease: `/var/www/yunpanel/apps/${applicationId}/current`,
    }),
  };
}

function runtime(filePath, staticDeploymentManager) {
  return createWebsiteProvisioningRuntime({
    filePath,
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    staticDeploymentManager: completeStaticManager(staticDeploymentManager),
    staticPublishIsolationManager: staticPublishIsolationManager(),
    nginxManager: nginxManager(),
  });
}

function appliedEvidence() {
  return Object.freeze({
    satisfied: true,
    adapter: 'static',
    applicationId,
    releaseId: operationId,
    deploymentId: operationId,
    previousReleaseId,
    currentRelease: `/var/www/yunpanel/apps/${applicationId}/current`,
    unixUser: 'yunapp-4dc352e64a14',
    homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
  });
}

test('startup reconciles interrupted static deployment by inspection without redeploying', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-static-provisioning-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');

  const beforeRestart = runtime(filePath);
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.registry.beginStep({ operationId, stepId: 'runtime' });

  let inspectCalls = 0;
  let deployCalls = 0;
  const afterRestart = runtime(filePath, {
    inspectDeployment: async (spec) => {
      inspectCalls += 1;
      assert.equal(spec.applicationId, applicationId);
      assert.equal(spec.deploymentId, operationId);
      return appliedEvidence();
    },
    deployStatic: async () => {
      deployCalls += 1;
      throw new Error('restart reconcile must not redeploy');
    },
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'ready');
  assert.equal(inspectCalls, 1);
  assert.equal(deployCalls, 0);
  assert.equal(restored.ready, true);
  assert.equal(restored.steps[0].state, 'succeeded');
  assert.equal(restored.steps[0].evidence.releaseId, operationId);
  assert.deepEqual(await afterRestart.listInterrupted(), []);
});

test('startup reconciles interrupted static compensation by inspection without rolling back twice', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-static-compensation-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');

  const beforeRestart = runtime(filePath);
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.registry.beginStep({ operationId, stepId: 'runtime' });
  await beforeRestart.registry.completeStep({
    operationId,
    stepId: 'runtime',
    evidence: appliedEvidence(),
  });
  await beforeRestart.registry.beginCompensation({ operationId, stepId: 'runtime' });

  let inspectCalls = 0;
  let compensateCalls = 0;
  const afterRestart = runtime(filePath, {
    inspectCompensation: async (target) => {
      inspectCalls += 1;
      assert.deepEqual(target, { applicationId, deploymentId: operationId, previousReleaseId });
      return {
        satisfied: true,
        adapter: 'static',
        ...target,
        releaseId: previousReleaseId,
        restoredPrevious: true,
      };
    },
    compensateDeployment: async () => {
      compensateCalls += 1;
      throw new Error('restart reconcile must not repeat rollback');
    },
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'compensated');
  assert.equal(inspectCalls, 1);
  assert.equal(compensateCalls, 0);
  assert.equal(restored.steps[0].state, 'compensated');
  assert.equal(restored.steps[0].compensation.state, 'succeeded');
  assert.equal(restored.steps[0].compensation.evidence.releaseId, previousReleaseId);
  assert.deepEqual(await afterRestart.listInterrupted(), []);
});
