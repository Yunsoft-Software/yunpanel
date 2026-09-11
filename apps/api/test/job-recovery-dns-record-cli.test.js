import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const packagedPath = '/usr/lib/yunpanel/scripts/job-recovery.mjs';

test('DNS record recovery CLI requires exact action shape and confirmation', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-dns-record', serverId, jobId, '--confirm']),
    { action: 'recover-dns-record', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-dns-record', serverId, jobId]), /Usage:/);
});

test('packaged root DNS recovery delegates only to the DNS recovery runtime', async () => {
  const calls = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-dns-record', serverId, jobId, '--confirm'],
    filePath: packagedPath,
    uid: 0,
    env: { YUNPANEL_JOB_STORE: '/var/lib/yunpanel/control-plane/job-registry.json' },
    cwd: '/',
    recoverDnsRecord: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'dns.record.apply',
        status: 'succeeded',
        recoveryMethod: 'idempotent_provider_postcondition',
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    stdout: { write() {} },
  });
  assert.equal(result.recoveryMethod, 'idempotent_provider_postcondition');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].packaged, true);
});

test('DNS record recovery is packaged-root only', async () => {
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-dns-record', serverId, jobId, '--confirm'],
      filePath: packagedPath,
      uid: 1000,
      recoverDnsRecord: async () => ({}),
    }),
    /must be run as root/,
  );
});
