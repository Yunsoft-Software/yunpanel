import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalServerForRuntime,
  LocalServerMigrationError,
} from '../src/local-server-migration.js';

function fixture({ jobs = [], apiActive = false, agentActive = false } = {}) {
  const events = [];
  const registry = {
    async createLocalServer(input) {
      events.push(['create', input]);
      return {
        id: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
        hostname: input.hostname,
        name: input.displayName ?? input.hostname,
        executionMode: 'local',
        localBoundAt: '2026-09-10T10:00:00.000Z',
      };
    },
  };
  const jobRegistry = {
    async listJobs(filter) {
      events.push(['jobs', filter]);
      return structuredClone(jobs);
    },
  };
  const serviceStatus = async () => {
    events.push(['services']);
    return { apiActive, agentActive };
  };
  return { events, registry, jobRegistry, serviceStatus };
}

async function create(fx, overrides = {}) {
  return createLocalServerForRuntime({
    hostname: 'Fresh-Host.Example.Local',
    displayName: 'Fresh Host',
    registry: fx.registry,
    jobRegistry: fx.jobRegistry,
    serviceStatus: fx.serviceStatus,
    ...overrides,
  });
}

test('fresh local bootstrap creates one normalized credentialless local identity after safe preflight', async () => {
  const fx = fixture();
  const server = await create(fx);
  assert.equal(server.hostname, 'fresh-host.example.local');
  assert.equal(server.executionMode, 'local');
  assert.deepEqual(fx.events, [
    ['jobs', {}],
    ['services'],
    ['create', { hostname: 'fresh-host.example.local', displayName: 'Fresh Host' }],
  ]);
});

test('fresh local bootstrap refuses active API or legacy agent before creating state', async () => {
  for (const [input, code] of [
    [{ apiActive: true }, 'local_migration_api_active'],
    [{ agentActive: true }, 'local_migration_agent_active'],
  ]) {
    const fx = fixture(input);
    await assert.rejects(
      create(fx),
      (error) => error instanceof LocalServerMigrationError && error.code === code,
    );
    assert.equal(fx.events.some(([event]) => event === 'create'), false);
  }
});

test('fresh local bootstrap refuses any queued or running durable work globally', async () => {
  for (const status of ['queued', 'running']) {
    const fx = fixture({ jobs: [{ id: `job-${status}`, serverId: 'other-server', status }] });
    await assert.rejects(
      create(fx),
      (error) => error instanceof LocalServerMigrationError && error.code === 'local_migration_jobs_active',
    );
    assert.equal(fx.events.some(([event]) => event === 'create'), false);
  }
});

test('terminal historical jobs do not block fresh local bootstrap', async () => {
  const fx = fixture({
    jobs: [
      { id: 'job-succeeded', serverId: 'old-server', status: 'succeeded' },
      { id: 'job-failed', serverId: 'old-server', status: 'failed' },
      { id: 'job-cancelled', serverId: 'old-server', status: 'cancelled' },
    ],
  });
  const server = await create(fx, { displayName: null });
  assert.equal(server.executionMode, 'local');
  assert.equal(fx.events.some(([event]) => event === 'create'), true);
});

test('bootstrap validates hostname and dependencies before any mutation', async () => {
  const fx = fixture();
  await assert.rejects(
    create(fx, { hostname: '../bad-host' }),
    (error) => error instanceof LocalServerMigrationError && error.code === 'invalid_local_hostname',
  );
  assert.deepEqual(fx.events, []);

  await assert.rejects(
    createLocalServerForRuntime({
      hostname: 'valid-host',
      registry: {},
      jobRegistry: fx.jobRegistry,
      serviceStatus: fx.serviceStatus,
    }),
    (error) => error instanceof LocalServerMigrationError && error.code === 'local_migration_registry_invalid',
  );
});
