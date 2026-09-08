import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';

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
