import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseJobRecoveryArguments,
  runJobRecoveryCli,
} from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts explicit confirmed mail data recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-mail-data', serverId, jobId, '--confirm']),
    { action: 'recover-mail-data', serverId, jobId, confirm: true },
  );
  assert.throws(
    () => parseJobRecoveryArguments(['recover-mail-data', serverId, jobId]),
    /Usage/,
  );
});

test('packaged mail data recovery delegates exact identity and prints safe completion metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-mail-data', serverId, jobId, '--confirm'],
    env: {},
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverMailData: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        operation: 'mail.data.restore',
        status: 'succeeded',
        recoveryMethod: 'verified_mail_data_restore_receipt_backup_and_live_state',
        reconciled: true,
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    recoveryAudit: () => {},
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    { serverId: calls[0].serverId, jobId: calls[0].jobId, packaged: calls[0].packaged, cwd: calls[0].cwd },
    { serverId, jobId, packaged: true, cwd: '/root' },
  );
  assert.equal(result.reconciled, true);
  assert.match(output.join(''), /operation=mail\.data\.restore/);
  assert.match(output.join(''), /method=verified_mail_data_restore_receipt_backup_and_live_state/);
  assert.doesNotMatch(output.join(''), /payload|sourcePath|dataPath|result|error/i);
});