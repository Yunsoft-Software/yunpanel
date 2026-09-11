import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AGENT_PROTOCOL_VERSION, OPERATIONS } from '@yunpanel/protocol';
import {
  executeClaimedCommand,
  normalizeControlPlaneUrl,
  startControlPlaneLink,
} from '../src/control-plane-client.js';
import { saveAgentIdentity } from '../src/identity-store.js';

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

test('missing legacy identity fails closed without attempting retired enrollment HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-agent-missing-'));
  const identityFile = path.join(directory, 'identity.json');
  const calls = [];
  try {
    await assert.rejects(
      startControlPlaneLink({
        controlPlaneUrl: 'http://127.0.0.1:3001',
        identityFile,
        heartbeatMs: 10_000,
        commandPollMs: 60_000,
        mode: 'development',
        fetchImpl: async (url, options = {}) => {
          calls.push({ url, options });
          throw new Error('network must not be reached');
        },
        ...emptyInspectors,
        logger: { info() {}, error() {} },
      }),
      (error) => {
        assert.equal(error.code, 'legacy_agent_identity_required');
        assert.equal(error.message, 'Retained legacy agent requires an existing identity; new enrollment is retired');
        return true;
      },
    );
    assert.deepEqual(calls, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stored legacy identity is reused for heartbeat and command polling without enrollment traffic', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-agent-reuse-'));
  const identityFile = path.join(directory, 'identity.json');
  const calls = [];
  const identity = {
    serverId: 'server-002',
    agentToken: 'persistent-agent-token-value-long-enough',
    controlPlaneUrl: 'http://127.0.0.1:3001',
    enrolledAt: '2026-09-10T12:00:00.000Z',
  };

  try {
    await saveAgentIdentity(identityFile, identity);
    const link = await startControlPlaneLink({
      controlPlaneUrl: identity.controlPlaneUrl,
      identityFile,
      heartbeatMs: 10_000,
      commandPollMs: 60_000,
      mode: 'development',
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/commands/next')) return emptyCommandResponse();
        if (url.endsWith('/heartbeat')) return jsonResponse(200, { data: { id: identity.serverId, connectivity: 'online' } });
        throw new Error(`Unexpected request: ${url}`);
      },
      inspect: async () => ({ hostname: 'yun-test-01', memory: { totalBytes: 100 } }),
      inspectServices: async () => ({ nginx: { active: true } }),
      inspectDocker: async () => ({ installed: true, reachable: true, containers: [{ name: 'api' }] }),
      inspectNginx: async () => ({ installed: true, configs: [{ name: 'app.conf' }] }),
      logger: { info() {}, error() {} },
    });
    link.stop();

    assert.equal(link.enabled, true);
    assert.equal(link.serverId, identity.serverId);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith(`/api/servers/${identity.serverId}/heartbeat`));
    assert.ok(calls[1].url.endsWith(`/api/servers/${identity.serverId}/commands/next`));
    assert.equal(calls.some((call) => call.url.endsWith('/api/servers/enroll')), false);
    assert.equal(calls[0].options.headers.authorization, `Bearer ${identity.agentToken}`);
    assert.equal(calls[1].options.headers.authorization, `Bearer ${identity.agentToken}`);

    const heartbeatRequest = JSON.parse(calls[0].options.body);
    assert.equal(heartbeatRequest.inventory.hostname, 'yun-test-01');
    assert.equal(heartbeatRequest.inventory.docker.containers[0].name, 'api');
    assert.equal(heartbeatRequest.inventory.nginx.configs[0].name, 'app.conf');
    assert.equal(heartbeatRequest.services.nginx.active, true);
    assert.equal((await stat(identityFile)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy heartbeat and polling logs never copy remote or host exception messages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-agent-redact-'));
  const identityFile = path.join(directory, 'identity.json');
  const identity = {
    serverId: 'server-logging',
    agentToken: 'persistent-agent-token-value-long-enough',
    controlPlaneUrl: 'http://127.0.0.1:3001',
  };
  const logs = [];
  try {
    await saveAgentIdentity(identityFile, identity);
    const link = await startControlPlaneLink({
      controlPlaneUrl: identity.controlPlaneUrl,
      identityFile,
      heartbeatMs: 10_000,
      commandPollMs: 60_000,
      mode: 'development',
      inspect: async () => {
        const error = new Error('SECRET=/root/private/heartbeat-token');
        error.code = 'unknown_heartbeat_secret';
        throw error;
      },
      inspectServices: async () => ({}),
      inspectDocker: async () => ({}),
      inspectNginx: async () => ({}),
      fetchImpl: async (url) => {
        if (url.endsWith('/commands/next')) {
          return jsonResponse(500, { error: { code: 'remote_secret_code', message: 'PASSWORD=/root/private/poll-token' } });
        }
        throw new Error('heartbeat fetch must not run after inspector failure');
      },
      logger: { info() {}, error(value) { logs.push(String(value)); } },
    });
    link.stop();

    assert.deepEqual(logs, [
      '[yun-agent] heartbeat failed: heartbeat_failed',
      '[yun-agent] command polling failed: command_poll_failed',
    ]);
    assert.doesNotMatch(logs.join('\n'), /SECRET|PASSWORD|unknown_heartbeat_secret|remote_secret_code|\/root\/private|token/i);
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

test('Node mutations fetch environment just in time without placing secrets in result reporting', async () => {
  const identity = { serverId: 'server-005', agentToken: 'agent-token-long-enough' };
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const claimed = {
    job: { id: '123e4567-e89b-12d3-a456-426614174005' },
    envelope: {
      id: '123e4567-e89b-12d3-a456-426614174005',
      operation: OPERATIONS.APP_NODE_RESTART,
      payload: {
        applicationId,
        releaseId,
        runtime: { port: 3100 },
        environmentRevision: 7,
      },
      protocolVersion: AGENT_PROTOCOL_VERSION,
    },
  };

  const calls = [];
  const completion = await executeClaimedCommand({
    claimed,
    baseUrl: 'http://127.0.0.1:3001',
    identity,
    execute: async (operation, payload) => {
      assert.equal(operation, OPERATIONS.APP_NODE_RESTART);
      assert.deepEqual(payload.environment, {
        API_TOKEN: 'private-token-value',
        PUBLIC_URL: 'https://example.test',
      });
      return {
        releaseId,
        serviceName: 'yunpanel-node-test.service',
        port: 3100,
        healthPath: '/health',
        healthy: true,
        restarted: true,
      };
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith(`/api/servers/${identity.serverId}/applications/${applicationId}/environment?revision=7`)) {
        assert.equal(options.headers.authorization, `Bearer ${identity.agentToken}`);
        return jsonResponse(200, {
          environmentRevision: 7,
          data: {
            API_TOKEN: 'private-token-value',
            PUBLIC_URL: 'https://example.test',
          },
        });
      }
      return jsonResponse(200, { data: { status: 'succeeded' } });
    },
    sleepFn: async () => {},
  });

  assert.equal(completion.status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.includes('/commands/'), true);
  assert.equal(calls[1].options.body.includes('private-token-value'), false);
});

test('deploy fetches a private Git credential only for execution and never reports it', async () => {
  const identity = { serverId: 'server-006', agentToken: 'agent-token-long-enough' };
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const jobId = '123e4567-e89b-12d3-a456-426614174006';
  const secret = 'github_pat_private_deploy_value';
  const calls = [];
  const completion = await executeClaimedCommand({
    claimed: {
      job: { id: jobId },
      envelope: {
        id: jobId,
        operation: OPERATIONS.APP_STATIC_DEPLOY,
        payload: { applicationId, deploymentId: jobId },
        protocolVersion: AGENT_PROTOCOL_VERSION,
      },
    },
    baseUrl: 'http://127.0.0.1:3001',
    identity,
    execute: async (operation, payload) => {
      assert.equal(operation, OPERATIONS.APP_STATIC_DEPLOY);
      assert.deepEqual(payload.gitCredential, { type: 'github_token', token: secret });
      return { deploymentId: jobId, releaseId: jobId, commitSha: 'a'.repeat(40) };
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith(`/api/servers/${identity.serverId}/applications/${applicationId}/deployment-credential`)) {
        assert.equal(options.headers.authorization, `Bearer ${identity.agentToken}`);
        return jsonResponse(200, { data: { type: 'github_token', token: secret } });
      }
      return jsonResponse(200, { data: { status: 'succeeded' } });
    },
    sleepFn: async () => {},
  });
  assert.equal(completion.status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.body.includes(secret), false);
});

test('failed command reports authored safe error metadata without raw message, stack or secret fields', async () => {
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
      const error = new Error('nginx validation failed SECRET=/root/private/key');
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
    message: 'Nginx rejected the staged configuration.',
  });
  assert.equal('secret' in resultBody.error, false);
  assert.equal('stack' in resultBody.error, false);
  assert.doesNotMatch(calls[0].options.body, /SECRET|\/root\/private|must-not-leak/);
});

test('unknown command errors collapse to a generic legacy failure without leaking code or message', async () => {
  const identity = { serverId: 'server-006', agentToken: 'agent-token-long-enough' };
  const claimed = {
    job: { id: '123e4567-e89b-12d3-a456-426614174006' },
    envelope: {
      id: '123e4567-e89b-12d3-a456-426614174006',
      operation: OPERATIONS.DOMAIN_ACTIVATE,
      payload: { primaryDomain: 'example.com', checksum: 'c'.repeat(64) },
      protocolVersion: AGENT_PROTOCOL_VERSION,
    },
  };
  const calls = [];
  await executeClaimedCommand({
    claimed,
    baseUrl: 'http://127.0.0.1:3001',
    identity,
    execute: async () => {
      const error = new Error('SECRET=/root/private/token');
      error.code = 'secret_token_abc';
      throw error;
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { data: { status: 'failed' } });
    },
    sleepFn: async () => {},
  });

  const body = calls[0].options.body;
  assert.deepEqual(JSON.parse(body).error, {
    code: 'legacy_operation_failed',
    message: 'Legacy host operation failed. Inspect protected host diagnostics before retrying.',
  });
  assert.doesNotMatch(body, /SECRET|secret_token_abc|\/root\/private|token/);
});
