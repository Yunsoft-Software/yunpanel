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
  const domains = [
    {
      id: 'domain-1', websiteId: 'website-1', primaryDomain: 'example.com', targetType: 'static',
      target: { root: '/managed/current', spaFallback: true }, httpsMode: 'managed', certificateId: 'cert-1',
      desiredRevision: 3, appliedRevision: 2,
    },
    {
      id: 'domain-2', websiteId: null, primaryDomain: 'legacy.example.com', targetType: 'proxy',
      target: { upstreamHost: '127.0.0.1', upstreamPort: 3000, websocket: true }, httpsMode: 'off', certificateId: null,
      desiredRevision: 1, appliedRevision: 0,
    },
  ];
  const calls = [];
  const websiteRegistry = {
    async listWebsites(filter) { calls.push(['list', filter]); return websites.map((website) => ({ ...website })); },
    async getWebsite(id) { calls.push(['get', id]); return websites.find((website) => website.id === id) ?? null; },
    async createWebsite(input) {
      calls.push(['create', input]);
      const website = {
        id: 'website-1', serverId: input.serverId, name: input.name, applicationId: input.applicationId,
        runtimeType: input.runtimeType ?? 'static', documentRoot: '/managed/current', unixUser: 'yunapp-123456789abc',
        proxyTarget: input.proxyTarget, revision: 1,
      };
      websites.push(website);
      return { ...website };
    },
    async previewWebsiteUpdate(id, changes) {
      calls.push(['preview-update', id, changes]);
      const website = websites.find((candidate) => candidate.id === id);
      if (!website) throw new WebsiteRegistryError('website_not_found', 'Website not found', 404);
      return {
        version: 1,
        websiteId: id,
        currentRevision: website.revision,
        nextWebsite: { ...website, ...changes },
        impact: {
          nameChanged: changes.name !== undefined && changes.name !== website.name,
          bindingChanged: Object.hasOwn(changes, 'applicationId') || Object.hasOwn(changes, 'runtimeType'),
          proxyTargetChanged: Object.hasOwn(changes, 'proxyTarget'),
        },
        fingerprint: 'a'.repeat(64),
      };
    },
    async updateWebsite(input) {
      calls.push(['update', input]);
      const website = websites.find((candidate) => candidate.id === input.websiteId);
      Object.assign(website, input.changes, { revision: website.revision + 1 });
      return { ...website };
    },
  };
  const domainRegistry = {
    async listDomains() { calls.push(['domains']); return domains.map((domain) => ({ ...domain })); },
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = ownerAuth; next(); });
  mountWebsiteRoutes(app, { websiteRegistry, domainRegistry });
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
    domains,
    request: (pathname, options = {}) => fetch(`${base}${pathname}`, {
      ...options,
      headers: options.body ? { 'content-type': 'application/json', ...(options.headers ?? {}) } : options.headers,
    }),
  };
}

test('Website collection and detail return actual Website records', async (t) => {
  const f = await fixture(t);
  const created = await f.request('/api/websites', {
    method: 'POST', body: JSON.stringify({ serverId: 'server-1', name: 'Site', applicationId: 'app-1' }),
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
    ['create', { serverId: 'server-1', name: 'Site', applicationId: 'app-1', dockerWorkloadId: null, runtimeType: null, proxyTarget: null }],
    ['list', { serverId: 'server-1' }],
    ['get', 'website-1'],
  ]);
});

test('Website domain relationship uses explicit websiteId only', async (t) => {
  const f = await fixture(t);
  await f.request('/api/websites', { method: 'POST', body: JSON.stringify({ serverId: 'server-1', name: 'Site', applicationId: 'app-1' }) });
  const response = await f.request('/api/websites/website-1/domains');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((domain) => domain.id), ['domain-1']);
  assert.equal(body.data.some((domain) => domain.id === 'domain-2'), false);
  assert.equal(f.calls.some(([name]) => name === 'domains'), true);
});

test('Website create forwards an explicit Docker workload identity without a caller target', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/websites', {
    method: 'POST',
    body: JSON.stringify({
      serverId: 'server-1', name: 'Docker Site', applicationId: null,
      dockerWorkloadId: 'workload-1', runtimeType: 'docker',
    }),
  });
  assert.equal(response.status, 201);
  const call = f.calls.find(([name]) => name === 'create');
  assert.deepEqual(call, ['create', {
    serverId: 'server-1', name: 'Docker Site', applicationId: null,
    dockerWorkloadId: 'workload-1', runtimeType: 'docker', proxyTarget: null,
  }]);
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

