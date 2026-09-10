import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPackagedJobRecoveryRoot,
  isPackagedJobRecoveryScript,
  parseJobRecoveryArguments,
  runJobRecoveryCli,
} from '../../../scripts/job-recovery.mjs';

test('job recovery CLI accepts only read-only status syntax', () => {
  assert.deepEqual(parseJobRecoveryArguments(['status']), { action: 'status' });
  assert.throws(() => parseJobRecoveryArguments([]), /Usage/);
  assert.throws(() => parseJobRecoveryArguments(['status', '--confirm']), /Usage/);
  assert.throws(() => parseJobRecoveryArguments(['resolve']), /Usage/);
});

test('packaged job recovery CLI detection stays inside the installed script directory', () => {
  assert.equal(isPackagedJobRecoveryScript('/usr/lib/yunpanel/scripts/job-recovery.mjs'), true);
  assert.equal(isPackagedJobRecoveryScript('/work/yunpanel/scripts/job-recovery.mjs'), false);
  assert.equal(isPackagedJobRecoveryScript('/usr/lib/yunpanel-other/scripts/job-recovery.mjs'), false);
});

test('packaged job recovery inspection requires root', () => {
  assert.throws(() => assertPackagedJobRecoveryRoot({ packaged: true, uid: 1000 }), /must be run as root/);
  assert.doesNotThrow(() => assertPackagedJobRecoveryRoot({ packaged: true, uid: 0 }));
  assert.doesNotThrow(() => assertPackagedJobRecoveryRoot({ packaged: false, uid: 1000 }));
});

test('status CLI opens the durable registry for the configured job store and prints only safe inspection metadata', async () => {
  const output = [];
  const calls = [];
  const fakeRegistry = { marker: 'durable-registry' };
  const fakeJobRegistryFactory = () => ({ marker: 'job-registry' });
  const result = await runJobRecoveryCli({
    argv: ['status'],
    env: {
      YUNPANEL_JOB_STORE: '.state/jobs.json',
      YUNPANEL_SECRET_MASTER_KEY: 'must-not-print',
    },
    cwd: '/work/yunpanel',
    filePath: '/work/yunpanel/scripts/job-recovery.mjs',
    uid: 1000,
    jobRegistryFactory: fakeJobRegistryFactory,
    durableRegistryFactory: (input) => {
      calls.push(input);
      return fakeRegistry;
    },
    inspect: async ({ registry }) => {
      assert.equal(registry, fakeRegistry);
      return {
        version: 1,
        state: 'reconciliation_required',
        code: 'durable_job_reconciliation_required',
        detectedAt: '2026-09-10T01:00:00.000Z',
        jobs: [{
          jobId: '12345678-1234-4234-8234-123456789012',
          serverId: 'server-1',
          operation: 'system.packages.inspect',
          resourceType: 'system',
          resourceId: 'server-1',
          createdAt: '2026-09-10T00:59:00.000Z',
          startedAt: '2026-09-10T01:00:00.000Z',
          attempts: 1,
        }],
      };
    },
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].filePath, '/work/yunpanel/.state/jobs.json');
  assert.equal(calls[0].registryFactory, fakeJobRegistryFactory);
  assert.equal(result.statePaths.jobStore, '/work/yunpanel/.state/jobs.json');
  assert.equal(result.statePaths.recoveryStore, '/work/yunpanel/.state/jobs.json.recovery.json');
  assert.match(output.join(''), /state=reconciliation_required/);
  assert.match(output.join(''), /operation=system\.packages\.inspect/);
  assert.doesNotMatch(output.join(''), /must-not-print|SECRET_MASTER_KEY|payload|result|error/i);
});

test('packaged status refuses job state outside the control-plane root before opening the durable registry', async () => {
  let opened = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['status'],
      env: { YUNPANEL_JOB_STORE: '/tmp/jobs.json' },
      filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
      uid: 0,
      durableRegistryFactory: () => {
        opened = true;
        return {};
      },
      stdout: { write() {} },
    }),
    { code: 'packaged_state_path_outside_control_plane' },
  );
  assert.equal(opened, false);
});
