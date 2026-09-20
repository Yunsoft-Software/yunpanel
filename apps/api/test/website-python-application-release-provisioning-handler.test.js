import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createWebsitePythonApplicationReleaseProvisioningHandler } from '../src/website-python-application-release-provisioning-handler.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';

async function fixture() {
  const applicationRegistry = createApplicationRegistry({ serverExists: async () => true });
  const application = await applicationRegistry.createPythonApplication({
    applicationId,
    serverId: '57f8611c-0af7-4d2f-8291-2fe7dbab22fe',
    name: 'Native Python',
    repositoryUrl: 'https://github.com/example/native-python',
    branch: 'main',
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'wsgi:application',
      workers: 2,
    },
  });
  const handler = createWebsitePythonApplicationReleaseProvisioningHandler({ applicationRegistry });
  const operation = {
    operationId,
    websiteId: '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75',
    resources: {
      application: {
        id: application.id,
        type: 'python',
        runtime: application.runtime,
      },
    },
    steps: [{
      id: 'python_release',
      state: 'succeeded',
      evidence: {
        satisfied: true,
        adapter: 'python-release',
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
      adapter: 'python-application-release',
      applicationId,
      releaseId: operationId,
    },
    evidence: null,
  };
  return { applicationRegistry, handler, context };
}

test('Python Application release handler finalizes and retries', async () => {
  const { applicationRegistry, handler, context } = await fixture();
  const before = await handler.inspect(context);
  assert.equal(before.satisfied, false);
  assert.equal(before.reason, 'website_python_application_release_pending');

  const applied = await handler.apply(context);
  assert.equal(applied.satisfied, true);
  assert.equal(applied.releaseId, operationId);

  const application = await applicationRegistry.getApplication(applicationId);
  assert.equal(application.currentReleaseId, operationId);
  assert.equal(application.currentCommitSha, 'a'.repeat(40));
  assert.match(application.serviceName, /^yunpanel-python-[0-9a-f]{16}\.service$/);
  assert.match(application.socketPath, /^\/run\/yunpanel\/python-[0-9a-f-]{36}\.sock$/);

  assert.deepEqual(await handler.apply(context), applied);
  assert.equal((await handler.inspect(context)).satisfied, true);
});

test('Python Application release compensation resets only the initial operation-owned release', async () => {
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
