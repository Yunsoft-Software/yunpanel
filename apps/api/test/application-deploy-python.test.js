import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationDeployQueue } from '../src/application-deploy-queue.js';
import { createLocalHostOperations } from '../src/local-host-operations.js';

test('Python deploy successfully enqueues job with environment revision', async () => {
  let enqueuedJob = null;
  const queue = createApplicationDeployQueue({
    applicationRegistry: {
      getApplication: async () => ({
        id: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
        serverId: '57f8611c-0af7-4d2f-8291-2fe7dbab22fe',
        type: 'python',
        repositoryUrl: 'https://github.com/example/python-app.git',
        branch: 'main',
        runtime: { port: 8000, wsgiServer: 'gunicorn', appModule: 'app:app' },
        retention: 5,
        activeDeploymentId: null,
      }),
      markDeploying: async (id, jobId) => ({ id, activeDeploymentId: jobId }),
    },
    applicationEnvironmentRegistry: {
      environmentStatus: async () => ({ savedRevision: 3 }),
    },
    jobRegistry: {
      listJobs: async () => [],
      enqueue: async (job) => {
        enqueuedJob = { id: 'job-python-deploy-1', ...job };
        return enqueuedJob;
      },
    },
  });

  const result = await queue({
    applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
    gitTarget: { kind: 'branch', value: 'main' },
  });

  assert.equal(enqueuedJob.type, 'app.python.deploy');
  assert.equal(enqueuedJob.operation, OPERATIONS.APP_PYTHON_DEPLOY);
  assert.equal(enqueuedJob.payload.applicationId, '9d4a4727-1aba-4d35-95fe-21db67042ce9');
  assert.equal(enqueuedJob.payload.repositoryUrl, 'https://github.com/example/python-app.git');
  assert.equal(enqueuedJob.payload.branch, 'main');
  assert.deepEqual(enqueuedJob.payload.gitTarget, { kind: 'branch', value: 'main' });
  assert.deepEqual(enqueuedJob.payload.runtime, { port: 8000, wsgiServer: 'gunicorn', appModule: 'app:app' });
  assert.equal(enqueuedJob.payload.retention, 5);
  assert.equal(enqueuedJob.payload.environmentRevision, 3);
  assert.equal(result.job.id, 'job-python-deploy-1');
});

test('Python deploy and rollback execute through local-host-operations with environment and git credential', async () => {
  const calls = [];
  const pythonDeploymentManager = {
    deployPython: async (payload, execution) => {
      calls.push(['python.deploy', payload, execution]);
      return { releaseId: payload.deploymentId };
    },
  };
  const pythonRollbackManager = {
    rollbackPython: async (payload) => {
      calls.push(['python.rollback', payload]);
      return { releaseId: payload.releaseId };
    },
  };
  const operations = createLocalHostOperations({
    pythonDeploymentManager,
    pythonRollbackManager,
    loadApplicationEnvironment: async (applicationId, revision) => {
      assert.equal(applicationId, 'python-app-1');
      return { SECRET_KEY: 'super-secret', REVISION: revision };
    },
    loadDeploymentCredential: async (applicationId) => {
      assert.equal(applicationId, 'python-app-1');
      return { type: 'github_token', token: 'github_pat_private_test_value' };
    },
  });

  assert.equal(operations.supports(OPERATIONS.APP_PYTHON_DEPLOY), true);
  assert.equal(operations.supports(OPERATIONS.APP_PYTHON_ROLLBACK), true);

  const deployPayload = {
    applicationId: 'python-app-1',
    deploymentId: 'rel-1',
    runtime: { port: 8000 },
    environmentRevision: 2,
  };
  await operations.executeOperation(OPERATIONS.APP_PYTHON_DEPLOY, deployPayload);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'python.deploy');
  assert.deepEqual(calls[0][1].environment, { SECRET_KEY: 'super-secret', REVISION: 2 });
  assert.deepEqual(calls[0][2], {
    gitCredential: { type: 'github_token', token: 'github_pat_private_test_value' },
  });

  const rollbackPayload = {
    applicationId: 'python-app-1',
    releaseId: 'rel-0',
    currentReleaseId: 'rel-1',
    runtime: { port: 8000 },
    environmentRevision: 1,
  };
  await operations.executeOperation(OPERATIONS.APP_PYTHON_ROLLBACK, rollbackPayload);

  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'python.rollback');
  assert.deepEqual(calls[1][1].environment, { SECRET_KEY: 'super-secret', REVISION: 1 });
});
