import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';

test('job recovery CLI parses managed mail recovery only with explicit confirmation', () => {
  assert.deepEqual(
    parseJobRecoveryArguments(['recover-mail-config', serverId, jobId, '--confirm']),
    { action: 'recover-mail-config', serverId, jobId, confirm: true },
  );
  assert.throws(() => parseJobRecoveryArguments(['recover-mail-config', serverId, jobId]), /Usage/);
  assert.throws(() => parseJobRecoveryArguments(['recover-mail-config', serverId, jobId, '--force']), /Usage/);
});

test('packaged managed mail recovery dispatches exact identity and prints only safe metadata', async () => {
  const output = [];
  const calls = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-mail-config', serverId, jobId, '--confirm'],
    env: {
      YUNPANEL_SECRET_MASTER_KEY: 'must-not-print',
      YUNPANEL_MAILBOX_STORE: '/var/lib/yunpanel/control-plane/mailbox-registry.json',
    },
    cwd: '/root',
    filePath: '/usr/lib/yunpanel/scripts/job-recovery.mjs',
    uid: 0,
    recoverMailConfig: async (input) => {
      calls.push(input);
      return {
        serverId: input.serverId,
        jobId: input.jobId,
        operation: 'mail.config.apply',
        status: 'succeeded',
        recoveryMethod: 'verified_mail_config_receipt_and_active_host_state',
        reconciled: true,
        statePaths: {
          jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
          recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
          mailDomainStore: '/var/lib/yunpanel/control-plane/mail-domain-registry.json',
          mailboxStore: '/var/lib/yunpanel/control-plane/mailbox-registry.json',
        },
      };
    },
    recoveryAudit: () => {},
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    { serverId: calls[0].serverId, jobId: calls[0].jobId, packaged: calls[0].packaged, cwd: calls[0].cwd },
    { serverId, jobId, packaged: true, cwd: '/root' },
  );
  assert.equal(result.reconciled, true);
  assert.match(output.join(''), /operation=mail\.config\.apply/);
  assert.match(output.join(''), /method=verified_mail_config_receipt_and_active_host_state/);
  assert.doesNotMatch(output.join(''), /must-not-print|SECRET_MASTER_KEY|mailbox-registry|payload|result|error/i);
});

test('managed mail recovery remains unavailable from an unpackaged checkout', async () => {
  let called = false;
  await assert.rejects(
    runJobRecoveryCli({
      argv: ['recover-mail-config', serverId, jobId, '--confirm'],
      filePath: '/work/yunpanel/scripts/job-recovery.mjs',
      uid: 0,
      recoverMailConfig: async () => { called = true; },
      stdout: { write() {} },
    }),
    /only from the packaged YunPanel installation/,
  );
  assert.equal(called, false);
});
