import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

function inventory(overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'x64',
    supportedMajors: [22, 24],
    panelRuntime: { path: '/usr/local/bin/node', source: 'panel', version: 'v24.18.1', major: 24 },
    systemRuntime: { path: '/usr/bin/node', source: 'system', version: 'v22.23.2', major: 22 },
    managedRuntimes: [
      { major: 22, installed: false, path: '/opt/yunpanel/node-runtimes/v22/bin/node', version: null, packageManagers: [] },
      { major: 24, installed: true, path: '/opt/yunpanel/node-runtimes/v24/bin/node', version: 'v24.21.0', packageManagers: ['npm', 'pnpm', 'yarn'] },
    ],
    ...overrides,
  };
}

async function queue(registry, operation, payload = {}) {
  return registry.enqueue({
    serverId: 'server-1', type: operation, operation, payload, resourceType: 'system', resourceId: 'server-1',
  });
}

test('Node runtime inspection persists only bounded executable inventory', async () => {
  const registry = createJobRegistry();
  const job = await queue(registry, OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT);
  await registry.claimNext('server-1');
  const completed = await registry.complete({
    serverId: 'server-1', jobId: job.id, status: 'succeeded', result: { ...inventory(), raw: 'discard me' },
  });
  assert.deepEqual(completed.result, inventory());
});

test('Node runtime install requires exact requested major and matching post-install inventory', async () => {
  const registry = createJobRegistry();
  const job = await queue(registry, OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, { major: 24 });
  await registry.claimNext('server-1');
  const result = {
    changed: true,
    runtime: {
      path: '/opt/yunpanel/node-runtimes/v24/bin/node', source: 'managed', version: 'v24.21.0', major: 24,
      packageManagers: ['npm', 'pnpm', 'yarn'],
    },
    inventory: inventory(),
    stdout: 'discard me',
  };
  const completed = await registry.complete({ serverId: 'server-1', jobId: job.id, status: 'succeeded', result });
  assert.equal(completed.result.runtime.major, 24);
  assert.equal(Object.hasOwn(completed.result, 'stdout'), false);

  const forgedRegistry = createJobRegistry();
  const forgedJob = await queue(forgedRegistry, OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, { major: 24 });
  await forgedRegistry.claimNext('server-1');
  await assert.rejects(
    forgedRegistry.complete({
      serverId: 'server-1', jobId: forgedJob.id, status: 'succeeded',
      result: { ...result, runtime: { ...result.runtime, path: '/usr/local/bin/node' } },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );
});

test('Node runtime inventory rejects path, version, major and package-manager forgery', async () => {
  for (const forged of [
    inventory({ panelRuntime: { path: '/tmp/node', source: 'panel', version: 'v24.18.1', major: 24 } }),
    inventory({ supportedMajors: [24, 22] }),
    inventory({ managedRuntimes: [
      { major: 22, installed: false, path: '/opt/yunpanel/node-runtimes/v22/bin/node', version: null, packageManagers: [] },
      { major: 24, installed: true, path: '/opt/yunpanel/node-runtimes/v24/bin/node', version: 'v22.23.2', packageManagers: ['npm'] },
    ] }),
  ]) {
    const registry = createJobRegistry();
    const job = await queue(registry, OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT);
    await registry.claimNext('server-1');
    await assert.rejects(
      registry.complete({ serverId: 'server-1', jobId: job.id, status: 'succeeded', result: forged }),
      (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
    );
  }
});
