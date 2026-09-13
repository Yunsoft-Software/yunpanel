import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseJobRecoveryArguments,
  runJobRecoveryCli,
} from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts only confirmed database backup recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-database-backup', serverId, jobId, '--confirm']),
    { action: 'recover-database-backup', serverId, jobId, confirm: true },
  );
  assert.throws(
    () => parseJobRecoveryArguments(['recover-database-backup', serverId, jobId]),
    /Usage/,
  );
});

test('packaged database backup recovery delegates identity and prints safe metadata only', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-database-backup', serverId, jobId, '--confirm'],
    env: { YUNPANEL_SECRET_MASTER_KEY: 'must-not-print' },
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverDatabaseBackup: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        operation: 'database.backup',
        status: 'succeeded',
        recoveryMethod: 'verified_private_database_backup_artifact',
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
  assert.match(output.join(''), /operation=database\.backup/);
  assert.match(output.join(''), /method=verified_private_database_backup_artifact/);
  assert.doesNotMatch(output.join(''), /must-not-print|dump\.sql|backupPath|dumpPath|CREATE TABLE|payload|SECRET_MASTER_KEY/i);
});
