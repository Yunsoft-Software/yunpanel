import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts only confirmed service-control recovery syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-service-control', serverId, jobId, '--confirm']),
    { action: 'recover-service-control', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-service-control', serverId, jobId]), /Usage/);
});

test('packaged service-control recovery delegates exact identity and prints only safe recovery metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-service-control', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    cwd: '/root',
    env: {},
    recoverServiceControl: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'system.service.control',
        serviceId: 'nginx',
        action: 'stop',
        status: 'succeeded',
        recoveryMethod: 'verified_managed_service_state',
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
  assert.equal(result.recoveryMethod, 'verified_managed_service_state');
  assert.match(output.join(''), /operation=system\.service\.control/);
  assert.match(output.join(''), /method=verified_managed_service_state/);
  assert.doesNotMatch(output.join(''), /nginx|package|unit|payload|result/i);
});

test('service-control recovery remains packaged-root only', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-service-control', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      recoverServiceControl: async () => { called = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(called, false);

  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-service-control', serverId, jobId, '--confirm'],
      filePath: '/workspace/yunpanel/scripts/job-recovery.mjs',
      uid: 0,
      recoverServiceControl: async () => { called = true; },
      stdout: { write() {} },
    }),
    /available only from the packaged YunPanel installation/,
  );
  assert.equal(called, false);
});
