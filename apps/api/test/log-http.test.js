import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { LogHttpError, mountLogRoutes } from '../src/log-http.js';
import { ownerManagementContext, readOnlyManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const JOB_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const NOW = Date.parse('2026-09-11T12:00:00.000Z');

async function serve(t, context, dependencies) {
  const app = express();
  mountLogRoutes(app, { ...dependencies, localServerId: SERVER_ID, now: () => NOW });
  app.use((error, request, response, next) => {
    if (error instanceof LogHttpError) return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return next(error);
  });
  const server = http.createServer(withPanelContext(app, context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function dependencies(overrides = {}) {
  return {
    registry: { getServer: async (id) => id === SERVER_ID ? { id, executionMode: 'local' } : null },
    applicationRegistry: {
      getApplication: async (id) => id === APPLICATION_ID ? { id, serverId: SERVER_ID, type: 'node' } : null,
    },
    jobRegistry: {
      getJob: async (id) => id === JOB_ID ? { id, serverId: SERVER_ID, operation: 'app.node.deploy' } : null,
    },
    journalLogReader: { query: async () => ({ entries: [], page: { count: 0 }, range: {} }) },
    nginxLogReader: { query: async () => ({ entries: [], page: { count: 0 }, range: {} }) },
    jobLogStore: { query: async () => ({ entries: [], page: { count: 0 }, range: {} }) },
    ...overrides,
  };
}

test('Owner reads exact Node journal logs with normalized filters and an NDJSON snapshot', async (t) => {
  const calls = [];
  const result = {
    entries: [{ cursor: 's=one;i=1', timestamp: '2026-09-11T11:00:00.000Z', level: 'error', source: 'journal', unit: 'node', message: 'failed', truncated: false }],
    page: { count: 1, hasMore: false, nextCursor: null },
    range: { since: '2026-09-11T10:00:00.000Z', until: '2026-09-11T12:00:00.000Z' },
  };
  const baseUrl = await serve(t, ownerManagementContext, dependencies({
    journalLogReader: { query: async (query) => { calls.push(query); return result; } },
  }));
  const query = 'since=2026-09-11T10%3A00%3A00.000Z&until=2026-09-11T12%3A00%3A00.000Z&level=error,warning&q=failed&limit=20';
  const response = await fetch(`${baseUrl}/api/applications/${APPLICATION_ID}/logs/node?${query}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, result);
  assert.match(calls[0].unit, /^yunpanel-node-[a-f0-9]{16}\.service$/);
  assert.deepEqual(calls[0].priorities, [3, 4]);
  assert.equal(calls[0].search, 'failed');
  assert.equal(calls[0].limit, 20);

  const stream = await fetch(`${baseUrl}/api/applications/${APPLICATION_ID}/logs/node/stream?${query}`);
  assert.match(stream.headers.get('content-type'), /application\/x-ndjson/);
  const lines = (await stream.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.type), ['entry', 'page']);
});

test('systemd/Nginx download derives one allowlisted unit and returns attachment text', async (t) => {
  let unit;
  const baseUrl = await serve(t, ownerManagementContext, dependencies({
    journalLogReader: { query: async (query) => {
      unit = query.unit;
      return {
        entries: [{ timestamp: '2026-09-11T11:00:00.000Z', level: 'warning', source: 'journal', unit, message: 'bounded warning', truncated: false }],
        page: { count: 1, hasMore: false }, range: { since: query.since, until: query.until },
      };
    } },
  }));
  const response = await fetch(`${baseUrl}/api/servers/${SERVER_ID}/logs/nginx/download`);
  assert.equal(response.status, 200);
  assert.equal(unit, 'nginx.service');
  assert.match(response.headers.get('content-disposition'), /yunpanel-nginx-logs\.txt/);
  assert.match(await response.text(), /WARNING nginx\.service bounded warning/);
  let nginxKind;
  const nginxFiles = await serve(t, ownerManagementContext, dependencies({
    nginxLogReader: { query: async (query) => { nginxKind = query.kind; return { entries: [], page: {}, range: {} }; } },
  }));
  assert.equal((await fetch(`${nginxFiles}/api/servers/${SERVER_ID}/logs/nginx-error`)).status, 200);
  assert.equal(nginxKind, 'error');
  const unsupported = await fetch(`${baseUrl}/api/servers/${SERVER_ID}/logs/ssh`);
  assert.equal(unsupported.status, 404);
});

test('deploy log API supports bounded download but rejects non-deploy and remote resources', async (t) => {
  const calls = [];
  const baseUrl = await serve(t, ownerManagementContext, dependencies({
    jobLogStore: { query: async (...args) => { calls.push(args); return { entries: [], page: { count: 0 }, range: {} }; } },
  }));
  const response = await fetch(`${baseUrl}/api/jobs/${JOB_ID}/logs/deploy/download?limit=1000`);
  assert.equal(response.status, 200);
  assert.equal(calls[0][0], JOB_ID);
  assert.equal(calls[0][1].limit, 1000);

  const nonDeploy = await serve(t, ownerManagementContext, dependencies({
    jobRegistry: { getJob: async () => ({ id: JOB_ID, serverId: SERVER_ID, operation: 'app.node.restart' }) },
  }));
  assert.equal((await fetch(`${nonDeploy}/api/jobs/${JOB_ID}/logs/deploy`)).status, 409);

  const remote = await serve(t, ownerManagementContext, dependencies({
    registry: { getServer: async () => ({ id: SERVER_ID, executionMode: 'legacy_agent' }) },
  }));
  assert.equal((await fetch(`${remote}/api/servers/${SERVER_ID}/logs/nginx`)).status, 409);
});

test('log routes remain Owner-only and reject ambiguous query input before readers run', async (t) => {
  let reads = 0;
  const deps = dependencies({ journalLogReader: { query: async () => { reads += 1; return {}; } } });
  const readOnly = await serve(t, readOnlyManagementContext, deps);
  assert.equal((await fetch(`${readOnly}/api/servers/${SERVER_ID}/logs/nginx`)).status, 403);
  const owner = await serve(t, ownerManagementContext, deps);
  assert.equal((await fetch(`${owner}/api/servers/${SERVER_ID}/logs/nginx?q=TOKEN%3Dsecret`)).status, 400);
  assert.equal((await fetch(`${owner}/api/servers/${SERVER_ID}/logs/nginx?limit=1&limit=2`)).status, 400);
  assert.equal(reads, 0);
});
