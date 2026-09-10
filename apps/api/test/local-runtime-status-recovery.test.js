import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalRuntimeCli } from '../../../scripts/local-runtime.mjs';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

test('local runtime status prints unresolved durable recovery count', async () => {
  const output = [];
  await runLocalRuntimeCli({
    argv: ['status', serverId],
    hostname: 'host-1.example.local',
    filePath: '/work/yunpanel/scripts/local-runtime.mjs',
    uid: 1000,
    execute: async () => ({
      action: 'status',
      serverId,
      hostname: 'host-1.example.local',
      executionMode: 'agent',
      apiActive: false,
      agentActive: false,
      activeJobCount: 0,
      recoveryJobCount: 2,
      statePaths: {
        serverStore: '/work/yunpanel/.data/server-registry.json',
        jobStore: '/work/yunpanel/.data/job-registry.json',
      },
    }),
    stdout: { write: (value) => output.push(value) },
  });
  assert.match(output.join(''), /^recoveryJobs=2$/m);
  assert.match(output.join(''), /^activeJobs=0$/m);
});
