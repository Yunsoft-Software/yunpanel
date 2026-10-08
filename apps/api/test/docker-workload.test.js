import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { mountDockerWorkloadRoutes } from '../src/docker-workload-http.js';
import { createDockerWorkloadRegistry, DockerWorkloadRegistryError } from '../src/docker-workload-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

const ownerAuth = Object.freeze({
  id: 'owner-session-1',
  user: Object.freeze({ id: 'owner-1', username: 'owner', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const resellerAuth = Object.freeze({
  id: 'reseller-session-1',
  user: Object.freeze({ id: 'reseller-1', username: 'reseller', role: 'reseller', hosting: { kind: 'reseller' } }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['websites.manage']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const customerAuth = Object.freeze({
  id: 'customer-session-1',
  user: Object.freeze({ id: 'customer-1', username: 'customer', role: 'customer', hosting: { kind: 'customer' } }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['websites.manage']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const siteManagerAuth = Object.freeze({
  id: 'site-manager-session-1',
  user: Object.freeze({ id: 'manager-1', username: 'manager', role: 'site_manager' }),
  access: Object.freeze({ mode: 'site_management', permissions: Object.freeze(['websites.manage']) }),
  security: Object.freeze({ managementAllowed: true }),
});

const readOnlyAuth = Object.freeze({
  id: 'read-only-session-1',
  user: Object.freeze({ id: 'reader-1', username: 'reader', role: 'read_only' }),
  access: Object.freeze({ mode: 'read_only', permissions: Object.freeze(['docker_workloads.read']) }),
  security: Object.freeze({ managementAllowed: false }),
});

async function setupApp(t, { defaultAuth = ownerAuth } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-docker-workload-test-'));
  const filePath = path.join(root, 'docker-workload-registry.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  const registry = createDockerWorkloadRegistry({
    filePath,
    serverExists: async (id) => id === serverId,
  });
  await registry.init();

  let currentAuth = defaultAuth;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = currentAuth;
    next();
  });

  mountDockerWorkloadRoutes(app, {
    dockerWorkloadRegistry: registry,
    localServerId: serverId,
  });

  app.use((error, _request, response, _next) => {
    const status = error.status ?? 500;
    return response.status(status).json({
      error: { code: error.code ?? 'internal_error', message: error.message },
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    registry,
    filePath,
    setAuth: (auth) => { currentAuth = auth; },
  };
}

test('Acceptance 1 & 2: Portainer adapter requires authenticated Owner gateway session; unauthenticated and unauthorized requests fail closed (401/403)', async (t) => {
  const { base, setAuth } = await setupApp(t, { defaultAuth: null });

  // 1. Unauthenticated requests fail closed with 401
  const unauthGet = await fetch(`${base}/api/docker/portainer`);
  assert.equal(unauthGet.status, 401);
  const unauthGetBody = await unauthGet.json();
  assert.equal(unauthGetBody.error.code, 'unauthorized');

  const unauthPost = await fetch(`${base}/api/docker/portainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, endpoint: { host: '127.0.0.1', port: 9000 } }),
  });
  assert.equal(unauthPost.status, 401);

  const unauthSession = await fetch(`${base}/api/docker/portainer/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(unauthSession.status, 401);

  const unauthGatewayAccess = await fetch(`${base}/api/docker/portainer-gateway-access`);
  assert.equal(unauthGatewayAccess.status, 401);

  // 2. Authenticated Owner enables the adapter
  setAuth(ownerAuth);
  const enableResponse = await fetch(`${base}/api/docker/portainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId,
      enabled: true,
      endpoint: { host: '127.0.0.1', port: 9000 },
      token: 'secret-admin-token-xyz',
    }),
  });
  assert.equal(enableResponse.status, 200);
  const enableBody = await enableResponse.json();
  assert.equal(enableBody.data.enabled, true);
  assert.equal(enableBody.data.adapter, 'portainer');
  assert.equal(enableBody.data.directPortPublic, false);
  assert.deepEqual(enableBody.data.endpoint, { type: 'loopback', host: '127.0.0.1', port: 9000, directPortPublic: false });

  // 3. Owner creates a gateway session
  const sessionResponse = await fetch(`${base}/api/docker/portainer/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttlMs: 1800_000 }),
  });
  assert.equal(sessionResponse.status, 201);
  const sessionBody = await sessionResponse.json();
  assert.ok(sessionBody.data.sessionId);
  assert.equal(sessionBody.data.audience, 'portainer');
  assert.equal(sessionBody.data.directPortPublic, false);
  assert.ok(sessionBody.data.gatewayPath.includes(sessionBody.data.sessionId));

  // 4. Owner verifies gateway access
  const gatewayAccessResponse = await fetch(`${base}/api/docker/portainer-gateway-access`);
  assert.equal(gatewayAccessResponse.status, 204);

  // 5. When adapter is disabled, gateway access and session creation fail closed
  await fetch(`${base}/api/docker/portainer`, { method: 'DELETE' });
  const disabledSession = await fetch(`${base}/api/docker/portainer/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(disabledSession.status, 409);
  const disabledGatewayAccess = await fetch(`${base}/api/docker/portainer-gateway-access`);
  assert.equal(disabledGatewayAccess.status, 409);
});

test('Acceptance 3: Portainer connects via local endpoint (loopback or internal socket); direct port is never public', async (t) => {
  const { base } = await setupApp(t);

  // Valid loopback hosts succeed
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const res = await fetch(`${base}/api/docker/portainer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId,
        enabled: true,
        endpoint: { host, port: 9000 },
      }),
    });
    assert.equal(res.status, 200, `Loopback host ${host} should be accepted`);
    const data = await res.json();
    assert.equal(data.data.directPortPublic, false);
  }

  // Valid internal Unix socket succeeds
  const socketRes = await fetch(`${base}/api/docker/portainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId,
      enabled: true,
      endpoint: { socketPath: '/run/yunpanel/portainer.sock' },
    }),
  });
  assert.equal(socketRes.status, 200);
  const socketData = await socketRes.json();
  assert.equal(socketData.data.endpoint.type, 'socket');
  assert.equal(socketData.data.endpoint.socketPath, '/run/yunpanel/portainer.sock');
  assert.equal(socketData.data.directPortPublic, false);

  // Public IP addresses must be rejected fail-closed with 400
  for (const publicHost of ['0.0.0.0', '157.180.11.28', '192.168.1.100', 'portainer.public.example.com']) {
    const res = await fetch(`${base}/api/docker/portainer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId,
        enabled: true,
        endpoint: { host: publicHost, port: 9000 },
      }),
    });
    assert.equal(res.status, 400, `Public host ${publicHost} must be rejected`);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_portainer_endpoint');
  }

  // Setting directPortPublic: true must be rejected fail-closed with 400
  const publicPortRes = await fetch(`${base}/api/docker/portainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId,
      enabled: true,
      endpoint: { host: '127.0.0.1', port: 9000 },
      directPortPublic: true,
    }),
  });
  assert.equal(publicPortRes.status, 400);
  const publicPortBody = await publicPortRes.json();
  assert.equal(publicPortBody.error.code, 'portainer_direct_port_public_forbidden');
});

test('Acceptance 4: Secret-safe session management isolates credentials and tokens without leaking into responses or storage', async (t) => {
  const { base, filePath } = await setupApp(t);
  const sensitiveToken = 'sensitive-portainer-bearer-token-abc12345';
  const sensitivePassword = 'super-secret-admin-password-xyz987';

  // Configure Portainer with secrets
  const configRes = await fetch(`${base}/api/docker/portainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId,
      enabled: true,
      endpoint: { host: '127.0.0.1', port: 9000 },
      token: sensitiveToken,
      credentials: { password: sensitivePassword },
    }),
  });
  assert.equal(configRes.status, 200);
  const configText = await configRes.text();
  assert.doesNotMatch(configText, new RegExp(sensitiveToken, 'i'), 'Config response must not leak sensitive token');
  assert.doesNotMatch(configText, new RegExp(sensitivePassword, 'i'), 'Config response must not leak password');

  // GET /api/docker/portainer status must not leak credentials
  const statusRes = await fetch(`${base}/api/docker/portainer`);
  assert.equal(statusRes.status, 200);
  const statusText = await statusRes.text();
  assert.doesNotMatch(statusText, new RegExp(sensitiveToken, 'i'), 'Status response must not leak sensitive token');
  assert.doesNotMatch(statusText, new RegExp(sensitivePassword, 'i'), 'Status response must not leak password');

  // Gateway session creation response must not leak credentials
  const sessionRes = await fetch(`${base}/api/docker/portainer/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttlMs: 3600_000 }),
  });
  assert.equal(sessionRes.status, 201);
  const sessionText = await sessionRes.text();
  assert.doesNotMatch(sessionText, new RegExp(sensitiveToken, 'i'), 'Session response must not leak sensitive token');
  assert.doesNotMatch(sessionText, new RegExp(sensitivePassword, 'i'), 'Session response must not leak password');

  const sessionData = JSON.parse(sessionText).data;
  assert.ok(sessionData.sessionId);
  assert.equal(sessionData.directPortPublic, false);

  // Gateway session inspection must not leak credentials
  const inspectRes = await fetch(`${base}/api/docker/portainer/gateway/${sessionData.sessionId}`);
  assert.equal(inspectRes.status, 200);
  const inspectText = await inspectRes.text();
  assert.doesNotMatch(inspectText, new RegExp(sensitiveToken, 'i'), 'Gateway inspection must not leak sensitive token');
  assert.doesNotMatch(inspectText, new RegExp(sensitivePassword, 'i'), 'Gateway inspection must not leak password');

  // Verify persisted store file contains zero secrets or tokens
  const persistedContent = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persistedContent, new RegExp(sensitiveToken, 'i'), 'Persisted store must not contain token');
  assert.doesNotMatch(persistedContent, new RegExp(sensitivePassword, 'i'), 'Persisted store must not contain password');
  assert.doesNotMatch(persistedContent, /token|password|secret/i, 'Persisted store must not contain secret fields');
});

test('Acceptance 5: Non-Owner roles (Reseller, Customer, site_manager) are strictly rejected with 403 on all Portainer and Docker endpoints', async (t) => {
  const { base, setAuth } = await setupApp(t);

  // First enable the adapter as Owner
  await fetch(`${base}/api/docker/portainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId, enabled: true, endpoint: { host: '127.0.0.1', port: 9000 } }),
  });
  const sessionRes = await fetch(`${base}/api/docker/portainer/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const { data: { sessionId } } = await sessionRes.json();

  const nonOwnerRoles = [
    { name: 'reseller', auth: resellerAuth },
    { name: 'customer', auth: customerAuth },
    { name: 'site_manager', auth: siteManagerAuth },
  ];

  for (const { name, auth } of nonOwnerRoles) {
    setAuth(auth);

    // 1. Cannot read Portainer adapter
    const getRes = await fetch(`${base}/api/docker/portainer`);
    assert.equal(getRes.status, 403, `${name} must be rejected from GET /api/docker/portainer with 403`);
    const getBody = await getRes.json();
    assert.equal(getBody.error.code, 'forbidden');

    // 2. Cannot configure Portainer adapter
    const postRes = await fetch(`${base}/api/docker/portainer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId, enabled: true, endpoint: { host: '127.0.0.1', port: 9000 } }),
    });
    assert.equal(postRes.status, 403, `${name} must be rejected from POST /api/docker/portainer with 403`);

    // 3. Cannot delete Portainer adapter
    const delRes = await fetch(`${base}/api/docker/portainer`, { method: 'DELETE' });
    assert.equal(delRes.status, 403, `${name} must be rejected from DELETE /api/docker/portainer with 403`);

    // 4. Cannot create Portainer gateway session
    const sessRes = await fetch(`${base}/api/docker/portainer/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(sessRes.status, 403, `${name} must be rejected from POST /api/docker/portainer/session with 403`);

    // 5. Cannot access Portainer gateway
    const gateRes = await fetch(`${base}/api/docker/portainer/gateway/${sessionId}`);
    assert.equal(gateRes.status, 403, `${name} must be rejected from gateway session access with 403`);

    // 6. Cannot check Portainer gateway access
    const accessRes = await fetch(`${base}/api/docker/portainer-gateway-access`);
    assert.equal(accessRes.status, 403, `${name} must be rejected from portainer-gateway-access with 403`);

    // 7. Cannot access general Docker workloads
    const workloadListRes = await fetch(`${base}/api/docker/workloads`);
    assert.equal(workloadListRes.status, 403, `${name} must be rejected from GET /api/docker/workloads with 403`);

    const workloadCreateRes = await fetch(`${base}/api/docker/workloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId,
        name: 'test-app',
        managementMode: 'external',
        proxyTarget: { host: '127.0.0.1', port: 8080, websocket: false },
      }),
    });
    assert.equal(workloadCreateRes.status, 403, `${name} must be rejected from POST /api/docker/workloads with 403`);
  }

  // Also check Read Only role: cannot mutate Portainer or create sessions
  setAuth(readOnlyAuth);
  const readOnlyPortainerPost = await fetch(`${base}/api/docker/portainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId, enabled: true, endpoint: { host: '127.0.0.1', port: 9000 } }),
  });
  assert.equal(readOnlyPortainerPost.status, 403, 'read_only role cannot configure Portainer adapter');

  const readOnlySession = await fetch(`${base}/api/docker/portainer/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(readOnlySession.status, 403, 'read_only role cannot create Portainer gateway session');
});
