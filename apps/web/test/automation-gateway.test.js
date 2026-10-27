import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPanelServer } from '../server.js';
import { createApiKeyStore } from '../../api/src/api-key-store.js';
import { createApp } from '../../api/src/app.js';
import { createAuthenticatedApi } from '../../api/src/auth-http.js';
import { createAutomationHandler } from '../../api/src/automation-http.js';
import { createServerRegistry } from '../../api/src/server-registry.js';

// Real chain: public web gateway -> API auth entry (proxy token checked) -> app.
const proxyToken = 'p'.repeat(43);
const publicOrigin = 'https://panel.example.test';

async function fixture(t) {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), 'yp-gw-'));
  t.after(() => rm(webRoot, { recursive: true, force: true }));
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>x</title>');
  const apiKeyStore = createApiKeyStore();
  const { token } = await apiKeyStore.create({ name: 'Provisioner', parentDomain: 'st.example.test', portMin: 32000, portMax: 32999 });
  const api = http.createServer(createAuthenticatedApi({
    store: { configured: () => true, mfa: { enabled: () => true }, getSession: () => null },
    publicOrigin, proxyToken, trustedProxyIps: '127.0.0.1',
    createHandler: () => createApp({ environment: 'production', registry: createServerRegistry(), apiKeyStore }),
    automationHandler: createAutomationHandler({ apiKeyStore }),
  })).listen(0, '127.0.0.1');
  await once(api, 'listening');
  const web = createPanelServer({ allowedClientIps: '127.0.0.1', apiPort: api.address().port, proxyToken, publicOrigin, webRoot }).listen(0, '127.0.0.1');
  await once(web, 'listening');
  t.after(() => { for (const server of [web, api]) { server.closeAllConnections(); server.close(); } });
  const call = async (method, pathname, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${web.address().port}${pathname}`, { method, headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { token, call };
}

test('a machine client reaches the automation API through the public gateway with its key', async (t) => {
  const f = await fixture(t);
  const whoami = await f.call('GET', '/api/automation/whoami', { authorization: `Bearer ${f.token}` });
  assert.equal(whoami.status, 200, JSON.stringify(whoami.body));
  assert.equal(whoami.body.data.scope.parentDomain, 'st.example.test');
  const write = await f.call('PUT', '/api/automation/tenant-sites/acme', { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' });
  assert.notEqual(write.status, 403, 'mutations need no browser origin on this path');
});

test('browsers and keyless requests are refused at the gateway path', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('GET', '/api/automation/whoami')).status, 401);
  assert.equal((await f.call('GET', '/api/automation/whoami', { authorization: `Bearer ${f.token}`, cookie: 'yunpanel_session=x' })).status, 403);
  assert.equal((await f.call('PUT', '/api/automation/tenant-sites/acme', { authorization: `Bearer ${f.token}`, origin: publicOrigin })).status, 403);
});
