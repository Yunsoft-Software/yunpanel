import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { jobReconciliationInternals, reconcileCompletedJob } from '../src/job-reconciliation.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const sourceOperationId = 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e';
const stageJobId = '2be5b32f-af61-4b61-b8da-d4a3ecdb6fa4';

const staticTarget = Object.freeze({
  publishRoot: `/var/www/yunpanel/apps/${applicationId}`,
  documentRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
});

function baseBinding(overrides = {}) {
  return {
    applicationId,
    serverId,
    adapter: 'static',
    state: 'active',
    revision: 3,
    sourceOperationId,
    releaseId,
    websiteId,
    websiteRevision: 1,
    domains: [{ domainId, desiredRevision: 1, nginxChecksum: 'a'.repeat(64) }],
    passengerTarget: null,
    staticTarget,
    ...overrides,
  };
}

test('first Static Domain stage creates durable release and checksum authority', async () => {
  const domain = { id: domainId, serverId, websiteId, desiredRevision: 1 };
  const website = {
    id: websiteId,
    serverId,
    runtimeType: 'static',
    applicationId,
    revision: 1,
    documentRoot: staticTarget.documentRoot,
    unixUser: staticTarget.user,
  };
  const application = { id: applicationId, serverId, type: 'static', currentReleaseId: releaseId };
  const job = {
    id: stageJobId,
    serverId,
    resourceId: domainId,
    payload: { targetType: 'static', target: { root: staticTarget.documentRoot } },
    result: { checksum: 'a'.repeat(64) },
  };
  let activation = null;
  await jobReconciliationInternals.reconcileStaticDomainStageBinding({
    job,
    domain,
    applicationRegistry: { getApplication: async () => application },
    websiteRegistry: { getWebsite: async () => website },
    runtimeBindingRegistry: {
      getBinding: async () => null,
      activate: async (input, options) => { activation = { input, options }; },
    },
  });

  assert.equal(activation.options.expectedRevision, 0);
  assert.equal(activation.input.sourceOperationId, stageJobId);
  assert.equal(activation.input.releaseId, releaseId);
  assert.deepEqual(activation.input.staticTarget, staticTarget);
  assert.deepEqual(activation.input.domains, [{
    domainId,
    desiredRevision: 1,
    nginxChecksum: 'a'.repeat(64),
  }]);
});

test('Static Domain restage advances evidence without replacing authority source operation', async () => {
  const domain = {
    id: domainId,
    serverId,
    websiteId,
    desiredRevision: 2,
  };
  const website = {
    id: websiteId,
    serverId,
    runtimeType: 'static',
    applicationId,
    revision: 1,
  };
  const application = {
    id: applicationId,
    serverId,
    type: 'static',
    currentReleaseId: releaseId,
  };
  const binding = baseBinding();
  let activation = null;
  const runtimeBindingRegistry = {
    getBinding: async () => binding,
    activate: async (input, options) => {
      activation = { input, options };
      return { ...input, revision: options.expectedRevision + 1 };
    },
  };
  const job = {
    id: stageJobId,
    serverId,
    resourceId: domainId,
    payload: {
      targetType: 'static',
      target: {
        root: staticTarget.documentRoot,
        spaFallback: true,
      },
    },
    result: { checksum: 'b'.repeat(64) },
  };

  await jobReconciliationInternals.reconcileStaticDomainStageBinding({
    job,
    domain,
    applicationRegistry: { getApplication: async () => application },
    websiteRegistry: { getWebsite: async () => website },
    runtimeBindingRegistry,
  });

  assert.equal(activation.options.expectedRevision, 3);
  assert.equal(activation.input.sourceOperationId, sourceOperationId);
  assert.notEqual(activation.input.sourceOperationId, stageJobId);
  assert.deepEqual(activation.input.domains, [{
    domainId,
    desiredRevision: 2,
    nginxChecksum: 'b'.repeat(64),
  }]);
});

