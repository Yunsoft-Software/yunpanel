import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';

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

async function fixture(t) {
  const applicationRegistry = createApplicationRegistry({ serverExists: async () => true });
  const jobRegistry = createJobRegistry();
  await applicationRegistry.createNodeApplication({
    applicationId,
    serverId: 'server-1',
    name: 'HTTP Node',
    repositoryUrl: 'https://github.com/example/http-node',
    runtime: runtime(),
  });
  const server = http.createServer(withPanelContext(createApp({
    environment: 'production', applicationRegistry, jobRegistry,
  }))).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    applicationRegistry,
    jobRegistry,
    request: (pathname, body) => fetch(`${base}${pathname}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

test('Owner previews and applies exact Node configuration without changing the active process', async (t) => {
  const state = await fixture(t);
  const nextRuntime = runtime({ packageManager: 'pnpm', documentRoot: 'services/api', startMode: 'npm', startScript: 'serve' });
  const previewResponse = await state.request(`/api/applications/${applicationId}/configuration-preview`, { runtime: nextRuntime });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).data;
  assert.equal(preview.autoApply, false);

  const invalid = await state.request(`/api/applications/${applicationId}/configuration`, {
    runtime: nextRuntime,
    expectedRevision: preview.currentRevision,
    previewDigest: preview.previewDigest,
    confirmation: 'wrong',
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'node_configuration_confirmation_required');

  const applied = await state.request(`/api/applications/${applicationId}/configuration`, {
    runtime: nextRuntime,
    expectedRevision: preview.currentRevision,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(applied.status, 200);
  const application = (await applied.json()).data;
  assert.equal(application.desiredRevision, 2);
  assert.equal(application.runtime.packageManager, 'pnpm');
  assert.equal(application.activeRuntime, null);

  const hidden = await state.request(`/api/applications/${applicationId}/configuration-preview`, { runtime: nextRuntime, command: 'id' });
  assert.equal(hidden.status, 400);
  assert.equal((await hidden.json()).error.code, 'node_configuration_input_invalid');
});

test('queued Application work blocks Node configuration preview before mutation', async (t) => {
  const state = await fixture(t);
  await state.jobRegistry.enqueue({
    serverId: '9d4a4727-1aba-4d35-95fe-21db67042ce8',
    type: 'app.node.status',
    operation: 'app.node.status',
    payload: { applicationId, releaseId: 'ff830043-9752-4640-83b4-3a1998de78a0', runtime: runtime() },
    resourceType: 'application',
    resourceId: applicationId,
  });
  const response = await state.request(`/api/applications/${applicationId}/configuration-preview`, { runtime: runtime({ mode: 'development' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'application_job_conflict');
  assert.equal((await state.applicationRegistry.getApplication(applicationId)).desiredRevision, 1);
});
