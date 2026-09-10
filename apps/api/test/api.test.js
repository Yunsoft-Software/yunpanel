import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('health endpoint returns API status', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'yunpanel-api');
  });
});

test('development agent endpoint is hidden outside development mode', async () => {
  await withServer(createApp({ environment: 'production' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dev/agent/inspect`);
    assert.equal(response.status, 404);
  });
});

test('development agent endpoint returns the inspected agent payload', async () => {
  const inspectAgent = async () => ({
    requestId: 'request-0001',
    status: 'succeeded',
    result: { hostname: 'local-dev' },
  });

  await withServer(createApp({ inspectAgent, environment: 'development' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dev/agent/inspect`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'succeeded');
    assert.equal(body.result.hostname, 'local-dev');
  });
});

test('agent errors are returned as a safe gateway error', async () => {
  const inspectAgent = async () => {
    throw new Error('agent is offline');
  };

  await withServer(createApp({ inspectAgent, environment: 'development' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dev/agent/inspect`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'agent_unavailable');
  });
});

test('management routes fail closed without server-derived request auth', async () => {
  await withServer(createApp({ environment: 'production' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/servers`, {
      headers: { authorization: 'Bearer development-admin-token' },
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'unauthorized');
  });
});

test('new legacy enrollment HTTP routes are retired while preserved enrolled identities may still heartbeat', async () => {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken();
  const enrolled = await registry.enrollServer({
    token: enrollment.token,
    hostname: 'yun-test-01',
    displayName: 'Yun Test 01',
  });
  const app = withPanelContext(createApp({ registry, environment: 'production' }));

  await withServer(app, async (baseUrl) => {
    const issueResponse = await fetch(`${baseUrl}/api/servers/enrollment-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'retired' }),
    });
    assert.equal(issueResponse.status, 404);

    const enrollResponse = await fetch(`${baseUrl}/api/servers/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'retired-token', hostname: 'yun-test-02' }),
    });
    assert.equal(enrollResponse.status, 404);

    const heartbeatResponse = await fetch(`${baseUrl}/api/servers/${enrolled.server.id}/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${enrolled.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        agentVersion: '0.0.1',
        inventory: { hostname: 'yun-test-01', os: { name: 'Ubuntu', version: '24.04' } },
        services: { nginx: { active: true } },
      }),
    });
    assert.equal(heartbeatResponse.status, 200);
    const heartbeatBody = await heartbeatResponse.json();
    assert.equal(heartbeatBody.data.connectivity, 'online');

    const listResponse = await fetch(`${baseUrl}/api/servers`);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].hostname, 'yun-test-01');
    assert.equal(listBody.data[0].connectivity, 'online');
  });
});

test('domain API stores desired state and rejects duplicate ownership', async () => {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken();
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'yun-domain-test-01' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  const app = withPanelContext(createApp({
    registry,
    domainRegistry,
    environment: 'production',
  }));

  await withServer(app, async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: enrolled.server.id,
        primaryDomain: 'Example.COM',
        aliases: ['www.example.com'],
        targetType: 'proxy',
        target: { upstreamPort: 3008, websocket: true },
      }),
    });

    assert.equal(createResponse.status, 201);
    const createBody = await createResponse.json();
    assert.equal(createBody.data.primaryDomain, 'example.com');
    assert.equal(createBody.data.state, 'draft');

    const conflictResponse = await fetch(`${baseUrl}/api/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: enrolled.server.id,
        primaryDomain: 'www.example.com',
        targetType: 'proxy',
        target: { upstreamPort: 3010 },
      }),
    });
    assert.equal(conflictResponse.status, 409);
    const conflictBody = await conflictResponse.json();
    assert.equal(conflictBody.error.code, 'domain_conflict');

    const listResponse = await fetch(`${baseUrl}/api/domains`);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.data.length, 1);
  });
});
