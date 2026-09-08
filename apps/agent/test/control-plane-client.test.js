import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AGENT_PROTOCOL_VERSION, OPERATIONS } from '@yunpanel/protocol';
import {
  executeClaimedCommand,
  normalizeControlPlaneUrl,
  startControlPlaneLink,
} from '../src/control-plane-client.js';

function jsonResponse(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: body == null ? undefined : { 'content-type': 'application/json' },
  });
}

function emptyCommandResponse() {
  return jsonResponse(204, null);
}

const emptyInspectors = {
  inspect: async () => ({}),
  inspectServices: async () => ({}),
  inspectDocker: async () => ({}),
  inspectNginx: async () => ({}),
};

test('control plane URL requires HTTPS outside development mode', () => {
  assert.equal(normalizeControlPlaneUrl('http://127.0.0.1:3001', 'development'), 'http://127.0.0.1:3001');
  assert.equal(normalizeControlPlaneUrl('https://panel.example.com/path', 'production'), 'https://panel.example.com');
  assert.throws(
    () => normalizeControlPlaneUrl('http://panel.example.com', 'production'),
    /must use HTTPS/,
  );
});

test('first control plane connection enrolls, protects identity, sends heartbeat and polls commands', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-agent-'));
  const identityFile = path.join(directory, 'identity.json');
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.endsWith('/api/servers/enroll')) {
      return jsonResponse(201, {
        data: {
          server: { id: 'server-001' },
          agentToken: 'agent-token-value-that-is-long-enough',
        },
      });
    }

    if (url.endsWith('/api/servers/server-001/heartbeat')) {
      return jsonResponse(200, {
        data: { id: 'server-001', connectivity: 'online' },
      });
    }

    if (url.endsWith('/api/servers/server-001/commands/next')) {
      return emptyCommandResponse();
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const link = await startControlPlaneLink({
      controlPlaneUrl: 'http://127.0.0.1:3001',
      enrollmentToken: 'one-time-enrollment-token-value',
      identityFile,
      heartbeatMs: 10_000,
      commandPollMs: 60_000,
      mode: 'development',
      fetchImpl,
      inspect: async () => ({ hostname: 'yun-test-01', memory: { totalBytes: 100 } }),
      inspectServices: async () => ({ nginx: { active: true } }),
      inspectDocker: async () => ({ installed: true, reachable: true, containers: [{ name: 'api' }] }),
      inspectNginx: async () => ({ installed: true, configs: [{ name: 'app.conf' }] }),
      logger: { info() {}, error() {} },
    });

    link.stop();

    assert.equal(link.enabled, true);
    assert.equal(link.serverId, 'server-001');
    assert.equal(calls.length, 3);

    const enrollmentRequest = JSON.parse(calls[0].options.body);
    assert.equal(enrollmentRequest.token, 'one-time-enrollment-token-value');

    const heartbeatRequest = JSON.parse(calls[1].options.body);
    assert.equal(heartbeatRequest.inventory.hostname, 'yun-test-01');
    assert.equal(heartbeatRequest.inventory.docker.containers[0].name, 'api');
    assert.equal(heartbeatRequest.inventory.nginx.configs[0].name, 'app.conf');
    assert.equal(heartbeatRequest.services.nginx.active, true);
    assert.equal(calls[1].options.headers.authorization, 'Bearer agent-token-value-that-is-long-enough');

    assert.ok(calls[2].url.endsWith('/api/servers/server-001/commands/next'));
    assert.equal(calls[2].options.headers.authorization, 'Bearer agent-token-value-that-is-long-enough');

    const identity = JSON.parse(await readFile(identityFile, 'utf8'));
    assert.equal(identity.serverId, 'server-001');
    assert.equal(identity.agentToken, 'agent-token-value-that-is-long-enough');

    const identityStat = await stat(identityFile);
    assert.equal(identityStat.mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stored identity is reused without replaying enrollment token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-agent-reuse-'));
  const identityFile = path.join(directory, 'identity.json');
  const calls = [];

  const initialFetch = async (url) => {
    if (url.endsWith('/api/servers/enroll')) {
      return jsonResponse(201, {
        data: {
          server: { id: 'server-002' },
          agentToken: 'persistent-agent-token-value-long-enough',
        },
      });
    }
    if (url.endsWith('/commands/next')) return emptyCommandResponse();
    return jsonResponse(200, { data: { id: 'server-002', connectivity: 'online' } });
  };

  try {
    const first = await startControlPlaneLink({
      controlPlaneUrl: 'http://127.0.0.1:3001',
      enrollmentToken: 'first-use-token-long-enough',
      identityFile,
      heartbeatMs: 10_000,
      commandPollMs: 60_000,
      mode: 'development',
      fetchImpl: initialFetch,
      ...emptyInspectors,
      logger: { info() {}, error() {} },
    });
    first.stop();

    const second = await startControlPlaneLink({
      controlPlaneUrl: 'http://127.0.0.1:3001',
      identityFile,
      heartbeatMs: 10_000,
      commandPollMs: 60_000,
      mode: 'development',
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/commands/next')) return emptyCommandResponse();
        return jsonResponse(200, { data: { id: 'server-002', connectivity: 'online' } });
      },
      ...emptyInspectors,
      logger: { info() {}, error() {} },
    });
    second.stop();

    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith('/api/servers/server-002/heartbeat'));
    assert.ok(calls[1].url.endsWith('/api/servers/server-002/commands/next'));
    assert.equal(calls.some((call) => call.url.endsWith('/api/servers/enroll')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('claimed command executes once and reports a structured successful result', async () => {
  const identity = { serverId: 'server-003', agentToken: 'agent-token-long-enough' };
  const claimed = {
    job: { id: '123e4567-e89b-12d3-a456-426614174000' },
    envelope: {
      id: '123e4567-e89b-12d3-a456-426614174000',
      operation: OPERATIONS.DOMAIN_STAGE,
      payload: {
        primaryDomain: 'example.com',
        aliases: [],
        targetType: 'proxy',
        target: { upstreamPort: 3001 },
      },
      protocolVersion: AGENT_PROTOCOL_VERSION,
    },
  };

  let executions = 0;
  const calls = [];
  const completion = await executeClaimedCommand({
    claimed,
    baseUrl: 'http://127.0.0.1:3001',
    identity,
    execute: async (operation) => {
      executions += 1;
      assert.equal(operation, OPERATIONS.DOMAIN_STAGE);
      return { configName: 'example.com.conf', checksum: 'a'.repeat(64) };
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { data: { status: 'succeeded' } });
    },
    sleepFn: async () => {},
  });

  assert.equal(executions, 1);
  assert.equal(completion.status, 'succeeded');
  assert.equal(calls.length, 1);
  const resultBody = JSON.parse(calls[0].options.body);
  assert.equal(resultBody.status, 'succeeded');
  assert.equal(resultBody.result.checksum, 'a'.repeat(64));
});

test('failed command reports bounded safe error metadata without stack or secret fields', async () => {
  const identity = { serverId: 'server-004', agentToken: 'agent-token-long-enough' };
  const claimed = {
    job: { id: '123e4567-e89b-12d3-a456-426614174001' },
    envelope: {
      id: '123e4567-e89b-12d3-a456-426614174001',
      operation: OPERATIONS.DOMAIN_ACTIVATE,
      payload: { primaryDomain: 'example.com', checksum: 'b'.repeat(64) },
      protocolVersion: AGENT_PROTOCOL_VERSION,
    },
  };

  const calls = [];
  const completion = await executeClaimedCommand({
    claimed,
    baseUrl: 'http://127.0.0.1:3001',
    identity,
    execute: async () => {
      const error = new Error('nginx validation failed');
      error.code = 'nginx_config_invalid';
      error.secret = 'must-not-leak';
      throw error;
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { data: { status: 'failed' } });
    },
    sleepFn: async () => {},
  });

  assert.equal(completion.status, 'failed');
  const resultBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(resultBody.error, {
    code: 'nginx_config_invalid',
    message: 'nginx validation failed',
  });
  assert.equal('secret' in resultBody.error, false);
  assert.equal('stack' in resultBody.error, false);
});
