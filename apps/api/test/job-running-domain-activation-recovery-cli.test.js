import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI accepts confirmed domain activation syntax', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-domain-activate', serverId, jobId, '--confirm']),
    { action: 'recover-domain-activate', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-domain-activate', serverId, jobId]), /Usage/);
});

test('packaged domain activation recovery delegates exact identity and safe output only', async () => {
  const output = [];
  const calls = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-domain-activate', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    cwd: '/root',
    env: {},
    recoverDomainActivate: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'domain.activate',
        status: 'succeeded',
        recoveryMethod: 'verified_domain_activation_receipt_and_active_config',
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
  assert.equal(calls[0].packaged, true);
  assert.deepEqual({ serverId: calls[0].serverId, jobId: calls[0].jobId }, { serverId, jobId });
  assert.equal(result.reconciled, true);
  assert.match(output.join(''), /operation=domain\.activate/);
  assert.match(output.join(''), /verified_domain_activation_receipt_and_active_config/);
  assert.doesNotMatch(output.join(''), /primaryDomain|checksum|configName|payload|result/i);
});

test('domain activation recovery remains packaged-root only', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-domain-activate', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      recoverDomainActivate: async () => { called = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(called, false);
});