test('missing Website detail and domain relationship are explicit 404s', async (t) => {
  const f = await fixture(t);
  for (const pathname of ['/api/websites/missing', '/api/websites/missing/domains']) {
    const response = await f.request(pathname);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'website_not_found');
  }
});

test('Website update preview reports linked traffic impact and exact confirmation', async (t) => {
  const f = await fixture(t);
  await f.request('/api/websites', {
    method: 'POST', body: JSON.stringify({ serverId: 'server-1', name: 'Site', applicationId: 'app-1' }),
  });
  const response = await f.request('/api/websites/website-1/update-preview', {
    method: 'POST', body: JSON.stringify({ changes: { applicationId: null, runtimeType: 'proxy' } }),
  });
  assert.equal(response.status, 200);
  const preview = (await response.json()).data;
  assert.equal(preview.currentRevision, 1);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(preview, 'registryFingerprint'), false);
  assert.equal(preview.confirmation, `update:website-1:1:${preview.previewDigest}`);
  assert.equal(preview.impact.linkedDomainCount, 1);
  assert.equal(preview.impact.linkedDomains[0].primaryDomain, 'example.com');
  assert.equal(preview.impact.requiresDomainRestage, true);
  assert.equal(preview.impact.domainTrafficChanged, false);

  const applied = await f.request('/api/websites/website-1', {
    method: 'PATCH',
    body: JSON.stringify({
      revision: preview.currentRevision,
      changes: { applicationId: null, runtimeType: 'proxy' },
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
  });
  assert.equal(applied.status, 200);
  const result = (await applied.json()).data;
  assert.equal(result.website.revision, 2);
  assert.equal(result.website.runtimeType, 'proxy');
  assert.equal(result.impact.domainTrafficChanged, false);
  assert.equal(f.calls.some(([name]) => name === 'update'), true);
});

test('Website update rejects stale linked Domain impact and wrong confirmation before mutation', async (t) => {
  const f = await fixture(t);
  await f.request('/api/websites', {
    method: 'POST', body: JSON.stringify({ serverId: 'server-1', name: 'Site', applicationId: 'app-1' }),
  });
  const changes = { name: 'Renamed' };
  const first = await f.request('/api/websites/website-1/update-preview', {
    method: 'POST', body: JSON.stringify({ changes }),
  });
  const stale = (await first.json()).data;
  f.domains[0].desiredRevision += 1;

  const staleApply = await f.request('/api/websites/website-1', {
    method: 'PATCH',
    body: JSON.stringify({ revision: 1, changes, previewDigest: stale.previewDigest, confirmation: stale.confirmation }),
  });
  assert.equal(staleApply.status, 409);
  assert.equal((await staleApply.json()).error.code, 'website_update_preview_stale');

  const freshResponse = await f.request('/api/websites/website-1/update-preview', {
    method: 'POST', body: JSON.stringify({ changes }),
  });
  const fresh = (await freshResponse.json()).data;
  const denied = await f.request('/api/websites/website-1', {
    method: 'PATCH',
    body: JSON.stringify({ revision: 1, changes, previewDigest: fresh.previewDigest, confirmation: 'update:wrong' }),
  });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, 'website_update_confirmation_required');
  assert.equal(f.calls.filter(([name]) => name === 'update').length, 0);
});

test('Website update bodies reject hidden fields before preview or mutation', async (t) => {
  const f = await fixture(t);
  for (const [pathname, method, body] of [
    ['/api/websites/website-1/update-preview', 'POST', { changes: { name: 'Changed', unixUser: 'root' } }],
    ['/api/websites/website-1/update-preview', 'POST', { changes: { name: 'Changed' }, extra: true }],
    ['/api/websites/website-1', 'PATCH', { revision: 1, changes: { name: 'Changed' }, previewDigest: 'a'.repeat(64), confirmation: 'x', extra: true }],
  ]) {
    const response = await f.request(pathname, { method, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(f.calls.some(([name]) => name === 'preview-update' || name === 'update'), false);
});
