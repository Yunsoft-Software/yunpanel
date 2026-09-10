import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts only explicitly confirmed read-only running recovery syntax', () => {
  assert.deepEqual(parseJobRecoveryArguments(['recover-readonly', serverId, jobId, '--confirm']), {
    action: 'recover-readonly', serverId, jobId, confirm: true,
  });
  assert.throws(() => parseJobRecoveryArguments(['recover-readonly', serverId, jobId]), /Usage/);
  assert.throws(() => parseJobRecoveryArguments(['recover-readonly', serverId, jobId, '--force']), /Usage/);
});

test('running recovery is unavailable from an unpackaged source checkout', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-readonly', serverId, jobId, '--confirm'],
      filePath: '/work/yunpanel/scripts/job-recovery.mjs',
      uid: 0,
      recoverRunning: async () => { called = true; },
      stdout: { write() {} },
    }),
    /only from the packaged YunPanel installation/,
  );
  assert.equal(called, false);
});

test('packaged root running recovery forwards exact identity and prints only safe metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-readonly', serverId, jobId, '--confirm'],
    env: { YUNPANEL_SECRET_MASTER_KEY: 'PRIVATE_MASTER_KEY' },
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverRunning: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        operation: 'system.packages.inspect',
        status: 'succeeded',
        recoveryMethod: 'safe_read_only_reexecution',
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual({ serverId: calls[0].serverId, jobId: calls[0].jobId }, { serverId, jobId });
  assert.equal(calls[0].packaged, true);
  assert.equal(calls[0].cwd, '/root');
  assert.equal(result.recoveryMethod, 'safe_read_only_reexecution');
  assert.match(output.join(''), /operation=system\.packages\.inspect/);
  assert.match(output.join(''), /method=safe_read_only_reexecution/);
  assert.doesNotMatch(output.join(''), /PRIVATE_MASTER_KEY|SECRET_MASTER_KEY|payload|result|error/i);
});

test('packaged running recovery rejects non-root callers before invoking recovery runtime', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-readonly', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      recoverRunning: async () => { called = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(called, false);
});
