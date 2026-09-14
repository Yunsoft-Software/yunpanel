import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createWebsitePassengerApplicationReleaseProvisioningHandler } from '../src/website-passenger-application-release-provisioning-handler.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';

async function fixture() {
  const applicationRegistry = createApplicationRegistry({ serverExists: async () => true });
  const application = await applicationRegistry.createNodeApplication({
    applicationId,
    serverId: '57f8611c-0af7-4d2f-8291-2fe7dbab22fe',
    name: 'Native Passenger',
    repositoryUrl: 'https://github.com/example/native-passenger',
    branch: 'main',
    runtimeAdapter: 'passenger',
    runtime: { nodeMajor: 24, entryFile: 'dist/server.js' },
  });
  const handler = createWebsitePassengerApplicationReleaseProvisioningHandler({ applicationRegistry });
  const operation = {
    operationId,
    websiteId: '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75',
    resources: {
      application: {
        id: application.id,
        type: 'node',
        runtimeAdapter: 'passenger',
        runtime: application.runtime,
      },
    },
    steps: [{
      id: 'node_release',
      state: 'succeeded',
      evidence: {
        satisfied: true,
        adapter: 'passenger-release',
        applicationId,
        deploymentId: operationId,
        releaseId: operationId,
        previousReleaseId: null,
        commitSha: 'a'.repeat(40),
      },
    }],
  };
  const context = {
    operation,
    operationId,
    websiteId: operation.websiteId,
    intent: {
      adapter: 'passenger-application-release',
      applicationId,
      releaseId: operationId,
    },
    evidence: null,
  };
  return { applicationRegistry, handler, context };
}

test('Passenger Application release handler finalizes and retries without systemd state', async () => {
  const { applicationRegistry, handler, context } = await fixture();
  const before = await handler.inspect(context);
  assert.equal(before.satisfied, false);
  assert.equal(before.reason, 'website_passenger_application_release_pending');

  const applied = await handler.apply(context);
  assert.equal(applied.satisfied, true);
  assert.equal(applied.releaseId, operationId);

  const application = await applicationRegistry.getApplication(applicationId);
  assert.equal(application.currentReleaseId, operationId);
  assert.equal(application.currentCommitSha, 'a'.repeat(40));
  assert.equal(application.serviceName, null);
  assert.equal(application.servicePort, null);
  assert.equal(application.proxyTarget, null);

  assert.deepEqual(await handler.apply(context), applied);
  assert.equal((await handler.inspect(context)).satisfied, true);
});

test('Passenger Application release compensation resets only the initial operation-owned release', async () => {
  const { applicationRegistry, handler, context } = await fixture();
  const applied = await handler.apply(context);
  const compensationContext = { ...context, evidence: applied };

  assert.equal((await handler.inspectCompensation(compensationContext)).satisfied, false);
  const compensated = await handler.compensate(compensationContext);
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.reset, true);

  const application = await applicationRegistry.getApplication(applicationId);
  assert.equal(application.currentReleaseId, null);
  assert.equal(application.releases.length, 0);
  assert.equal((await handler.compensate(compensationContext)).satisfied, true);
});
