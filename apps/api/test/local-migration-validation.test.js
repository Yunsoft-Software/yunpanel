import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalMigrationCommand } from '../src/local-migration-cli.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const hostname = 'host-1.example.local';

function server() {
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
  };
}

test('validation action reads packaged state without requiring ownership confirmation', async () => {
  const events = [];
  const result = await runLocalMigrationCommand({
    action: 'validate',
    serverId,
    hostname,
    confirm: false,
    packaged: true,
    cwd: '/root',
    env: {},
    registryFactory: ({ filePath }) => ({
      async getServer(id) {
        events.push(['server', filePath, id]);
        return server();
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
  });

  assert.equal(result.action, 'validate');
  assert.equal(result.validated, true);
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
  ]);
});
