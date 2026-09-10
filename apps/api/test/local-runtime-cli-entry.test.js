import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPackagedRoot,
  isPackagedLocalRuntimeScript,
  parseLocalRuntimeArguments,
  runLocalRuntimeCli,
} from '../../../scripts/local-runtime.mjs';

test('local runtime CLI accepts only explicit status/bind/release syntax', () => {
  assert.deepEqual(parseLocalRuntimeArguments(['status', 'server-id']), { action: 'status', serverId: 'server-id', confirm: false });
  assert.deepEqual(parseLocalRuntimeArguments(['bind', 'server-id', '--confirm']), { action: 'bind', serverId: 'server-id', confirm: true });
  assert.throws(() => parseLocalRuntimeArguments(['bind', 'server-id']), /requires exactly --confirm/);
  assert.throws(() => parseLocalRuntimeArguments(['status', 'server-id', '--confirm']), /does not accept extra arguments/);
  assert.throws(() => parseLocalRuntimeArguments(['delete', 'server-id']), /Usage/);
});

test('packaged script detection is limited to the installed YunPanel script directory', () => {
  assert.equal(isPackagedLocalRuntimeScript('/usr/lib/yunpanel/scripts/local-runtime.mjs'), true);
  assert.equal(isPackagedLocalRuntimeScript('/work/yunpanel/scripts/local-runtime.mjs'), false);
  assert.equal(isPackagedLocalRuntimeScript('/usr/lib/yunpanel-other/scripts/local-runtime.mjs'), false);
});

test('packaged CLI requires root before executing migration', () => {
  assert.throws(() => assertPackagedRoot({ packaged: true, uid: 1000 }), /must be run as root/);
  assert.doesNotThrow(() => assertPackagedRoot({ packaged: true, uid: 0 }));
  assert.doesNotThrow(() => assertPackagedRoot({ packaged: false, uid: 1000 }));
});

test('CLI uses OS hostname input and emits the exact local server env value without secrets', async () => {
  const output = [];
  const calls = [];
  const result = await runLocalRuntimeCli({
    argv: ['bind', '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7', '--confirm'],
    env: { YUNPANEL_SECRET_MASTER_KEY: 'must-not-print' },
    hostname: 'host-1.example.local',
    filePath: '/work/yunpanel/scripts/local-runtime.mjs',
    uid: 1000,
    execute: async (input) => {
      calls.push(input);
      return {
        action: 'bind',
        serverId: input.serverId,
        hostname: input.hostname,
        executionMode: 'local',
        localBoundAt: '2026-09-10T00:00:00.000Z',
        statePaths: { serverStore: '/work/.data/server-registry.json', jobStore: '/work/.data/job-registry.json' },
      };
    },
    stdout: { write: (value) => output.push(value) },
  });
  assert.equal(result.executionMode, 'local');
  assert.equal(calls[0].hostname, 'host-1.example.local');
  assert.match(output.join(''), /YUNPANEL_LOCAL_SERVER_ID=6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7/);
  assert.doesNotMatch(output.join(''), /must-not-print/);
});
