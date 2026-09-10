import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts confirmed database-create recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-database-create', serverId, jobId, '--confirm']),
    { action: 'recover-database-create', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-database-create', serverId, jobId]), /Usage/);
});

test('packaged database-create recovery delegates exact identity without exposing host result data', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-database-create', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    cwd: '/root',
    env: {},
    recoverDatabaseCreate: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'database.create',
        status: 'succeeded',
        recoveryMethod: 'verified_database_presence',
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
  assert.equal(calls[0].cwd, '/root');
  assert.equal(result.recoveryMethod, 'verified_database_presence');
  assert.match(output.join(''), /operation=database\.create/);
  assert.match(output.join(''), /method=verified_database_presence/);
  assert.doesNotMatch(output.join(''), /databaseName|sizeBytes|engine|version|payload|result/i);
});

test('database-create recovery remains packaged-root only', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-database-create', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      recoverDatabaseCreate: async () => { called = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(called, false);
});
