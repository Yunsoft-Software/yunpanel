import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteProvisioningHandlers,
  WebsiteProvisioningHandlerError,
} from '../src/website-provisioning-handlers.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';

const deployIntent = Object.freeze({
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

function identityManager() {
  return {
    apply: async () => ({ satisfied: true }),
    inspect: async () => ({ satisfied: true }),
    compensate: async () => ({ satisfied: true }),
    inspectCompensation: async () => ({ satisfied: true }),
  };
}

function passengerSiteManager() {
  return {
    apply: async () => ({ satisfied: true, adapter: 'passenger' }),
    inspect: async () => ({ satisfied: true, adapter: 'passenger' }),
  };
}

function nginxManager() {
  return {
    stageDomain: async () => ({ configName: 'example.conf', checksum: 'a'.repeat(64) }),
    inspectStagedDomain: async () => ({ satisfied: false, result: null }),
    inspectActiveDomain: async () => ({ satisfied: false, result: null }),
    activateDomain: async () => ({ configName: 'example.conf', checksum: 'a'.repeat(64), active: true }),
    compensateDomain: async () => ({ satisfied: true }),
    inspectDomainCompensation: async () => ({ satisfied: true }),
  };
}

function handlers(staticDeploymentManager) {
  return createWebsiteProvisioningHandlers({
    identityManager: identityManager(),
    passengerSiteManager: passengerSiteManager(),
    staticDeploymentManager,
    nginxManager: nginxManager(),
  });
}

function activeEvidence(releaseId = operationId) {
  return Object.freeze({
    satisfied: true,
    adapter: 'static',
    applicationId,
    releaseId,
    deploymentId: operationId,
    currentRelease: `/var/www/yunpanel/apps/${applicationId}/current`,
    unixUser: 'yunapp-0123456789ab',
    homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
  });
}

test('static Website apply reconciles an already-current deterministic release without redeploying', async () => {
  let deployCalls = 0;
  const seen = [];
  const runtime = handlers({
    deployStatic: async () => { deployCalls += 1; return {}; },
    inspectCurrent: async () => ({ satisfied: false }),
    inspectDeployment: async (spec) => { seen.push(spec); return activeEvidence(); },
  });

  const result = await runtime.runtime.apply({ intent: deployIntent, operationId, websiteId });
  assert.equal(result.satisfied, true);
  assert.equal(result.releaseId, operationId);
  assert.equal(deployCalls, 0);
  assert.deepEqual(seen, [{
    applicationId,
    deploymentId: operationId,
    repositoryUrl: deployIntent.repositoryUrl,
    branch: 'main',
    build: deployIntent.build,
    retention: 5,
  }]);
});

test('static Website apply deploys once then verifies the deterministic current release', async () => {
  const calls = [];
  let inspections = 0;
  const runtime = handlers({
    inspectCurrent: async () => ({ satisfied: false }),
    inspectDeployment: async (spec) => {
      calls.push(['inspect', spec.deploymentId]);
      inspections += 1;
      return inspections === 1
        ? { satisfied: false, reason: 'website_static_current_missing', applicationId }
        : activeEvidence();
    },
    deployStatic: async (spec) => {
      calls.push(['deploy', spec.deploymentId]);
      return {
        deploymentId: spec.deploymentId,
        releaseId: spec.deploymentId,
        commitSha: 'a'.repeat(40),
        previousReleaseId: null,
        artifactFiles: 4,
        artifactBytes: 1024,
      };
    },
  });

  const result = await runtime.runtime.apply({ intent: deployIntent, operationId, websiteId });
  assert.deepEqual(calls, [
    ['inspect', operationId],
    ['deploy', operationId],
    ['inspect', operationId],
  ]);
  assert.equal(result.satisfied, true);
  assert.equal(result.commitSha, 'a'.repeat(40));
  assert.equal(result.artifactFiles, 4);
  assert.equal(result.artifactBytes, 1024);
});

test('static Website inspect never mutates and returns deployment inspection directly', async () => {
  let deployCalls = 0;
  const runtime = handlers({
    inspectCurrent: async () => ({ satisfied: false }),
    inspectDeployment: async () => activeEvidence(),
    deployStatic: async () => { deployCalls += 1; return {}; },
  });

  const result = await runtime.runtime.inspect({ intent: deployIntent, operationId, websiteId });
  assert.equal(result.satisfied, true);
  assert.equal(result.releaseId, operationId);
  assert.equal(deployCalls, 0);
});

test('existing static Application binding inspects current release without redeploying', async () => {
  const calls = [];
  const intent = Object.freeze({
    adapter: 'static',
    mode: 'bind_existing',
    websiteId,
    runtimeType: 'static',
    applicationId,
    homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
    buildRoot: `/var/lib/yunpanel/build/${applicationId}`,
    publishRoot: `/var/www/yunpanel/apps/${applicationId}`,
  });
  const runtime = handlers({
    inspectCurrent: async (input) => { calls.push(['current', input]); return activeEvidence('3854e385-adfc-42bd-bccf-f655f24cd68f'); },
    inspectDeployment: async () => { throw new Error('unexpected deployment inspection'); },
    deployStatic: async () => { throw new Error('unexpected redeploy'); },
  });

  const applied = await runtime.runtime.apply({ intent, operationId, websiteId });
  const inspected = await runtime.runtime.inspect({ intent, operationId, websiteId });
  assert.equal(applied.satisfied, true);
  assert.equal(inspected.satisfied, true);
  assert.deepEqual(calls, [
    ['current', { applicationId }],
    ['current', { applicationId }],
  ]);
});

test('static Website deployment intent is operation and Website bound before any host mutation', async () => {
  let calls = 0;
  const runtime = handlers({
    inspectCurrent: async () => { calls += 1; return {}; },
    inspectDeployment: async () => { calls += 1; return {}; },
    deployStatic: async () => { calls += 1; return {}; },
  });

  await assert.rejects(
    runtime.runtime.apply({ intent: deployIntent, operationId: '3854e385-adfc-42bd-bccf-f655f24cd68f', websiteId }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_static_runtime_intent_invalid',
  );
  await assert.rejects(
    runtime.runtime.apply({ intent: deployIntent, operationId, websiteId: '3854e385-adfc-42bd-bccf-f655f24cd68f' }),
    (error) => error instanceof WebsiteProvisioningHandlerError
      && error.code === 'website_static_runtime_intent_invalid',
  );
  assert.equal(calls, 0);
});
