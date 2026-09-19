import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationDeployQueue } from '../src/application-deploy-queue.js';

test('Python deploy fails before enqueue when no local release executor exists', async () => {
  let enqueued = false;
  const queue = createApplicationDeployQueue({
    applicationRegistry: {
      getApplication: async () => ({
        id: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
        serverId: '57f8611c-0af7-4d2f-8291-2fe7dbab22fe',
        type: 'python',
        branch: 'main',
        activeDeploymentId: null,
      }),
    },
    applicationEnvironmentRegistry: {},
    jobRegistry: {
      listJobs: async () => [],
      enqueue: async () => { enqueued = true; },
    },
  });

  await assert.rejects(queue({ applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9' }),
    (error) => error.code === 'python_runtime_unavailable' && error.status === 409);
  assert.equal(enqueued, false);
});
