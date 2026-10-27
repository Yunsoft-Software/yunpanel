import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { ownerManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

// Audit 2026-10-27: requirePanelRouteAccess and the site resource boundary let
// site-scoped roles reach /api/dns-zones and /api/notifications; these routes must
// enforce scope themselves. Tested through the real createApp (boundary included).
const siteUser = (role) => Object.freeze({
  user: Object.freeze({ id: `${role}-1`, username: role, role, hosting: { kind: role === 'reseller' ? 'reseller' : 'customer' }, websiteIds: [] }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});

async function fixture(t) {
  const registry = createServerRegistry();
  const token = await registry.issueEnrollmentToken({ label: 'audit' });
  const serverId = (await registry.enrollServer({ token: token.token, hostname: 'audit-host' })).server.id;
  const domainRegistry = createDomainRegistry({ serverExists: async id => id === serverId });
  const victim = await domainRegistry.createDomain({ serverId, primaryDomain: 'victim.example.test', targetType: 'static',
    target: { root: '/var/lib/yunpanel/apps/victim/current', spaFallback: false } });
  const dnsHostingRegistry = createDnsHostingRegistry({ getWebDomain: id => domainRegistry.getDomain(id) });
  const zone = await dnsHostingRegistry.createZone({ zoneName: 'victim.example.test', webDomainId: victim.id, managementMode: 'external' });
  let context = ownerManagementContext;
  const app = createApp({ environment: 'production', registry, domainRegistry, dnsHostingRegistry });
  const server = http.createServer(withPanelContext(app, () => context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const response = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, text: await response.text() };
  };
  return { zone, call, as: value => { context = value; } };
}

test('the Owner sees and manages DNS zones and notifications', async (t) => {
  const f = await fixture(t);
  assert.match((await f.call('GET', '/api/dns-zones')).text, /victim\.example\.test/);
  assert.equal((await f.call('GET', `/api/dns-zones/${f.zone.id}`)).status, 200);
  assert.equal((await f.call('GET', '/api/notifications/history')).status, 200);
});

for (const role of ['customer', 'reseller', 'site_manager']) {
  test(`${role}: DNS zones of other tenants are invisible and their provider credential cannot be touched`, async (t) => {
    const f = await fixture(t);
    f.as(siteUser(role));
    const list = await f.call('GET', '/api/dns-zones');
    assert.equal(list.text.includes('victim.example.test'), false, 'zone list leaked');
    for (const pathname of [`/api/dns-zones/${f.zone.id}`, `/api/dns-zones/${f.zone.id}/provider-credential`, `/api/dns-zones/${f.zone.id}/requirements`]) {
      const result = await f.call('GET', pathname);
      assert.ok([403, 404].includes(result.status), `${pathname} -> ${result.status}`);
      assert.equal(result.text.includes('victim.example.test'), false, pathname);
    }
    const put = await f.call('PUT', `/api/dns-zones/${f.zone.id}/provider-credential`,
      { provider: 'cloudflare', token: 'x'.repeat(40), confirmation: `configure-dns-provider:${f.zone.id}:cloudflare` });
    assert.ok([403, 404].includes(put.status), `provider credential PUT -> ${put.status}`);
  });

  test(`${role}: the Owner's operational notifications and preferences are closed`, async (t) => {
    const f = await fixture(t);
    f.as(siteUser(role));
    for (const pathname of ['/api/notifications/history', '/api/notifications/deliveries', '/api/notifications/preferences', '/api/notifications/status']) {
      assert.equal((await f.call('GET', pathname)).status, 403, pathname);
    }
    assert.equal((await f.call('PATCH', '/api/notifications/preferences', { sslExpiry: false })).status, 403);
  });
}

for (const role of ['customer', 'reseller', 'site_manager']) {
  test(`${role}: parity adapters cannot be executed (client-named methods are Owner only)`, async (t) => {
    const f = await fixture(t);
    f.as(siteUser(role));
    for (const pathname of ['/api/system/parity/os/WIN-01/execute', '/api/system/parity/external/EXT-REG-01/execute']) {
      assert.equal((await f.call('POST', pathname, { method: 'getServiceStatus', args: [] })).status, 403, pathname);
    }
  });
}
