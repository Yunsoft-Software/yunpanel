import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalServerMigrationError,
  validateLocalServerRuntime,
} from '../src/local-server-migration.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const hostname = 'host-1.example.local';
const lastSeenAt = '2026-09-10T17:00:00.000Z';

function healthyServer(overrides = {}) {
  return {
    id: serverId,
    hostname,
    executionMode: 'local',
    localBoundAt: '2026-09-10T16:55:00.000Z',
    connectivity: 'online',
    lastSeenAt,
    localRuntimeVersion: '0.4.0',
    inventory: { hostname, mode: 'local', memory: { totalBytes: 1024 } },
    services: { nginx: { installed: true, active: true } },
    ...overrides,
  };
}

function fixture({
  server = healthyServer(),
  jobs = [],
  recoveryJobs = [],
  apiState = 'active',
  agentState = 'inactive',
} = {}) {
  const calls = [];
  return {
    calls,
    input: {
      serverId,
      hostname,
      registry: {
        async getServer(id) {
          calls.push(['getServer', id]);
          return id === serverId ? server : null;
        },
        async bindLocalServer() {
          calls.push(['bind']);
          throw new Error('validation must not bind');
        },
        async releaseLocalServer() {
          calls.push(['release']);
          throw new Error('validation must not release');
        },
      },
      jobRegistry: {
        async listJobs(filter) {
          calls.push(['jobs', filter]);
          return jobs;
        },
        recovery() {
          calls.push(['recovery']);
          return { jobs: recoveryJobs };
        },
      },
      serviceStatus: async () => {
        calls.push(['services']);
        return {
          apiActive: apiState === 'active',
          agentActive: !['inactive', 'failed'].includes(agentState),
          states: { api: apiState, agent: agentState },
        };
      },
    },
  };
}

async function expectFailure(options, code) {
  const state = fixture(options);
  await assert.rejects(
    validateLocalServerRuntime(state.input),
    (error) => error instanceof LocalServerMigrationError && error.code === code,
  );
  assert.equal(state.calls.some(([name]) => name === 'bind' || name === 'release'), false);
}

test('post-migration validation requires exact local ownership, healthy consumers and a fresh local snapshot', async () => {
  const state = fixture();
  const result = await validateLocalServerRuntime(state.input);
  assert.deepEqual(result, {
    validated: true,
    serverId,
    hostname,
    executionMode: 'local',
    localBoundAt: '2026-09-10T16:55:00.000Z',
    connectivity: 'online',
    lastSeenAt,
    localRuntimeVersion: '0.4.0',
    apiState: 'active',
    agentState: 'inactive',
    activeJobCount: 0,
    recoveryJobCount: 0,
    inventoryPresent: true,
    servicesPresent: true,
  });
  assert.equal(state.calls.some(([name]) => name === 'bind' || name === 'release'), false);
});

test('post-migration validation rejects ownership and binding drift', async () => {
  await expectFailure({ server: healthyServer({ executionMode: 'agent' }) }, 'local_validation_not_bound');
  await expectFailure({ server: healthyServer({ localBoundAt: null }) }, 'local_validation_binding_invalid');
});

test('post-migration validation requires API active and legacy agent exactly inactive', async () => {
  await expectFailure({ apiState: 'inactive' }, 'local_validation_api_not_active');
  await expectFailure({ apiState: 'failed' }, 'local_validation_api_not_active');
  await expectFailure({ agentState: 'active' }, 'local_validation_agent_not_inactive');
  await expectFailure({ agentState: 'failed' }, 'local_validation_agent_not_inactive');
});

test('post-migration validation refuses active or unresolved durable work', async () => {
  await expectFailure({ jobs: [{ status: 'queued' }] }, 'local_validation_jobs_active');
  await expectFailure({ jobs: [{ status: 'running' }] }, 'local_validation_jobs_active');
  await expectFailure({ recoveryJobs: [{ jobId: 'job-1', serverId }] }, 'local_validation_recovery_pending');
});

test('post-migration validation requires a current local runtime snapshot', async () => {
  await expectFailure({ server: healthyServer({ connectivity: 'offline' }) }, 'local_validation_snapshot_stale');
  await expectFailure({ server: healthyServer({ lastSeenAt: null }) }, 'local_validation_snapshot_stale');
  await expectFailure({ server: healthyServer({ localRuntimeVersion: null }) }, 'local_validation_runtime_version_invalid');
  await expectFailure({ server: healthyServer({ localRuntimeVersion: 'bad\nversion' }) }, 'local_validation_runtime_version_invalid');
});

test('post-migration validation binds inventory to the exact host and local execution mode', async () => {
  await expectFailure({ server: healthyServer({ inventory: null }) }, 'local_validation_inventory_invalid');
  await expectFailure({ server: healthyServer({ inventory: { hostname: 'other.example.local', mode: 'local' } }) }, 'local_validation_inventory_invalid');
  await expectFailure({ server: healthyServer({ inventory: { hostname, mode: 'agent' } }) }, 'local_validation_inventory_invalid');
  await expectFailure({ server: healthyServer({ inventory: { hostname: null, mode: 'local' } }) }, 'local_validation_inventory_invalid');
});

test('post-migration validation requires the service snapshot produced by the local runtime', async () => {
  await expectFailure({ server: healthyServer({ services: null }) }, 'local_validation_services_invalid');
  await expectFailure({ server: healthyServer({ services: [] }) }, 'local_validation_services_invalid');
});
