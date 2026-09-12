import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseJobRecoveryArguments,
  runJobRecoveryCli,
} from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts explicit confirmed Roundcube recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-roundcube-config', serverId, jobId, '--confirm']),
    { action: 'recover-roundcube-config', serverId, jobId, confirm: true },
  );
  assert.throws(
    () => parseJobRecoveryArguments(['recover-roundcube-config', serverId, jobId]),
    /Usage/,
  );
});

test('packaged Roundcube recovery delegates exact identity and prints only safe completion metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-roundcube-config', serverId, jobId, '--confirm'],
    env: { YUNPANEL_SECRET_MASTER_KEY: 'must-not-print' },
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverRoundcubeConfig: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        operation: 'roundcube.config.apply',
        status: 'succeeded',
        recoveryMethod: 'verified_roundcube_receipt_and_active_host_state',
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
  assert.match(output.join(''), /operation=roundcube\.config\.apply/);
  assert.match(output.join(''), /method=verified_roundcube_receipt_and_active_host_state/);
  assert.doesNotMatch(output.join(''), /must-not-print|SECRET_MASTER_KEY|payload|desKey|config\.inc|result|error/i);
});
