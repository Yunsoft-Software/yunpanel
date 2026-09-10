import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMigrationServiceStatus,
  LocalMigrationCliError,
  resolveLocalMigrationPaths,
  runLocalMigrationCommand,
} from '../src/local-migration-cli.js';
import { LocalServerMigrationError } from '../src/local-server-migration.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const hostname = 'host-1.example.local';

function factories({ mode = 'agent', jobs = [] } = {}) {
  let server = { id: serverId, hostname, executionMode: mode, localBoundAt: mode === 'local' ? '2026-09-10T00:00:00.000Z' : null };
  const created = [];
  return {
    created,
    registryFactory(options) {
      created.push(['registry', options]);
      return {
        getServer: async (id) => id === serverId ? { ...server } : null,
        bindLocalServer: async () => {
          server = { ...server, executionMode: 'local', localBoundAt: '2026-09-10T01:00:00.000Z' };
          return { ...server };
        },
        releaseLocalServer: async () => {
          server = { ...server, executionMode: 'agent', localBoundAt: null };
          return { ...server };
        },
      };
    },
    jobRegistryFactory(options) {
      created.push(['jobs', options]);
      return { listJobs: async () => jobs };
    },
  };
}

test('packaged migration defaults to private control-plane state paths while development stays local', () => {
  assert.deepEqual(resolveLocalMigrationPaths({ packaged: true, env: {}, cwd: '/usr/lib/yunpanel' }), {
    serverStore: '/var/lib/yunpanel/control-plane/server-registry.json',
    jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
  });
  assert.deepEqual(resolveLocalMigrationPaths({ packaged: false, env: {}, cwd: '/work/yunpanel' }), {
    serverStore: '/work/yunpanel/.data/server-registry.json',
    jobStore: '/work/yunpanel/.data/job-registry.json',
  });
});

test('packaged migration rejects relative or outside-control-plane state overrides', () => {
  for (const env of [
    { YUNPANEL_SERVER_STORE: '.data/server.json' },
    { YUNPANEL_JOB_STORE: '/tmp/jobs.json' },
  ]) {
    assert.throws(
      () => resolveLocalMigrationPaths({ packaged: true, env, cwd: '/usr/lib/yunpanel' }),
      (error) => error instanceof LocalMigrationCliError && ['packaged_state_path_must_be_absolute', 'packaged_state_path_outside_control_plane'].includes(error.code),
    );
  }
});

test('systemd status inspector uses only the fixed panel units and treats transitional states as active', async () => {
  const calls = [];
  const status = createMigrationServiceStatus({
    run: async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: args[1] === 'yunpanel-api.service' ? 'inactive\n' : 'deactivating\n' };
    },
  });
  assert.deepEqual(await status(), {
    apiActive: false,
    agentActive: true,
    states: { api: 'inactive', agent: 'deactivating' },
  });
  assert.deepEqual(calls.map((call) => call[2]), ['yunpanel-api.service', 'yun-agent.service']);
  assert.ok(calls.every((call) => call[0] === '/usr/bin/systemctl' && call[1] === 'show'));
});

test('service status inspection fails closed on command or state ambiguity', async () => {
  const unavailable = createMigrationServiceStatus({ run: async () => { throw new Error('systemctl failed'); } });
  await assert.rejects(unavailable(), (error) => error instanceof LocalMigrationCliError && error.code === 'migration_service_status_unavailable');
  const invalid = createMigrationServiceStatus({ run: async () => ({ stdout: 'mystery\n' }) });
  await assert.rejects(invalid(), (error) => error instanceof LocalMigrationCliError && error.code === 'migration_service_status_invalid');
});

test('status command opens the resolved stores but never mutates ownership', async () => {
  const state = factories({ jobs: [{ status: 'succeeded' }] });
  const result = await runLocalMigrationCommand({
    action: 'status', serverId, hostname, env: {}, packaged: true,
    registryFactory: state.registryFactory,
    jobRegistryFactory: state.jobRegistryFactory,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
  });
  assert.equal(result.executionMode, 'agent');
  assert.equal(result.activeJobCount, 0);
  assert.equal(result.statePaths.serverStore, '/var/lib/yunpanel/control-plane/server-registry.json');
  assert.deepEqual(state.created, [
    ['registry', { filePath: '/var/lib/yunpanel/control-plane/server-registry.json' }],
    ['jobs', { filePath: '/var/lib/yunpanel/control-plane/job-registry.json' }],
  ]);
});

test('bind/release require explicit confirmation before opening state', async () => {
  const state = factories();
  await assert.rejects(
    runLocalMigrationCommand({ action: 'bind', serverId, hostname, registryFactory: state.registryFactory, jobRegistryFactory: state.jobRegistryFactory, serviceStatus: async () => ({ apiActive: false, agentActive: false }) }),
    (error) => error instanceof LocalMigrationCliError && error.code === 'migration_confirmation_required',
  );
  assert.equal(state.created.length, 0);
});

test('bind delegates stopped-process and drained-queue enforcement to the migration guard', async () => {
  const blocked = factories({ jobs: [{ status: 'queued' }] });
  await assert.rejects(
    runLocalMigrationCommand({
      action: 'bind', serverId, hostname, confirm: true,
      registryFactory: blocked.registryFactory,
      jobRegistryFactory: blocked.jobRegistryFactory,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    }),
    (error) => error instanceof LocalServerMigrationError && error.code === 'local_migration_jobs_active',
  );

  const clean = factories();
  const bound = await runLocalMigrationCommand({
    action: 'bind', serverId, hostname, confirm: true,
    registryFactory: clean.registryFactory,
    jobRegistryFactory: clean.jobRegistryFactory,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
  });
  assert.equal(bound.executionMode, 'local');
  assert.equal(bound.serverId, serverId);
});
