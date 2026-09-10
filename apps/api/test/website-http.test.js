import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { mountWebsiteRoutes } from '../src/website-http.js';
import { WebsiteRegistryError } from '../src/website-registry.js';

const ownerAuth = Object.freeze({
  user: { id: 'owner-1', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function fixture(t) {
  const websites = [];
  const calls = [];
  const websiteRegistry = {
    async listWebsites(filter) { calls.push(['list', filter]); return websites.map((website) => ({ ...website })); },
    async getWebsite(id) { calls.push(['get', id]); return websites.find((website) => website.id === id) ?? null; },
    async createWebsite(input) {
      calls.push(['create', input]);
      const website = {
        id: 'website-1',
        serverId: input.serverId,
        name: input.name,
        applicationId: input.applicationId,
        runtimeType: input.runtimeType ?? 'static',
        documentRoot: '/managed/current',
        unixUser: 'yunapp-123456789abc',
      };
      websites.push(website);
      return { ...website };
    },
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = ownerAuth; next(); });
  mountWebsiteRoutes(app, { websiteRegistry });
  app.use((error, _request, response, _next) => {
    if (error instanceof WebsiteRegistryError) return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return response.status(500).json({ error: { code: 'internal_error' } });
  });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    request: (pathname, options = {}) => fetch(`${base}${pathname}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...(options.headers ?? {}) } : options.headers,
    }),
  };
}

test('Website collection and detail return actual Website records', async (t) => {
  const f = await fixture(t);
  const created = await f.request('/api/websites', {
    method: 'POST',
    body: JSON.stringify({ serverId: 'server-1', name: 'Site', applicationId: 'app-1' }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).data.id, 'website-1');

  const list = await f.request('/api/websites?serverId=server-1');
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data[0].id, 'website-1');

  const detail = await f.request('/api/websites/website-1');
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.name, 'Site');
  assert.deepEqual(f.calls.slice(0, 3), [
    ['create', { serverId: 'server-1', name: 'Site', applicationId: 'app-1', runtimeType: null }],
    ['list', { serverId: 'server-1' }],
    ['get', 'website-1'],
  ]);
});

test('Website create rejects caller-controlled root user and unknown fields before registry mutation', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { serverId: 'server-1', name: 'Site', applicationId: 'app-1', documentRoot: '/tmp/root' },
    { serverId: 'server-1', name: 'Site', applicationId: 'app-1', unixUser: 'root' },
    { serverId: 'server-1', name: 'Site', applicationId: 'app-1', hostname: 'example.com' },
  ]) {
    const response = await f.request('/api/websites', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_website_input');
  }
  assert.equal(f.calls.some(([name]) => name === 'create'), false);
});

test('Website list accepts only a single serverId query', async (t) => {
  const f = await fixture(t);
  for (const pathname of ['/api/websites?unknown=x', '/api/websites?serverId=one&serverId=two']) {
    const response = await f.request(pathname);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_website_query');
  }
  assert.equal(f.calls.some(([name]) => name === 'list'), false);
});

test('missing Website detail is an explicit 404', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/websites/missing');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'website_not_found');
});
