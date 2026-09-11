import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';

test('Node runtime install recovery is an explicit confirmed packaged-root command', async () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-node-runtime-install', serverId, jobId, '--confirm']),
    { action: 'recover-node-runtime-install', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-node-runtime-install', serverId, jobId]), /Usage:/);
  const output = [];
  const recovered = await runJobRecoveryCli({
    argv: ['recover-node-runtime-install', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverNodeRuntimeInstall: async (input) => ({
      serverId: input.serverId,
      jobId: input.jobId,
      operation: 'system.node-runtime.install',
      status: 'succeeded',
      recoveryMethod: 'verified_managed_node_runtime',
      statePaths: { jobStore: '/var/lib/yunpanel/jobs.json', recoveryStore: '/var/lib/yunpanel/jobs.recovery.json' },
    }),
    stdout: { write(value) { output.push(value); } },
  });
  assert.equal(recovered.recoveryMethod, 'verified_managed_node_runtime');
  assert.match(output[0], /method=verified_managed_node_runtime/);

  await assert.rejects(runJobRecoveryCli({
    argv: ['recover-node-runtime-install', serverId, jobId, '--confirm'],
    filePath: '/work/scripts/job-recovery.mjs',
    uid: 0,
    recoverNodeRuntimeInstall: async () => ({}),
  }), /available only from the packaged YunPanel installation/);
});
