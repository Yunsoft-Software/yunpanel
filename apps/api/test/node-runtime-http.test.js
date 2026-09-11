import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApp } from '../src/app.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

function inventory() {
  return {
    platform: 'linux', architecture: 'x64', supportedMajors: [22, 24],
    panelRuntime: { path: '/usr/local/bin/node', source: 'panel', version: 'v24.18.1', major: 24 },
    systemRuntime: null,
    managedRuntimes: [
      { major: 22, installed: false, path: '/opt/yunpanel/node-runtimes/v22/bin/node', version: null, packageManagers: [] },
      { major: 24, installed: true, path: '/opt/yunpanel/node-runtimes/v24/bin/node', version: 'v24.21.0', packageManagers: ['npm', 'pnpm', 'yarn'] },
    ],
  };
}

async function fixture(t) {
  const registry = createServerRegistry();
  const serverRecord = await registry.createLocalServer({ hostname: 'node-runtime-host' });
  const jobRegistry = createJobRegistry();
  const server = http.createServer(withPanelContext(createApp({ registry, jobRegistry, environment: 'production' }))).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/servers/${serverRecord.id}/node-runtimes`;
  return {
    serverId: serverRecord.id,
    jobRegistry,
    request: (suffix = '', { method = 'GET', body } = {}) => fetch(`${base}${suffix}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

test('Owner queues Node runtime inspection and exact confirmed supported install', async (t) => {
  const state = await fixture(t);
  const inspect = await state.request('/inspect', { method: 'POST', body: {} });
  assert.equal(inspect.status, 202);
  assert.equal((await inspect.json()).data.operation, OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT);
  await state.jobRegistry.cancel((await state.jobRegistry.listJobs())[0].id);

  const denied = await state.request('/24/install', { method: 'POST', body: { confirmation: 'yes' } });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, 'node_runtime_confirmation_required');
  const accepted = await state.request('/24/install', {
    method: 'POST', body: { confirmation: `install-node-runtime:${state.serverId}:24` },
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).data.operation, OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL);
});

test('unsupported runtime, extra confirmation fields and concurrent system work fail before install', async (t) => {
  const state = await fixture(t);
  for (const [suffix, body] of [
    ['/20/install', { confirmation: `install-node-runtime:${state.serverId}:20` }],
    ['/24/install', { confirmation: `install-node-runtime:${state.serverId}:24`, command: 'whoami' }],
  ]) {
    const response = await state.request(suffix, { method: 'POST', body });
    assert.equal(response.status, 400);
  }
  await state.jobRegistry.enqueue({
    serverId: state.serverId, type: OPERATIONS.SYSTEM_PACKAGES_INSPECT, operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {}, resourceType: 'system', resourceId: state.serverId,
  });
  const conflict = await state.request('/24/install', {
    method: 'POST', body: { confirmation: `install-node-runtime:${state.serverId}:24` },
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'system_job_conflict');
});

test('Node runtime read returns unknown before the first completed inventory', async (t) => {
  const state = await fixture(t);
  const response = await state.request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { inventory: null, snapshot: null });
});

test('Node runtime read exposes the latest sanitized completed inventory', async (t) => {
  const state = await fixture(t);
  const queued = await state.jobRegistry.enqueue({
    serverId: state.serverId, type: OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, operation: OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT,
    payload: {}, resourceType: 'system', resourceId: state.serverId,
  });
  await state.jobRegistry.claimNext(state.serverId);
  await state.jobRegistry.complete({ serverId: state.serverId, jobId: queued.id, status: 'succeeded', result: inventory() });
  const response = await state.request();
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.deepEqual(body.inventory, inventory());
  assert.equal(body.snapshot.jobId, queued.id);
});
