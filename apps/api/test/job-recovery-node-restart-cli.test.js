import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const packagedPath = '/usr/lib/yunpanel/scripts/job-recovery.mjs';

test('Node restart recovery CLI requires exact action shape and confirmation', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-node-restart', serverId, jobId, '--confirm']),
    { action: 'recover-node-restart', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-node-restart', serverId, jobId]), /Usage:/);
});

test('packaged root Node restart command delegates only to Node restart recovery runtime', async () => {
  const calls = [];
  const stdout = { write(value) { calls.push(['stdout', value]); } };
  const result = await runJobRecoveryCli({
    argv: ['recover-node-restart', serverId, jobId, '--confirm'],
    filePath: packagedPath,
    uid: 0,
    env: { YUNPANEL_JOB_STORE: '/var/lib/yunpanel/control-plane/job-registry.json' },
    cwd: '/',
    recoverNodeRestart: async (input) => {
      calls.push(['recover', input]);
      return {
        serverId,
        jobId,
        operation: 'app.node.restart',
        status: 'succeeded',
        recoveryMethod: 'verified_node_restart_receipt_and_status',
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    stdout,
  });

  assert.equal(result.recoveryMethod, 'verified_node_restart_receipt_and_status');
  assert.equal(calls[0][0], 'recover');
  assert.equal(calls[0][1].packaged, true);
  assert.match(calls[1][1], /method=verified_node_restart_receipt_and_status/);
});

test('Node restart recovery mutation is unavailable outside packaged installation', async () => {
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-node-restart', serverId, jobId, '--confirm'],
      filePath: '/work/scripts/job-recovery.mjs',
      uid: 0,
      recoverNodeRestart: async () => ({}),
    }),
    /available only from the packaged YunPanel installation/,
  );
});

test('packaged Node restart recovery requires root', async () => {
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-node-restart', serverId, jobId, '--confirm'],
      filePath: packagedPath,
      uid: 1000,
      recoverNodeRestart: async () => ({}),
    }),
    /must be run as root/,
  );
});
