import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry } from '../src/job-registry.js';

const serverId = '99bc760a-d508-4ae6-92be-efdedee9658d';

test('system package inspection and upgrade results are strictly sanitized', async () => {
  const registry = createJobRegistry();
  const inspect = await registry.enqueue({
    serverId,
    type: 'system.packages.inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId: serverId,
  });
  await registry.claimNext(serverId);
  const inspected = await registry.complete({
    serverId,
    jobId: inspect.id,
    status: 'succeeded',
    result: {
      packageName: 'yunpanel',
      installed: true,
      installedVersion: '0.1.0-1',
      candidateVersion: '0.2.0-1',
      updateAvailable: true,
      ignored: 'never persisted',
    },
  });
  assert.deepEqual(inspected.result, {
    packageName: 'yunpanel',
    installed: true,
    installedVersion: '0.1.0-1',
    candidateVersion: '0.2.0-1',
    updateAvailable: true,
  });

  const upgrade = await registry.enqueue({
    serverId,
    type: 'system.upgrade',
    operation: OPERATIONS.SYSTEM_UPGRADE,
    payload: {},
    resourceType: 'system',
    resourceId: serverId,
  });
  await registry.claimNext(serverId);
  const upgraded = await registry.complete({
    serverId,
    jobId: upgrade.id,
    status: 'succeeded',
    result: {
      packageName: 'yunpanel',
      installed: true,
      installedVersion: '0.2.0-1',
      candidateVersion: '0.2.0-1',
      updateAvailable: false,
      previousVersion: '0.1.0-1',
      upgraded: true,
      restartScheduled: true,
    },
  });
  assert.equal(upgraded.result.previousVersion, '0.1.0-1');
  assert.equal(upgraded.result.installedVersion, '0.2.0-1');
});

test('system package result rejects inconsistent transitions', async () => {
  const registry = createJobRegistry();
  const job = await registry.enqueue({
    serverId,
    type: 'system.upgrade',
    operation: OPERATIONS.SYSTEM_UPGRADE,
    payload: {},
    resourceType: 'system',
    resourceId: serverId,
  });
  await registry.claimNext(serverId);
  await assert.rejects(
    registry.complete({
      serverId,
      jobId: job.id,
      status: 'succeeded',
      result: {
        packageName: 'yunpanel',
        installed: true,
        installedVersion: '0.1.0-1',
        candidateVersion: '0.2.0-1',
        updateAvailable: true,
        previousVersion: '0.1.0-1',
        upgraded: true,
        restartScheduled: true,
      },
    }),
    /version transition/,
  );
});
