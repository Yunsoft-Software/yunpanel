import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseJobRecoveryArguments,
  runJobRecoveryCli,
} from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts only confirmed database restore recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-database-restore', serverId, jobId, '--confirm']),
    { action: 'recover-database-restore', serverId, jobId, confirm: true },
  );
  assert.throws(
    () => parseJobRecoveryArguments(['recover-database-restore', serverId, jobId]),
    /Usage/,
  );
});

test('packaged database restore recovery delegates identity and prints safe metadata only', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-database-restore', serverId, jobId, '--confirm'],
    env: { YUNPANEL_SECRET_MASTER_KEY: 'must-not-print' },
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverDatabaseRestore: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        operation: 'database.restore',
        status: 'succeeded',
        recoveryMethod: 'verified_database_restore_receipt_backups_and_live_digest',
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
  assert.match(output.join(''), /operation=database\.restore/);
  assert.match(output.join(''), /method=verified_database_restore_receipt_backups_and_live_digest/);
  assert.doesNotMatch(output.join(''), /must-not-print|dump\.sql|backupPath|dumpPath|CREATE TABLE|payload|SECRET_MASTER_KEY|committedAt/i);
});
