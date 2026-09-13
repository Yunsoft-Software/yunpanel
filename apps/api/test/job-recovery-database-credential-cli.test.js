import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseJobRecoveryArguments,
  runJobRecoveryCli,
} from '../../../scripts/job-recovery.mjs';

const serverId = '12345678-1234-4234-8234-123456789012';
const jobId = 'database-credential-job-0001';

test('job recovery CLI accepts explicit confirmed database credential recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-database-credential', serverId, jobId, '--confirm']),
    { action: 'recover-database-credential', serverId, jobId, confirm: true },
  );
  assert.throws(
    () => parseJobRecoveryArguments(['recover-database-credential', serverId, jobId]),
    /Usage/,
  );
});

test('packaged database credential recovery delegates exact identity and prints safe metadata only', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-database-credential', serverId, jobId, '--confirm'],
    env: { YUNPANEL_SECRET_MASTER_KEY: 'must-not-print' },
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverDatabaseCredential: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        operation: 'database.credential.apply',
        status: 'succeeded',
        recoveryMethod: 'verified_database_credential_receipt_marker_and_grants',
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
  assert.match(output.join(''), /operation=database\.credential\.apply/);
  assert.match(output.join(''), /method=verified_database_credential_receipt_marker_and_grants/);
  assert.doesNotMatch(output.join(''), /must-not-print|SECRET_MASTER_KEY|payload|password|privileges|result|error/i);
});
