import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mountDockerWorkloadRoutes } from '../src/docker-workload-http.js';

const management = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});
const readOnly = Object.freeze({
  user: { role: 'read_only' },
  access: { mode: 'read_only', permissions: ['docker_workloads.read'] },
  security: { managementAllowed: false },
});

async function listen(t, auth) {
  const records = [];
  const registry = {
    async createWorkload(input) {
      const workload = { id: 'workload-1', state: 'unverified', revision: 1, ...input };
      records.push(workload);
      return workload;
    },
    async getWorkload(id) { return records.find((item) => item.id === id) ?? null; },
    async listWorkloads({ serverId }) { return records.filter((item) => !serverId || item.serverId === serverId); },
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  mountDockerWorkloadRoutes(app, { dockerWorkloadRegistry: registry });
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({ error: { code: error.code ?? 'internal_error' } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, records };
}

test('Owner registers only explicit external Docker tracking without claiming side effects', async (t) => {
  const { base } = await listen(t, management);
  const response = await fetch(`${base}/api/docker/workloads`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: 'server-1', name: 'API', managementMode: 'external',
      proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true },
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body.sideEffects, { containersChanged: false, nginxChanged: false });
  assert.equal(body.data.state, 'unverified');
});

test('Read Only can inspect Docker tracking but cannot create it', async (t) => {
  const { base, records } = await listen(t, readOnly);
  records.push({ id: 'workload-1', serverId: 'server-1', state: 'unverified' });
  assert.equal((await fetch(`${base}/api/docker/workloads`)).status, 200);
  assert.equal((await fetch(`${base}/api/docker/workloads/workload-1`)).status, 200);
  assert.equal((await fetch(`${base}/api/docker/workloads`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status, 403);
});

test('Docker workload API rejects unknown fields and unsupported queries', async (t) => {
  const { base } = await listen(t, management);
  assert.equal((await fetch(`${base}/api/docker/workloads`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: 'server-1', name: 'API', managementMode: 'external', proxyTarget: {}, secret: 'no' }),
  })).status, 400);
  assert.equal((await fetch(`${base}/api/docker/workloads?token=no`)).status, 400);
});
