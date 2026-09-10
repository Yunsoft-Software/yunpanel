import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts only confirmed database-delete recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-database-delete', serverId, jobId, '--confirm']),
    { action: 'recover-database-delete', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-database-delete', serverId, jobId]), /Usage/);
});

test('packaged database-delete recovery delegates exact identity and prints only safe metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-database-delete', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    cwd: '/root',
    env: {},
    recoverDatabaseDelete: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'database.delete',
        status: 'succeeded',
        recoveryMethod: 'verified_database_deletion_receipt_and_absence',
        reconciled: true,
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
  assert.equal(result.recoveryMethod, 'verified_database_deletion_receipt_and_absence');
  assert.match(output.join(''), /operation=database\.delete/);
  assert.match(output.join(''), /method=verified_database_deletion_receipt_and_absence/);
  assert.doesNotMatch(output.join(''), /databaseName|sizeBytes|engine|version|payload|result/i);
});

test('database-delete recovery remains packaged-root only', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-database-delete', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      recoverDatabaseDelete: async () => { called = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(called, false);
});
