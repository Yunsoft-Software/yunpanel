import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalRuntimeArguments, runLocalRuntimeCli } from '../../../scripts/local-runtime.mjs';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

test('local runtime CLI accepts validation as an exact read-only server action', () => {
  assert.deepEqual(
    parseLocalRuntimeArguments(['validate', serverId]),
    { action: 'validate', serverId, confirm: false },
  );
  assert.throws(() => parseLocalRuntimeArguments(['validate']), /Usage:/);
  assert.throws(() => parseLocalRuntimeArguments(['validate', serverId, '--confirm']), /does not accept extra arguments/);
  assert.throws(() => parseLocalRuntimeArguments(['validate', serverId, '--backup-dir', '/tmp/x']), /does not accept extra arguments/);
});

test('validation bypasses backup verification and prints only safe health metadata', async () => {
  let verificationCalls = 0;
  const calls = [];
  const output = [];
  const result = await runLocalRuntimeCli({
    argv: ['validate', serverId],
    env: { YUN_AGENT_TOKEN: 'legacy-secret', YUNPANEL_SECRET_MASTER_KEY: 'master-secret' },
    hostname: 'host-1.example.local',
    filePath: '/usr/lib/yunpanel/scripts/local-runtime.mjs',
    uid: 0,
    verifyBackup: async () => {
      verificationCalls += 1;
      throw new Error('validate must not verify backup');
    },
    execute: async (input) => {
      calls.push(input);
      return {
        action: 'validate',
        validated: true,
        serverId,
        hostname: input.hostname,
        executionMode: 'local',
        localBoundAt: '2026-09-10T16:55:00.000Z',
        connectivity: 'online',
        lastSeenAt: '2026-09-10T17:00:00.000Z',
        localRuntimeVersion: '0.4.0',
        apiState: 'active',
        agentState: 'inactive',
        activeJobCount: 0,
        recoveryJobCount: 0,
        inventoryPresent: true,
        servicesPresent: true,
        statePaths: {
          serverStore: '/var/lib/yunpanel/control-plane/server-registry.json',
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
        },
      };
    },
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'validate');
  assert.equal(calls[0].confirm, false);
  assert.equal(result.validated, true);
  const text = output.join('');
  assert.match(text, /validation=passed/);
  assert.match(text, /executionMode=local/);
  assert.match(text, /connectivity=online/);
  assert.match(text, /apiState=active/);
  assert.match(text, /agentState=inactive/);
  assert.match(text, /activeJobs=0/);
  assert.match(text, /recoveryJobs=0/);
  assert.match(text, /inventoryPresent=true/);
  assert.match(text, /servicesPresent=true/);
  assert.doesNotMatch(text, /legacy-secret|master-secret|YUN_AGENT_TOKEN|SECRET_MASTER_KEY/);
});

test('packaged validation still requires root before opening migration state', async () => {
  let executed = false;
  await assert.rejects(
    runLocalRuntimeCli({
      argv: ['validate', serverId],
      hostname: 'host-1.example.local',
      filePath: '/usr/lib/yunpanel/scripts/local-runtime.mjs',
      uid: 1000,
      execute: async () => { executed = true; return {}; },
      verifyBackup: async () => { throw new Error('must not run'); },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(executed, false);
});
