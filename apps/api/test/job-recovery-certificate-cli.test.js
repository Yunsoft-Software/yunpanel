import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const packagedPath = '/usr/lib/yunpanel/scripts/job-recovery.mjs';

test('certificate recovery CLI requires exact action shape and confirmation', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-certificate', serverId, jobId, '--confirm']),
    { action: 'recover-certificate', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-certificate', serverId, jobId]), /Usage:/);
});

test('packaged root certificate recovery delegates only to certificate runtime', async () => {
  const calls = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-certificate', serverId, jobId, '--confirm'],
    filePath: packagedPath,
    uid: 0,
    env: { YUNPANEL_JOB_STORE: '/var/lib/yunpanel/control-plane/job-registry.json' },
    cwd: '/',
    recoverCertificate: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'ssl.issue',
        certificateId: 'certificate-1',
        status: 'succeeded',
        recoveryMethod: 'verified_certificate_receipt_and_live_x509',
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    stdout: { write() {} },
  });

  assert.equal(result.recoveryMethod, 'verified_certificate_receipt_and_live_x509');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].packaged, true);
});

test('certificate recovery is packaged-root only', async () => {
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-certificate', serverId, jobId, '--confirm'],
      filePath: packagedPath,
      uid: 1000,
      recoverCertificate: async () => ({}),
    }),
    /must be run as root/,
  );
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-certificate', serverId, jobId, '--confirm'],
      filePath: '/work/scripts/job-recovery.mjs',
      uid: 0,
      recoverCertificate: async () => ({}),
    }),
    /available only from the packaged YunPanel installation/,
  );
});
