import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApiKeyStore } from '../src/api-key-store.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAutomationHandler } from '../src/automation-http.js';

// The real auth entry routes /api/automation/* to the key-only handler.
async function fixture(t) {
  const apiKeyStore = createApiKeyStore();
  const { token } = await apiKeyStore.create({ name: 'Provisioner', parentDomain: 'st.example.test', portMin: 32000, portMax: 32999 });
  let panelHits = 0;
  const listener = createAuthenticatedApi({
    store: { configured: () => true, mfa: { enabled: () => true }, getSession: () => null },
    publicOrigin: 'https://panel.example.test',
    createHandler: () => (_request, response) => { panelHits += 1; response.writeHead(404); response.end('{}'); },
    automationHandler: createAutomationHandler({ apiKeyStore }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = async (pathname, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { token, call, apiKeyStore, panelHits: () => panelHits };
}

test('a valid key reaches the automation API and sees only its own scope', async (t) => {
  const f = await fixture(t);
  const result = await f.call('/api/automation/whoami', { authorization: `Bearer ${f.token}` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.scope, { parentDomain: 'st.example.test', portMin: 32000, portMax: 32999 });
  assert.equal(JSON.stringify(result.body).includes(f.token.split('_')[2]), false);
});

test('missing, wrong or revoked keys and browser requests are refused; a key never reaches panel routes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/automation/whoami')).status, 401);
  assert.equal((await f.call('/api/automation/whoami', { authorization: `Bearer ${f.token}x` })).status, 401);
  assert.equal((await f.call('/api/automation/whoami', { authorization: `Basic ${f.token}` })).status, 401);
  assert.equal((await f.call('/api/automation/whoami', { authorization: `Bearer ${f.token}`, cookie: 'yp=1' })).status, 403);
  assert.equal((await f.call('/api/automation/whoami', { authorization: `Bearer ${f.token}`, origin: 'https://evil.test' })).status, 403);
  const panel = await f.call('/api/domains', { authorization: `Bearer ${f.token}` });
  assert.equal(panel.status, 401, 'panel routes still require a session');
  assert.equal(f.panelHits(), 0);
  const [key] = await f.apiKeyStore.list();
  await f.apiKeyStore.revoke(key.id);
  assert.equal((await f.call('/api/automation/whoami', { authorization: `Bearer ${f.token}` })).status, 401);
});
