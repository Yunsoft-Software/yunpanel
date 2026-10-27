import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApiKeyStore } from '../src/api-key-store.js';
import { createApp } from '../src/app.js';
import { createServerRegistry } from '../src/server-registry.js';
import { ownerManagementContext, withPanelContext } from './helpers/panel-auth-fixture.js';

const customer = Object.freeze({
  user: Object.freeze({ id: 'customer-1', username: 'cust', role: 'customer', hosting: { kind: 'customer' }, websiteIds: [] }),
  security: Object.freeze({ ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['sites.manage']) }),
});

async function fixture(t) {
  const apiKeyStore = createApiKeyStore();
  const events = [];
  let context = ownerManagementContext;
  const app = createApp({ environment: 'production', registry: createServerRegistry(), apiKeyStore,
    auditStore: { record: async (event) => { events.push(event); } } });
  const server = http.createServer(withPanelContext(app, () => context)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = async (method, pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { call, events, as: value => { context = value; } };
}
const definition = { name: 'Provisioner', parentDomain: 'st.example.test', portMin: 32000, portMax: 32999 };

test('the Owner creates a key (shown once), lists it without the secret and revokes it; actions are audited', async (t) => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/api-keys', definition);
  assert.equal(created.status, 201);
  assert.match(created.body.data.token, /^ypk_/);
  const listed = await f.call('GET', '/api/api-keys');
  assert.equal(listed.body.data.keys.length, 1);
  assert.equal(JSON.stringify(listed.body).includes(created.body.data.token), false);
  assert.equal((await f.call('DELETE', `/api/api-keys/${created.body.data.key.id}`)).status, 200);
  assert.ok((await f.call('GET', '/api/api-keys')).body.data.keys[0].revokedAt);
  assert.deepEqual(f.events.map(event => event.action), ['api_key.create', 'api_key.revoke']);
  assert.equal(JSON.stringify(f.events).includes(created.body.data.token), false);
});

test('site roles cannot see or create keys', async (t) => {
  const f = await fixture(t);
  f.as(customer);
  for (const [method, body] of [['GET'], ['POST', definition]]) {
    assert.equal((await f.call(method, '/api/api-keys', body)).status, 403, method);
  }
});
