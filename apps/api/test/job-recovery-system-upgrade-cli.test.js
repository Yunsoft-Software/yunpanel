import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const packagedPath = '/usr/lib/yunpanel/scripts/job-recovery.mjs';

test('system upgrade recovery CLI requires exact action shape and confirmation', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-system-upgrade', serverId, jobId, '--confirm']),
    { action: 'recover-system-upgrade', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-system-upgrade', serverId, jobId]), /Usage:/);
});

test('packaged root system upgrade recovery delegates only to upgrade runtime', async () => {
  const calls = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-system-upgrade', serverId, jobId, '--confirm'],
    filePath: packagedPath,
    uid: 0,
    env: { YUNPANEL_JOB_STORE: '/var/lib/yunpanel/control-plane/job-registry.json' },
    cwd: '/',
    recoverSystemUpgrade: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'system.upgrade',
        status: 'succeeded',
        upgraded: true,
        recoveryMethod: 'verified_system_upgrade_receipt_and_package_state',
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.recoveryMethod, 'verified_system_upgrade_receipt_and_package_state');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].packaged, true);
});

test('system upgrade recovery is packaged-root only', async () => {
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-system-upgrade', serverId, jobId, '--confirm'],
      filePath: packagedPath,
      uid: 1000,
      recoverSystemUpgrade: async () => ({}),
    }),
    /must be run as root/,
  );
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-system-upgrade', serverId, jobId, '--confirm'],
      filePath: '/work/scripts/job-recovery.mjs',
      uid: 0,
      recoverSystemUpgrade: async () => ({}),
    }),
    /available only from the packaged YunPanel installation/,
  );
});
