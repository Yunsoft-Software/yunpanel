import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { ownerManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

// Audit 2026-10-27: the non-hosted /api/sites create path called createSite with no
// role check (management policy ran only afterwards, for the site admin account).
const siteUser = (role) => Object.freeze({
  user: Object.freeze({ id: `${role}-1`, username: role, role, hosting: { kind: role === 'reseller' ? 'reseller' : 'customer' }, websiteIds: [] }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});

async function serve(t, context) {
  const server = http.createServer(withPanelContext(createApp({ environment: 'production' }), () => context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (pathname, body) => (await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
}

const direct = { input: { serverId: 'srv', primaryDomain: 'yeni.example.test' } };

test('the Owner reaches the direct site create handler (input validation answers)', async (t) => {
  const post = await serve(t, ownerManagementContext);
  assert.notEqual(await post('/api/sites/create-preview', direct), 403);
  assert.notEqual(await post('/api/sites', { ...direct, previewDigest: 'a'.repeat(64), confirmation: 'x' }), 403);
});

for (const role of ['customer', 'reseller', 'site_manager']) {
  test(`${role}: the direct (non-hosted) site create path is refused before any processing`, async (t) => {
    const post = await serve(t, siteUser(role));
    assert.equal(await post('/api/sites/create-preview', direct), 403);
    assert.equal(await post('/api/sites', { ...direct, previewDigest: 'a'.repeat(64), confirmation: 'x' }), 403);
  });
}
