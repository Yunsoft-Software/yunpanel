import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalMigrationCliError, runLocalMigrationCommand } from '../src/local-migration-cli.js';

test('migration command creates a fresh local server without a pre-existing server UUID', async () => {
  const events = [];
  const registryFactory = ({ filePath }) => ({
    async createLocalServer(input) {
      events.push(['create', filePath, input]);
      return {
        id: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
        hostname: input.hostname,
        executionMode: 'local',
        localBoundAt: '2026-09-10T10:15:00.000Z',
      };
    },
  });
  const jobRegistryFactory = ({ filePath }) => ({
    async listJobs(filter) {
      events.push(['jobs', filePath, filter]);
      return [];
    },
  });
  const serviceStatus = async () => {
    events.push(['services']);
    return { apiActive: false, agentActive: false };
  };

  const result = await runLocalMigrationCommand({
    action: 'create',
    hostname: 'Fresh-Panel-Host',
    confirm: true,
    cwd: '/work/yunpanel',
    env: {},
    registryFactory,
    jobRegistryFactory,
    serviceStatus,
  });

  assert.deepEqual(result, {
    action: 'create',
    serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
    hostname: 'fresh-panel-host',
    executionMode: 'local',
    localBoundAt: '2026-09-10T10:15:00.000Z',
    statePaths: {
      serverStore: '/work/yunpanel/.data/server-registry.json',
      jobStore: '/work/yunpanel/.data/job-registry.json',
    },
  });
  assert.deepEqual(events, [
    ['jobs', '/work/yunpanel/.data/job-registry.json', {}],
    ['services'],
    ['create', '/work/yunpanel/.data/server-registry.json', { hostname: 'fresh-panel-host', displayName: null }],
  ]);
});

test('fresh local create requires explicit confirmation before opening state stores', async () => {
  let opened = false;
  await assert.rejects(
    runLocalMigrationCommand({
      action: 'create',
      hostname: 'fresh-panel-host',
      registryFactory: () => { opened = true; return {}; },
      jobRegistryFactory: () => { opened = true; return {}; },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    }),
    (error) => error instanceof LocalMigrationCliError && error.code === 'migration_confirmation_required',
  );
  assert.equal(opened, false);
});

test('fresh local create keeps packaged state under the control-plane root', async () => {
  let registryPath;
  let jobPath;
  const result = await runLocalMigrationCommand({
    action: 'create',
    hostname: 'packaged-host',
    confirm: true,
    packaged: true,
    cwd: '/root',
    env: {},
    registryFactory: ({ filePath }) => {
      registryPath = filePath;
      return {
        async createLocalServer(input) {
          return {
            id: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
            hostname: input.hostname,
            executionMode: 'local',
            localBoundAt: '2026-09-10T10:15:00.000Z',
          };
        },
      };
    },
    jobRegistryFactory: ({ filePath }) => {
      jobPath = filePath;
      return { async listJobs() { return []; } };
    },
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
  });

  assert.equal(registryPath, '/var/lib/yunpanel/control-plane/server-registry.json');
  assert.equal(jobPath, '/var/lib/yunpanel/control-plane/job-registry.json');
  assert.equal(result.statePaths.serverStore, registryPath);
  assert.equal(result.statePaths.jobStore, jobPath);
});
