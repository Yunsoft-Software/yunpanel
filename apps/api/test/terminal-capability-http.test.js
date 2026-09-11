import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import test from 'node:test';
import { mountTerminalCapabilityRoutes } from '../src/terminal-capability-http.js';
import { createTerminalCapabilityRegistry } from '../src/terminal-capability-registry.js';
import { withPanelContext, readOnlyManagementContext } from './helpers/panel-auth-fixture.js';

const SERVER_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce8';
const WEBSITE_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const OWNER_CONTEXT = Object.freeze({
  id: '12345678-1234-4234-9234-123456789012',
  user: Object.freeze({ id: 'owner-1', username: 'owner', role: 'owner' }),
  security: Object.freeze({ managementAllowed: true }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
});

async function request(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/terminal/capabilities`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function fixture(t, context = OWNER_CONTEXT, overrides = {}) {
  const terminalCapabilityRegistry = createTerminalCapabilityRegistry();
  const registry = {
    async getServer(serverId) { return serverId === SERVER_ID ? { id: SERVER_ID } : null; },
  };
  const websiteRegistry = {
    async getWebsite(websiteId) {
      if (websiteId !== WEBSITE_ID) return null;
      return {
        id: WEBSITE_ID,
        serverId: SERVER_ID,
        runtimeType: 'static',
        unixUser: 'yunapp-123456789abc',
        documentRoot: '/var/www/yunpanel/apps/application/current',
      };
    },
  };
  const inner = express();
  inner.use(express.json({ limit: '256kb' }));
  mountTerminalCapabilityRoutes(inner, {
    terminalCapabilityRegistry,
    serverRegistry: overrides.registry ?? registry,
    websiteRegistry: overrides.websiteRegistry ?? websiteRegistry,
    localServerId: overrides.localServerId ?? SERVER_ID,
  });
  inner.use((error, _request, response, _next) => response.status(error.status ?? 500).json({
    error: { code: error.code ?? 'internal_error', message: error.message },
  }));
  const app = withPanelContext(inner, context);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, terminalCapabilityRegistry };
}

test('Owner issues exact local root and isolated Website capabilities without a shell command', async (t) => {
  const state = await fixture(t);
  const root = await request(state.baseUrl, { scope: 'server', serverId: SERVER_ID });
  assert.equal(root.response.status, 201);
  assert.deepEqual(root.payload.data.target, { scope: 'server', serverId: SERVER_ID, user: 'root', cwd: '/root' });
  assert.equal(state.terminalCapabilityRegistry.consume(root.payload.data.capability, {
    sessionId: OWNER_CONTEXT.id, userId: OWNER_CONTEXT.user.id,
  }).target.user, 'root');

  const site = await request(state.baseUrl, { scope: 'site', websiteId: WEBSITE_ID });
  assert.equal(site.response.status, 201);
  assert.deepEqual(site.payload.data.target, {
    scope: 'site',
    serverId: SERVER_ID,
    websiteId: WEBSITE_ID,
    user: 'yunapp-123456789abc',
    cwd: '/var/www/yunpanel/apps/application/current',
  });
  assert.equal(JSON.stringify(site.payload).includes('command'), false);
});

test('terminal capability rejects remote, unsupported Website and extra request fields', async (t) => {
  const remote = await fixture(t, OWNER_CONTEXT, { localServerId: '216e4db8-468b-4e2f-a021-3ab31e0f4123' });
  assert.equal((await request(remote.baseUrl, { scope: 'server', serverId: SERVER_ID })).payload.error.code, 'terminal_remote_server_unsupported');

  const proxy = await fixture(t, OWNER_CONTEXT, {
    websiteRegistry: {
      async getWebsite() {
        return { id: WEBSITE_ID, serverId: SERVER_ID, runtimeType: 'proxy', unixUser: null, documentRoot: null };
      },
    },
  });
  assert.equal((await request(proxy.baseUrl, { scope: 'site', websiteId: WEBSITE_ID })).payload.error.code, 'site_terminal_unsupported');
  const ordinary = await fixture(t);
  assert.equal((await request(ordinary.baseUrl, { scope: 'server', serverId: SERVER_ID, command: 'id' })).payload.error.code, 'terminal_capability_request_invalid');
});

test('Read Only cannot issue terminal capability', async (t) => {
  const context = { ...readOnlyManagementContext, id: 'read-only-session' };
  const denied = await request((await fixture(t, context)).baseUrl, { scope: 'server', serverId: SERVER_ID });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, 'forbidden');
});
