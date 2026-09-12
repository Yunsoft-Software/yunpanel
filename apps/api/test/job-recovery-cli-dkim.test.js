import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseJobRecoveryArguments,
  runJobRecoveryCli,
} from '../../../scripts/job-recovery.mjs';

const serverId = 'local-server';
const jobId = 'mail-dkim-job-001';

test('parser accepts the explicit recover-mail-dkim confirmation shape', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-mail-dkim', serverId, jobId, '--confirm']),
    { action: 'recover-mail-dkim', serverId, jobId, confirm: true },
  );
});

test('packaged recover-mail-dkim dispatches only to the DKIM lost-ack recovery adapter', async () => {
  const calls = [];
  let output = '';
  const result = await runJobRecoveryCli({
    argv: ['recover-mail-dkim', serverId, jobId, '--confirm'],
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    env: { YUNPANEL_MAIL_DKIM_ROOT: '/var/lib/yunpanel/control-plane/mail-dkim' },
    cwd: '/usr/lib/yunpanel',
    recoverMailDkim: async (input) => {
      calls.push(structuredClone(input));
      return {
        serverId,
        jobId,
        operation: 'mail.dkim.apply',
        status: 'succeeded',
        recoveryMethod: 'verified_dkim_receipt_and_active_host_state',
        reconciled: true,
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
        },
      };
    },
    recoveryAudit: null,
    stdout: { write(value) { output += value; } },
  });
  assert.equal(result.operation, 'mail.dkim.apply');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serverId, serverId);
  assert.equal(calls[0].jobId, jobId);
  assert.equal(calls[0].packaged, true);
  assert.match(output, /operation=mail\.dkim\.apply/);
  assert.match(output, /method=verified_dkim_receipt_and_active_host_state/);
});

test('DKIM recovery mutation is unavailable from a source checkout', async () => {
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-mail-dkim', serverId, jobId, '--confirm'],
      filePath: '/workspace/yunpanel/scripts/job-recovery.mjs',
      uid: 0,
      stdout: { write() {} },
    }),
    /available only from the packaged YunPanel installation/,
  );
});
