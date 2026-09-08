import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PROTOCOL_VERSION, OPERATIONS } from '@yunpanel/protocol';
import { createAgentServer } from '../src/server.js';

const TEST_TOKEN = 'test-agent-token';

async function withAgentServer(server, callback) {
  server.listen(0, '127.0.0.1');
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

test('health endpoint is available without privileged operations', async () => {
  await withAgentServer(createAgentServer({ token: TEST_TOKEN }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.service, 'yun-agent');
  });
});

test('operation endpoint requires the agent token', async () => {
  await withAgentServer(createAgentServer({ token: TEST_TOKEN }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 401);
  });
});

test('allowlisted read-only operation is executed', async () => {
  const execute = async (operation) => ({ hostname: operation === OPERATIONS.SERVER_INSPECT ? 'test-host' : null });
  const server = createAgentServer({ token: TEST_TOKEN, execute });

  await withAgentServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/operations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'request-0001',
        operation: OPERATIONS.SERVER_INSPECT,
        payload: {},
        protocolVersion: AGENT_PROTOCOL_VERSION,
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.hostname, 'test-host');
  });
});

test('allowlisted mutation is still rejected by the local operation API', async () => {
  let executed = false;
  const execute = async () => {
    executed = true;
  };
  const server = createAgentServer({ token: TEST_TOKEN, execute });

  await withAgentServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/operations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'request-0002',
        operation: OPERATIONS.DOMAIN_STAGE,
        payload: {
          primaryDomain: 'example.com',
          aliases: [],
          targetType: 'proxy',
          target: { upstreamPort: 3008 },
        },
        protocolVersion: AGENT_PROTOCOL_VERSION,
      }),
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, 'mutation_requires_control_plane');
    assert.equal(executed, false);
  });
});

test('arbitrary shell operation is rejected before execution', async () => {
  let executed = false;
  const execute = async () => {
    executed = true;
  };
  const server = createAgentServer({ token: TEST_TOKEN, execute });

  await withAgentServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/operations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'request-0003',
        operation: 'shell.exec',
        payload: { command: 'whoami' },
        protocolVersion: AGENT_PROTOCOL_VERSION,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(executed, false);
  });
});
