import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

function runtime() {
  return {
    nodeMajor: 24,
    packageManager: 'npm',
    installMode: 'ci',
    buildScript: null,
    mode: 'production',
    documentRoot: '.',
    start: { mode: 'node', entryFile: 'server.js', script: null },
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 30,
    restartPolicy: 'on-failure',
  };
}

function serviceName() {
  const digest = createHash('sha256').update(applicationId).digest('hex').slice(0, 16);
  return `yunpanel-node-${digest}.service`;
}

async function queue(registry, action) {
  return registry.enqueue({
    serverId: 'server-1',
    type: 'app.node.process',
    operation: OPERATIONS.APP_NODE_PROCESS,
    payload: { applicationId, releaseId, runtime: runtime(), action },
    resourceType: 'application',
    resourceId: applicationId,
  });
}

function result(action, overrides = {}) {
  const active = action === 'start' || action === 'disable';
  const enabled = action !== 'disable';
  return {
    releaseId,
    serviceName: serviceName(),
    port: 3100,
    healthPath: '/health',
    action,
    loadState: 'loaded',
    activeState: active ? 'active' : 'inactive',
    subState: active ? 'running' : 'dead',
    unitFileState: enabled ? 'enabled' : 'disabled',
    mainPid: active ? 42 : 0,
    enabled,
    active,
    healthy: active,
    ignoredOutput: 'never persisted',
    ...overrides,
  };
}

test('Node process jobs persist only the bounded verified state for every action', async () => {
  for (const action of ['enable', 'disable', 'start', 'stop']) {
    const registry = createJobRegistry();
    const job = await queue(registry, action);
    const claimed = await registry.claimNext('server-1');
    assert.equal(claimed.envelope.operation, OPERATIONS.APP_NODE_PROCESS);
    assert.equal(claimed.envelope.payload.action, action);
    const completed = await registry.complete({
      serverId: 'server-1', jobId: job.id, status: 'succeeded', result: result(action),
    });
    assert.equal(completed.result.action, action);
    assert.equal(completed.result.serviceName, serviceName());
    assert.equal(Object.hasOwn(completed.result, 'ignoredOutput'), false);
  }
});

test('Node process jobs reject forged identity and state evidence', async () => {
  for (const [action, forged] of [
    ['start', result('start', { releaseId: 'ff830043-9752-4640-83b4-3a1998de78a0' })],
    ['start', result('start', { action: 'stop' })],
    ['start', result('start', { active: false })],
    ['start', result('start', { loadState: 'masked' })],
    ['start', result('start', { healthy: false })],
    ['stop', result('stop', { activeState: 'failed' })],
    ['disable', result('disable', { unitFileState: 'masked' })],
  ]) {
    const registry = createJobRegistry();
    const job = await queue(registry, action);
    await registry.claimNext('server-1');
    await assert.rejects(
      registry.complete({ serverId: 'server-1', jobId: job.id, status: 'succeeded', result: forged }),
      (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
    );
    assert.equal((await registry.getJob(job.id)).status, 'running');
  }
});
