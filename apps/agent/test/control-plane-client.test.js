import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeControlPlaneUrl, startControlPlaneLink } from '../src/control-plane-client.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('control plane URL requires HTTPS outside development mode', () => {
  assert.equal(normalizeControlPlaneUrl('http://127.0.0.1:3001', 'development'), 'http://127.0.0.1:3001');
  assert.equal(normalizeControlPlaneUrl('https://panel.example.com/path', 'production'), 'https://panel.example.com');
  assert.throws(
    () => normalizeControlPlaneUrl('http://panel.example.com', 'production'),
    /must use HTTPS/,
  );
});

test('first control plane connection enrolls, protects identity and sends heartbeat', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-agent-'));
  const identityFile = path.join(directory, 'identity.json');
  const calls = [];

  const fetchImpl = async (url, options) => {
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

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const link = await startControlPlaneLink({
      controlPlaneUrl: 'http://127.0.0.1:3001',
      enrollmentToken: 'one-time-enrollment-token-value',
      identityFile,
      heartbeatMs: 10_000,
      mode: 'development',
      fetchImpl,
      inspect: async () => ({ hostname: 'yun-test-01', memory: { totalBytes: 100 } }),
      inspectServices: async () => ({ nginx: { active: true } }),
      logger: { info() {}, error() {} },
    });

    link.stop();

    assert.equal(link.enabled, true);
    assert.equal(link.serverId, 'server-001');
    assert.equal(calls.length, 2);

    const enrollmentRequest = JSON.parse(calls[0].options.body);
    assert.equal(enrollmentRequest.token, 'one-time-enrollment-token-value');

    const heartbeatRequest = JSON.parse(calls[1].options.body);
    assert.equal(heartbeatRequest.inventory.hostname, 'yun-test-01');
    assert.equal(heartbeatRequest.services.nginx.active, true);
    assert.equal(calls[1].options.headers.authorization, 'Bearer agent-token-value-that-is-long-enough');

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
    return jsonResponse(200, { data: { id: 'server-002', connectivity: 'online' } });
  };

  try {
    const first = await startControlPlaneLink({
      controlPlaneUrl: 'http://127.0.0.1:3001',
      enrollmentToken: 'first-use-token-long-enough',
      identityFile,
      heartbeatMs: 10_000,
      mode: 'development',
      fetchImpl: initialFetch,
      inspect: async () => ({}),
      inspectServices: async () => ({}),
      logger: { info() {}, error() {} },
    });
    first.stop();

    const second = await startControlPlaneLink({
      controlPlaneUrl: 'http://127.0.0.1:3001',
      identityFile,
      heartbeatMs: 10_000,
      mode: 'development',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(200, { data: { id: 'server-002', connectivity: 'online' } });
      },
      inspect: async () => ({}),
      inspectServices: async () => ({}),
      logger: { info() {}, error() {} },
    });
    second.stop();

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/servers/server-002/heartbeat'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
