import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts confirmed service-mutation recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-service-mutation', serverId, jobId, '--confirm']),
    { action: 'recover-service-mutation', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-service-mutation', serverId, jobId]), /Usage/);
});

test('packaged service-mutation recovery delegates exact identity without printing service details', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-service-mutation', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    cwd: '/root',
    env: {},
    recoverServiceMutation: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'system.service.install',
        serviceId: 'nginx',
        action: null,
        status: 'succeeded',
        recoveryMethod: 'verified_managed_service_receipt_and_state',
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
  assert.equal(result.recoveryMethod, 'verified_managed_service_receipt_and_state');
  assert.match(output.join(''), /operation=system\.service\.install/);
  assert.doesNotMatch(output.join(''), /nginx|package|unit|changed|payload|result/i);
});

test('service-mutation recovery remains packaged-root only', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-service-mutation', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      recoverServiceMutation: async () => { called = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(called, false);
});
