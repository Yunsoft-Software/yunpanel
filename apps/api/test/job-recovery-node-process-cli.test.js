import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const packagedPath = '/usr/lib/yunpanel/scripts/job-recovery.mjs';

test('Node process recovery CLI requires exact action shape and confirmation', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-node-process', serverId, jobId, '--confirm']),
    { action: 'recover-node-process', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-node-process', serverId, jobId]), /Usage:/);
});

test('packaged root Node process command delegates only to Node process recovery runtime', async () => {
  const calls = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-node-process', serverId, jobId, '--confirm'],
    filePath: packagedPath,
    uid: 0,
    env: { YUNPANEL_JOB_STORE: '/var/lib/yunpanel/control-plane/job-registry.json' },
    cwd: '/',
    recoverNodeProcess: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'app.node.process',
        status: 'succeeded',
        recoveryMethod: 'verified_node_process_state',
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    stdout: { write(value) { calls.push(value); } },
  });
  assert.equal(result.recoveryMethod, 'verified_node_process_state');
  assert.equal(calls[0].packaged, true);
  assert.match(calls[1], /method=verified_node_process_state/);
});

test('Node process recovery mutation is unavailable outside packaged installation and requires root', async () => {
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-node-process', serverId, jobId, '--confirm'], filePath: '/work/scripts/job-recovery.mjs', uid: 0,
      recoverNodeProcess: async () => ({}),
    }),
    /available only from the packaged YunPanel installation/,
  );
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-node-process', serverId, jobId, '--confirm'], filePath: packagedPath, uid: 1000,
      recoverNodeProcess: async () => ({}),
    }),
    /must be run as root/,
  );
});
