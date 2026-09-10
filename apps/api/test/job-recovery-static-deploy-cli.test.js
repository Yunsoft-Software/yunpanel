import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

test('static deploy recovery syntax is explicit and does not imply rollback recovery', () => {
  assert.deepEqual(parseJobRecoveryArguments(['recover-static-deploy', serverId, jobId, '--confirm']), {
    action: 'recover-static-deploy', serverId, jobId, confirm: true,
  });
  assert.throws(() => parseJobRecoveryArguments(['recover-static-deploy', serverId, jobId]), /Usage/);
  assert.throws(() => parseJobRecoveryArguments(['recover-static', serverId, jobId, '--confirm']), /Usage/);
});

test('static deploy recovery delegates only from packaged root entry point', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-static-deploy', serverId, jobId, '--confirm'],
      filePath: '/work/yunpanel/scripts/job-recovery.mjs',
      uid: 0,
      recoverStaticDeployment: async () => { called = true; },
      stdout: { write() {} },
    }),
    /only from the packaged YunPanel installation/,
  );
  assert.equal(called, false);
});

test('packaged static deploy recovery forwards exact identity and prints safe method metadata', async () => {
  const calls = [];
  const output = [];
  await runJobRecoveryCli({
    argv: ['recover-static-deploy', serverId, jobId, '--confirm'],
    env: {},
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverStaticDeployment: async (input) => {
      calls.push(input);
      return {
        serverId,
        jobId,
        operation: 'app.static.deploy',
        status: 'succeeded',
        recoveryMethod: 'verified_static_deployment_receipt',
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
  assert.match(output.join(''), /operation=app\.static\.deploy/);
  assert.match(output.join(''), /method=verified_static_deployment_receipt/);
  assert.doesNotMatch(output.join(''), /commitSha|artifact/i);
});
