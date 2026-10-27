import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProtectedPathAuthManager } from '@yunpanel/host-runtime';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { ownerManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

// Everything is real here: app (with the site resource boundary), registries,
// htpasswd manager and openssl. Only the auth root is a temporary directory.
const customer = (websiteIds) => Object.freeze({
  user: Object.freeze({ id: 'customer-1', username: 'cust', role: 'customer', hosting: { kind: 'customer' }, websiteIds }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});
const ADMIN = { path: '/admin/', key: '0123456789abcdef' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-protected-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createServerRegistry();
  const token = await registry.issueEnrollmentToken({ label: 'pp' });
  const serverId = (await registry.enrollServer({ token: token.token, hostname: 'pp-host' })).server.id;
  const applicationRegistry = createApplicationRegistry({ serverExists: async id => id === serverId });
  const websiteRegistry = createWebsiteRegistry({ serverExists: async id => id === serverId,
    getApplication: async id => applicationRegistry.getApplication(id), getDockerWorkload: async () => null });
  await websiteRegistry.init();
  const domainRegistry = createDomainRegistry({ filePath: path.join(directory, 'domains.json'), serverExists: async id => id === serverId,
    getWebsite: id => websiteRegistry.getWebsite(id) });
  const site = async (name) => {
    const applicationId = randomUUID();
    await applicationRegistry.createPhpApplication({ applicationId, serverId, name: `PHP ${name}` });
    const website = await websiteRegistry.createWebsite({ serverId, name, applicationId, runtimeType: 'php' });
    const domain = await domainRegistry.createDomain({ serverId, websiteId: website.id, primaryDomain: name, targetType: 'php',
      target: { applicationId }, nginxSettings: { protectedPaths: [ADMIN] } });
    return { website, domain };
  };
  const own = await site('own.example.test');
  const other = await site('other.example.test');
  const authRoot = path.join(directory, 'auth');
  let context = customer([own.website.id]);
  const app = createApp({ environment: 'production', registry, websiteRegistry, applicationRegistry, domainRegistry,
    protectedPathAuthManager: createProtectedPathAuthManager({ root: authRoot, groupId: null, openssl: 'openssl' }) });
  const server = http.createServer(withPanelContext(app, () => context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { own, other, call, authRoot, domainRegistry, as: value => { context = value; } };
}

test('a site owner adds, changes and removes a user; only a hash is stored and only names are listed', async (t) => {
  const f = await fixture(t);
  const users = `/api/domains/${f.own.domain.id}/protected-paths/${ADMIN.key}/users`;
  assert.equal((await f.call('PUT', `${users}/editor`, { password: 'Ilk-Parola-1' })).status, 200);
  const stored = await readFile(path.join(f.authRoot, 'own.example.test', `${ADMIN.key}.htpasswd`), 'utf8');
  assert.match(stored, /^editor:\$6\$/);
  assert.equal(stored.includes('Ilk-Parola'), false);
  const listed = await f.call('GET', `/api/domains/${f.own.domain.id}/protected-paths`);
  assert.deepEqual(listed.body.data.paths, [{ path: '/admin/', key: ADMIN.key, users: ['editor'] }]);
  assert.equal(JSON.stringify(listed.body).includes('$6$'), false, 'hashes never leave the host');
  assert.equal((await f.call('PUT', `${users}/editor`, { password: 'Yeni-Parola-2' })).status, 200);
  assert.equal((await f.call('DELETE', `${users}/editor`)).status, 200);
  assert.deepEqual((await f.call('GET', `/api/domains/${f.own.domain.id}/protected-paths`)).body.data.paths[0].users, []);
});

test('another tenant\'s Domain is closed for reading and writing', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('GET', `/api/domains/${f.other.domain.id}/protected-paths`)).status, 403);
  assert.equal((await f.call('PUT', `/api/domains/${f.other.domain.id}/protected-paths/${ADMIN.key}/users/x`, { password: 'Bir-Parola-1' })).status, 403);
  assert.deepEqual(await readdir(f.authRoot).catch(() => []), [], 'nothing written for the foreign Domain');
});

test('a key that is not one of the Domain\'s protected paths is refused', async (t) => {
  const f = await fixture(t);
  const result = await f.call('PUT', `/api/domains/${f.own.domain.id}/protected-paths/fedcba9876543210/users/editor`, { password: 'Bir-Parola-1' });
  assert.equal(result.status, 404);
});

test('invalid usernames and passwords are refused before the host is touched', async (t) => {
  const f = await fixture(t);
  const users = `/api/domains/${f.own.domain.id}/protected-paths/${ADMIN.key}/users`;
  assert.equal((await f.call('PUT', `${users}/a:b`, { password: 'Bir-Parola-1' })).status, 400);
  assert.equal((await f.call('PUT', `${users}/editor`, { password: 'short' })).status, 400);
  assert.equal((await f.call('PUT', `${users}/editor`, { password: 'Bir-Parola-1', extra: true })).status, 400);
});

test('the Owner can manage any Domain', async (t) => {
  const f = await fixture(t);
  f.as(ownerManagementContext);
  assert.equal((await f.call('PUT', `/api/domains/${f.other.domain.id}/protected-paths/${ADMIN.key}/users/owner-user`, { password: 'Bir-Parola-1' })).status, 200);
});
