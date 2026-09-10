import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalMigrationCommand } from '../src/local-migration-cli.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const hostname = 'host-1.example.local';

function server(overrides = {}) {
  return {
    id: serverId,
    hostname,
    executionMode: 'local',
    localBoundAt: '2026-09-10T16:55:00.000Z',
    connectivity: 'online',
    lastSeenAt: '2026-09-10T17:00:00.000Z',
    localRuntimeVersion: '0.4.0',
    inventory: { hostname, mode: 'local' },
    services: { nginx: { active: true } },
    ...overrides,
  };
}

function dependencies(events, { serverValue = server() } = {}) {
  return {
    registryFactory: ({ filePath }) => ({
      async getServer(id) {
        events.push(['server', filePath, id]);
        return serverValue;
      },
      async bindLocalServer() { throw new Error('must not bind'); },
      async releaseLocalServer() { throw new Error('must not release'); },
    }),
    jobRegistryFactory: ({ filePath }) => ({
      async listJobs(filter) {
        events.push(['jobs', filePath, filter]);
        return [];
      },
      recovery() {
        events.push(['recovery', filePath]);
        return { jobs: [] };
      },
    }),
    serviceStatus: async () => {
      events.push(['services']);
      return {
        apiActive: true,
        agentActive: false,
        states: { api: 'active', agent: 'inactive' },
      };
    },
  };
}

test('validation action reads packaged state then requires loopback API health', async () => {
  const events = [];
  const result = await runLocalMigrationCommand({
    action: 'validate',
    serverId,
    hostname,
    confirm: false,
    packaged: true,
    cwd: '/root',
    env: { YUNPANEL_API_HOST: '127.0.0.1', YUNPANEL_API_PORT: '3001' },
    expectedRuntimeVersion: '0.4.0',
    ...dependencies(events),
    apiHealthCheck: async ({ env }) => {
      events.push(['health', env.YUNPANEL_API_HOST, env.YUNPANEL_API_PORT]);
      return { healthy: true, host: '127.0.0.1', port: 3001, statusCode: 200 };
    },
  });

  assert.equal(result.action, 'validate');
  assert.equal(result.validated, true);
  assert.deepEqual(result.apiHealth, { healthy: true, statusCode: 200 });
  assert.equal(result.serverId, serverId);
  assert.equal(result.apiState, 'active');
  assert.equal(result.agentState, 'inactive');
  assert.deepEqual(result.statePaths, {
    serverStore: '/var/lib/yunpanel/control-plane/server-registry.json',
    jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
  });
  assert.deepEqual(events, [
    ['server', '/var/lib/yunpanel/control-plane/server-registry.json', serverId],
    ['jobs', '/var/lib/yunpanel/control-plane/job-registry.json', { serverId }],
    ['services'],
    ['recovery', '/var/lib/yunpanel/control-plane/job-registry.json'],
    ['health', '127.0.0.1', '3001'],
  ]);
});

test('failed state validation prevents the HTTP health probe from running', async () => {
  const events = [];
  let healthCalls = 0;
  await assert.rejects(
    runLocalMigrationCommand({
      action: 'validate',
      serverId,
      hostname,
      packaged: true,
      cwd: '/root',
      env: {},
      expectedRuntimeVersion: '0.4.0',
      ...dependencies(events, { serverValue: server({ connectivity: 'offline' }) }),
      apiHealthCheck: async () => {
        healthCalls += 1;
        return { healthy: true, host: '127.0.0.1', port: 3001, statusCode: 200 };
      },
    }),
    { code: 'local_validation_snapshot_stale' },
  );
  assert.equal(healthCalls, 0);
});

test('stale local runtime version is rejected before the HTTP health probe', async () => {
  const events = [];
  let healthCalls = 0;
  await assert.rejects(
    runLocalMigrationCommand({
      action: 'validate',
      serverId,
      hostname,
      packaged: true,
      cwd: '/root',
      env: {},
      expectedRuntimeVersion: '0.4.1',
      ...dependencies(events),
      apiHealthCheck: async () => {
        healthCalls += 1;
        return { healthy: true, host: '127.0.0.1', port: 3001, statusCode: 200 };
      },
    }),
    { code: 'local_validation_runtime_version_mismatch' },
  );
  assert.equal(healthCalls, 0);
});

test('unexpected health adapter failures are redacted', async () => {
  const events = [];
  await assert.rejects(
    runLocalMigrationCommand({
      action: 'validate',
      serverId,
      hostname,
      packaged: true,
      cwd: '/root',
      env: {},
      expectedRuntimeVersion: '0.4.0',
      ...dependencies(events),
      apiHealthCheck: async () => { throw new Error('SECRET=/root/private/api.sock'); },
    }),
    (error) => {
      assert.equal(error.code, 'local_validation_api_health_failed');
      assert.doesNotMatch(error.message, /SECRET|\/root\/private|api\.sock/i);
      return true;
    },
  );
});
