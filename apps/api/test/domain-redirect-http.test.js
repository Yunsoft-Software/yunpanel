import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { ownerManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

// Real app (with the site resource boundary), registries and job queue.
const customer = (websiteIds) => Object.freeze({
  user: Object.freeze({ id: 'customer-1', username: 'cust', role: 'customer', hosting: { kind: 'customer' }, websiteIds }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-redirect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createServerRegistry();
  const token = await registry.issueEnrollmentToken({ label: 'rd' });
  const serverId = (await registry.enrollServer({ token: token.token, hostname: 'rd-host' })).server.id;
  const applicationRegistry = createApplicationRegistry({ serverExists: async id => id === serverId });
  const websiteRegistry = createWebsiteRegistry({ serverExists: async id => id === serverId,
    getApplication: async id => applicationRegistry.getApplication(id), getDockerWorkload: async () => null });
  await websiteRegistry.init();
  const domainRegistry = createDomainRegistry({ filePath: path.join(directory, 'domains.json'), serverExists: async id => id === serverId,
    getWebsite: id => websiteRegistry.getWebsite(id) });
  const site = async (name) => {
    const applicationId = randomUUID();
    await applicationRegistry.createPhpApplication({ applicationId, serverId, name: `PHP ${name}` });
    return websiteRegistry.createWebsite({ serverId, name, applicationId, runtimeType: 'php' });
  };
  const own = await site('own.example.test');
  const other = await site('other.example.test');
  let context = customer([own.id]);
  const app = createApp({ environment: 'production', registry, websiteRegistry, applicationRegistry, domainRegistry });
  const server = http.createServer(withPanelContext(app, () => context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const forward = (overrides) => ({ serverId, primaryDomain: 'eski-own.example.test', targetType: 'redirect', target: { url: 'https://own.example.test' }, ...overrides });
  return { own, other, call, forward, as: value => { context = value; } };
}

test('a site owner forwards an old name to their own site and stages it; another tenant\'s site is refused', async (t) => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/domains', f.forward({ websiteId: f.own.id }));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.data.target, { url: 'https://own.example.test', status: 301, preservePath: true });
  const staged = await f.call('POST', `/api/domains/${created.body.data.id}/stage`);
  assert.equal(staged.status, 202);
  assert.equal(staged.body.data.type, 'domain.stage');
  assert.equal((await f.call('POST', '/api/domains', f.forward({ primaryDomain: 'eski-other.example.test', websiteId: f.other.id }))).status, 403);
  assert.equal((await f.call('POST', '/api/domains', f.forward({ primaryDomain: 'serbest.example.test' }))).status, 403);
});

test('the Owner adds a forwarding Domain without a Website; unsafe targets are refused', async (t) => {
  const f = await fixture(t);
  f.as(ownerManagementContext);
  assert.equal((await f.call('POST', '/api/domains', f.forward({ primaryDomain: 'serbest.example.test' }))).status, 201);
  const unsafe = await f.call('POST', '/api/domains', f.forward({ primaryDomain: 'kotu.example.test', target: { url: 'https://x.com/;deny all' } }));
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.body.error.code, 'invalid_redirect_url');
});
