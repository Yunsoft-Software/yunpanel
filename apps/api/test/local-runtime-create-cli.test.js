import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalRuntimeArguments, runLocalRuntimeCli } from '../../../scripts/local-runtime.mjs';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

test('local runtime CLI accepts only explicit confirmed create syntax', () => {
  assert.deepEqual(parseLocalRuntimeArguments(['create', '--confirm']), { action: 'create', confirm: true });
  assert.throws(() => parseLocalRuntimeArguments(['create']), /requires exactly --confirm/);
  assert.throws(() => parseLocalRuntimeArguments(['create', 'server-id', '--confirm']), /requires exactly --confirm/);
  assert.throws(() => parseLocalRuntimeArguments(['create', '--force']), /requires exactly --confirm/);
});

test('fresh create uses OS hostname and prints the exact local runtime id without credentials', async () => {
  const calls = [];
  const output = [];
  const result = await runLocalRuntimeCli({
    argv: ['create', '--confirm'],
    env: { YUN_AGENT_TOKEN: 'must-not-print', YUNPANEL_SECRET_MASTER_KEY: 'also-hidden' },
    hostname: 'fresh-host.example.local',
    filePath: '/work/yunpanel/scripts/local-runtime.mjs',
    uid: 1000,
    execute: async (input) => {
      calls.push(input);
      return {
        action: 'create',
        serverId,
        hostname: input.hostname,
        executionMode: 'local',
        localBoundAt: '2026-09-10T10:30:00.000Z',
        statePaths: {
          serverStore: '/work/yunpanel/.data/server-registry.json',
          jobStore: '/work/yunpanel/.data/job-registry.json',
        },
      };
    },
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'create');
  assert.equal(calls[0].confirm, true);
  assert.equal(calls[0].hostname, 'fresh-host.example.local');
  assert.equal(result.serverId, serverId);
  assert.match(output.join(''), new RegExp(`YUNPANEL_LOCAL_SERVER_ID=${serverId}`));
  assert.match(output.join(''), /No legacy agent credential was created/);
  assert.doesNotMatch(output.join(''), /must-not-print|also-hidden|YUN_AGENT_TOKEN|SECRET_MASTER_KEY/);
});

test('packaged fresh create requires root before executing migration', async () => {
  let executed = false;
  await assert.rejects(
    runLocalRuntimeCli({
      argv: ['create', '--confirm'],
      hostname: 'fresh-host.example.local',
      filePath: '/usr/lib/yunpanel/scripts/local-runtime.mjs',
      uid: 1000,
      execute: async () => { executed = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(executed, false);
});
