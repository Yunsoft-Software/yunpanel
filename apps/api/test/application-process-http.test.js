import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';

function runtime(overrides = {}) {
  return {
    nodeMajor: 24,
    packageManager: 'npm',
    installMode: 'ci',
    buildScript: null,
    mode: 'production',
    documentRoot: '.',
    startMode: 'node',
    entryFile: 'server.js',
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 30,
    restartPolicy: 'on-failure',
    ...overrides,
  };
}

async function fixture(t, { deployed = true } = {}) {
  const applicationRegistry = createApplicationRegistry({ serverExists: async () => true });
  const jobRegistry = createJobRegistry();
  await applicationRegistry.createNodeApplication({
    applicationId,
    serverId: 'server-1',
    name: 'Process Node',
    repositoryUrl: 'https://github.com/example/process-node',
    runtime: runtime(),
  });
  if (deployed) {
    await applicationRegistry.markDeploying(applicationId, releaseId);
    await applicationRegistry.markDeployed(applicationId, {
      deploymentId: releaseId,
      releaseId,
      previousReleaseId: null,
      commitSha: 'a'.repeat(40),
      serviceName: 'yunpanel-node-ab35065aba9b0cb6.service',
      port: 3100,
      healthPath: '/health',
      healthy: true,
    });
  }
  const server = http.createServer(withPanelContext(createApp({
    environment: 'production', applicationRegistry, jobRegistry,
  }))).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return {
    applicationRegistry,
    jobRegistry,
    request: (body) => fetch(`http://127.0.0.1:${server.address().port}/api/applications/${applicationId}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

test('Owner queues exact Node process action against active release configuration', async (t) => {
  const state = await fixture(t);
  const current = await state.applicationRegistry.getApplication(applicationId);
  const preview = await state.applicationRegistry.previewNodeConfiguration(applicationId, runtime({ mode: 'development' }));
  await state.applicationRegistry.updateNodeConfiguration({
    applicationId,
    expectedRevision: preview.currentRevision,
    runtime: preview.nextRuntime,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  const response = await state.request({
    action: 'stop', confirmation: `node-process:${applicationId}:${releaseId}:stop`,
  });
  assert.equal(response.status, 202);
  const job = (await response.json()).data;
  assert.equal(job.operation, OPERATIONS.APP_NODE_PROCESS);
  const claimed = await state.jobRegistry.claimNext(current.serverId);
  assert.deepEqual(claimed.envelope.payload, {
    applicationId,
    releaseId,
    runtime: current.activeRuntime,
    action: 'stop',
  });
  assert.equal(claimed.envelope.payload.runtime.mode, 'production');
});

test('Node process control rejects extra fields, arbitrary actions and stale confirmation', async (t) => {
  const state = await fixture(t);
  for (const body of [
    { action: 'restart', confirmation: `node-process:${applicationId}:${releaseId}:restart` },
    { action: 'start', confirmation: 'stale' },
    { action: 'start', confirmation: `node-process:${applicationId}:${releaseId}:start`, command: 'whoami' },
  ]) {
    const response = await state.request(body);
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await state.jobRegistry.listJobs(), []);
});

test('undeployed Application and concurrent Application work fail before queueing process control', async (t) => {
  const undeployed = await fixture(t, { deployed: false });
  const missing = await undeployed.request({
    action: 'start', confirmation: `node-process:${applicationId}:${releaseId}:start`,
  });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, 'application_not_deployed');

  const busy = await fixture(t);
  await busy.jobRegistry.enqueue({
    serverId: 'server-1',
    type: 'app.node.status',
    operation: OPERATIONS.APP_NODE_STATUS,
    payload: { applicationId, releaseId, runtime: runtime() },
    resourceType: 'application',
    resourceId: applicationId,
  });
  const conflict = await busy.request({
    action: 'stop', confirmation: `node-process:${applicationId}:${releaseId}:stop`,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'application_job_conflict');
});
