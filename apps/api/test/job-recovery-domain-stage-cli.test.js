import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('domain stage recovery syntax is explicit', () => {
  assert.deepEqual(parseJobRecoveryArguments(['recover-domain-stage', serverId, jobId, '--confirm']), {
    action: 'recover-domain-stage', serverId, jobId, confirm: true,
  });
  assert.throws(() => parseJobRecoveryArguments(['recover-domain-stage', serverId, jobId]), /Usage/);
  assert.throws(() => parseJobRecoveryArguments(['recover-domain-activate', serverId, jobId, '--confirm']), /Usage/);
});

test('domain stage recovery requires the packaged entry point', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-domain-stage', serverId, jobId, '--confirm'],
      filePath: '/work/yunpanel/scripts/job-recovery.mjs',
      uid: 0,
      recoverDomainStage: async () => { called = true; },
      stdout: { write() {} },
    }),
    /only from the packaged YunPanel installation/,
  );
  assert.equal(called, false);
});

test('packaged domain stage recovery delegates exact identity and safe summary output', async () => {
  const calls = [];
  const output = [];
  await runJobRecoveryCli({
    argv: ['recover-domain-stage', serverId, jobId, '--confirm'],
    env: {},
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverDomainStage: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'domain.stage',
        status: 'succeeded',
        recoveryMethod: 'verified_staged_nginx_config',
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
  assert.match(output.join(''), /operation=domain\.stage/);
  assert.match(output.join(''), /method=verified_staged_nginx_config/);
  assert.doesNotMatch(output.join(''), /payload|checksum|configName/i);
});

test('packaged non-root invocation stops before recovery handler', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-domain-stage', serverId, jobId, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 1000,
      recoverDomainStage: async () => { called = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(called, false);
});
