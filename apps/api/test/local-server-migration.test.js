import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindLocalServerForRuntime,
  inspectLocalServerMigration,
  LocalServerMigrationError,
  releaseLocalServerFromRuntime,
} from '../src/local-server-migration.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const hostname = 'host-1.example.local';

function fixture({ mode = 'agent', jobs = [], apiActive = false, agentActive = false, storedHostname = hostname } = {}) {
  let server = {
    id: serverId,
    hostname: storedHostname,
    executionMode: mode,
    localBoundAt: mode === 'local' ? '2026-09-10T00:00:00.000Z' : null,
  };
  const calls = [];
  return {
    calls,
    registry: {
      getServer: async (id) => id === serverId ? { ...server } : null,
      bindLocalServer: async ({ serverId: id, hostname: host }) => {
        calls.push(['bind', id, host]);
        server = { ...server, executionMode: 'local', localBoundAt: '2026-09-10T01:00:00.000Z' };
        return { ...server };
      },
      releaseLocalServer: async ({ serverId: id, hostname: host }) => {
        calls.push(['release', id, host]);
        server = { ...server, executionMode: 'agent', localBoundAt: null };
        return { ...server };
      },
    },
    jobRegistry: { listJobs: async ({ serverId: id }) => { calls.push(['jobs', id]); return jobs; } },
    serviceStatus: async () => { calls.push(['services']); return { apiActive, agentActive }; },
  };
}

function input(state) {
  return { serverId, hostname, registry: state.registry, jobRegistry: state.jobRegistry, serviceStatus: state.serviceStatus };
}

test('preflight reports local ownership blockers without mutating state', async () => {
  const state = fixture({ jobs: [{ status: 'queued' }, { status: 'succeeded' }], apiActive: true, agentActive: true });
  const result = await inspectLocalServerMigration(input(state));
  assert.deepEqual(result, {
    serverId,
    hostname,
    executionMode: 'agent',
    localBoundAt: null,
    apiActive: true,
    agentActive: true,
    activeJobCount: 1,
    recoveryJobCount: 0,
  });
  assert.equal(state.calls.some(([name]) => name === 'bind' || name === 'release'), false);
});

test('binding requires both panel processes stopped and an empty active queue', async () => {
  for (const [options, code] of [
    [{ apiActive: true }, 'local_migration_api_active'],
    [{ agentActive: true }, 'local_migration_agent_active'],
    [{ jobs: [{ status: 'running' }] }, 'local_migration_jobs_active'],
    [{ jobs: [{ status: 'queued' }] }, 'local_migration_jobs_active'],
  ]) {
    const state = fixture(options);
    await assert.rejects(bindLocalServerForRuntime(input(state)), (error) => error instanceof LocalServerMigrationError && error.code === code);
    assert.equal(state.calls.some(([name]) => name === 'bind'), false);
  }
});

test('binding exact host transfers ownership to local runtime once', async () => {
  const state = fixture();
  const bound = await bindLocalServerForRuntime(input(state));
  assert.equal(bound.executionMode, 'local');
  assert.deepEqual(state.calls.filter(([name]) => name === 'bind'), [['bind', serverId, hostname]]);

  const repeated = await bindLocalServerForRuntime(input(state));
  assert.equal(repeated.executionMode, 'local');
  assert.equal(state.calls.filter(([name]) => name === 'bind').length, 1);
});

test('hostname mismatch is rejected before ownership mutation', async () => {
  const state = fixture({ storedHostname: 'other-host.example.local' });
  await assert.rejects(bindLocalServerForRuntime(input(state)), (error) => error instanceof LocalServerMigrationError && error.code === 'local_server_hostname_mismatch');
  assert.equal(state.calls.some(([name]) => name === 'bind'), false);
});

test('release also requires stopped API/agent and drained queue', async () => {
  const state = fixture({ mode: 'local' });
  const released = await releaseLocalServerFromRuntime(input(state));
  assert.equal(released.executionMode, 'agent');
  assert.deepEqual(state.calls.filter(([name]) => name === 'release'), [['release', serverId, hostname]]);

  await assert.rejects(releaseLocalServerFromRuntime(input(state)), (error) => error instanceof LocalServerMigrationError && error.code === 'local_server_not_bound');
});

test('non-UUID server identity is rejected before registry access', async () => {
  const state = fixture();
  await assert.rejects(
    inspectLocalServerMigration({ ...input(state), serverId: 'server-1' }),
    (error) => error instanceof LocalServerMigrationError && error.code === 'invalid_local_server_id',
  );
  assert.equal(state.calls.length, 0);
});
