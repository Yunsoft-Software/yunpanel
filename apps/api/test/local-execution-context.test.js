import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';
import { createLocalJobExecutor } from '../src/local-job-executor.js';

const PACKAGE_RESULT = {
  packageName: 'yunpanel',
  installed: false,
  installedVersion: null,
  candidateVersion: null,
  updateAvailable: false,
};

test('local executor passes job identity outside the durable operation payload', async () => {
  const jobRegistry = createJobRegistry();
  const queued = await jobRegistry.enqueue({
    serverId: 'local-server',
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: 'local-server',
  });
  let context = null;
  const executor = createLocalJobExecutor({
    serverId: 'local-server',
    jobRegistry,
    executeOperation: async (operation, payload, execution) => {
      assert.equal(operation, OPERATIONS.SYSTEM_PACKAGES_INSPECT);
      assert.deepEqual(payload, {});
      context = execution;
      return PACKAGE_RESULT;
    },
    reconcileCompletedJob: async () => ({ reconciled: true }),
  });

  await executor.runOnce();
  assert.deepEqual(context, {
    jobId: queued.id,
    serverId: 'local-server',
    resourceType: 'system',
    resourceId: 'local-server',
  });
  assert.deepEqual((await jobRegistry.getJob(queued.id)).result, PACKAGE_RESULT);
});