test('Static Domain stage fails closed on target root drift', async () => {
  const domain = {
    id: domainId,
    serverId,
    websiteId,
    desiredRevision: 2,
  };
  const website = {
    id: websiteId,
    serverId,
    runtimeType: 'static',
    applicationId,
    revision: 1,
  };
  const application = {
    id: applicationId,
    serverId,
    type: 'static',
    currentReleaseId: releaseId,
  };
  const binding = baseBinding();
  const job = {
    id: stageJobId,
    serverId,
    resourceId: domainId,
    payload: {
      targetType: 'static',
      target: {
        root: '/var/www/other/current',
      },
    },
    result: { checksum: 'b'.repeat(64) },
  };

  await assert.rejects(
    jobReconciliationInternals.reconcileStaticDomainStageBinding({
      job,
      domain,
      applicationRegistry: { getApplication: async () => application },
      websiteRegistry: { getWebsite: async () => website },
      runtimeBindingRegistry: {
        getBinding: async () => binding,
        activate: async () => {},
      },
    }),
    (error) => error.code === 'static_domain_stage_target_drift',
  );
});

test('reconcileCompletedJob updates static runtime binding on successful deployment', async () => {
  let appState = {
    id: applicationId,
    serverId,
    type: 'static',
    state: 'deploying',
    currentReleaseId: releaseId,
    activeDeploymentId: 'deploy-job-1',
  };
  let bindingState = baseBinding();
  let activation = null;

  const nextReleaseId = '57f8611c-0af7-4d2f-8291-2fe7dbab22ff';
  const deployJob = {
    id: 'deploy-job-1',
    serverId,
    resourceType: 'application',
    resourceId: applicationId,
    operation: OPERATIONS.APP_STATIC_DEPLOY,
    status: 'succeeded',
    payload: { applicationId },
    result: {
      releaseId: nextReleaseId,
      commitSha: 'c'.repeat(40),
      previousReleaseId: releaseId,
    },
  };

  await reconcileCompletedJob({
    applicationRegistry: {
      async getApplication(id) { return id === applicationId ? appState : null; },
      async markDeployed(id, details) {
        appState = {
          ...appState,
          state: 'active',
          currentReleaseId: details.releaseId,
          activeDeploymentId: null,
        };
        return appState;
      },
    },
    runtimeBindingRegistry: {
      async getBinding(id) { return id === applicationId ? bindingState : null; },
      async activate(input, options) {
        activation = { input, options };
        bindingState = { ...input, revision: options.expectedRevision + 1 };
        return bindingState;
      },
    },
    job: deployJob,
  });

  assert.equal(appState.currentReleaseId, nextReleaseId);
  assert.equal(activation.options.expectedRevision, 3);
  assert.equal(activation.input.releaseId, nextReleaseId);
  assert.equal(activation.input.sourceOperationId, 'deploy-job-1');
  assert.equal(bindingState.revision, 4);
});

test('reconcileCompletedJob updates static runtime binding on successful rollback', async () => {
  const rolledBackReleaseId = '57f8611c-0af7-4d2f-8291-2fe7dbab22ff';
  let appState = {
    id: applicationId,
    serverId,
    type: 'static',
    state: 'rolling_back',
    currentReleaseId: releaseId,
    activeDeploymentId: 'rollback-job-1',
  };
  let bindingState = baseBinding();
  let activation = null;

  const rollbackJob = {
    id: 'rollback-job-1',
    serverId,
    resourceType: 'application',
    resourceId: applicationId,
    operation: OPERATIONS.APP_STATIC_ROLLBACK,
    status: 'succeeded',
    payload: { applicationId },
    result: {
      releaseId: rolledBackReleaseId,
      previousReleaseId: releaseId,
    },
  };

  await reconcileCompletedJob({
    applicationRegistry: {
      async getApplication(id) { return id === applicationId ? appState : null; },
      async markRolledBack(id, details) {
        appState = {
          ...appState,
          state: 'active',
          currentReleaseId: details.releaseId,
          activeDeploymentId: null,
        };
        return appState;
      },
    },
    runtimeBindingRegistry: {
      async getBinding(id) { return id === applicationId ? bindingState : null; },
      async activate(input, options) {
        activation = { input, options };
        bindingState = { ...input, revision: options.expectedRevision + 1 };
        return bindingState;
      },
    },
    job: rollbackJob,
  });

  assert.equal(appState.currentReleaseId, rolledBackReleaseId);
  assert.equal(activation.options.expectedRevision, 3);
  assert.equal(activation.input.releaseId, rolledBackReleaseId);
  assert.equal(activation.input.sourceOperationId, 'rollback-job-1');
  assert.equal(bindingState.revision, 4);
});
