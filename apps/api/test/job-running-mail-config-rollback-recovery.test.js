import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningMailConfigRollback } from '../src/job-running-mail-config-rollback-recovery.js';

const serverId = 'local-server';
const jobId = '11111111-2222-4333-8444-555555555555';
const sourceApplyJobId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const mailDomainId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const previewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const planSha256 = 'c'.repeat(64);
const backupSha256 = 'd'.repeat(64);
const compensationBackupSha256 = 'e'.repeat(64);

function fixture({ hostState = 'mixed', journalStatus = 'restoring_source', receipt = null } = {}) {
  const events = [];
  let jobStatus = 'running';
  const payload = {
    mailDomainId,
    sourceApplyJobId,
    previousRevision: 4,
    expectedCurrentRevision: 5,
    currentStatus: 'enabled',
    targetStatus: 'disabled',
    currentConfigurationSha256: configurationSha256,
    sourcePlanSha256: planSha256,
    backupSha256,
    previewDigest,
  };
  let journal = {
    version: 1,
    serverId,
    jobId,
    ...payload,
    compensationBackupSha256,
    status: journalStatus,
    lastErrorCode: journalStatus === 'compensated' ? 'fixture_failure' : null,
  };
  const makeReceipt = () => ({
    version: 1,
    serverId,
    jobId,
    ...payload,
    compensationBackupSha256,
    restored: true,
  });
  const jobRegistry = {
    async getJob() {
      events.push('get');
      return {
        id: jobId,
        serverId,
        status: jobStatus,
        operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
        resourceType: 'mail_domain',
        resourceId: mailDomainId,
        payload,
      };
    },
    async beginReconciliation(identity) {
      events.push('begin');
      return { ...identity, status: 'running', pending: true };
    },
    async complete(input) {
      events.push(`complete.${input.status}`);
      jobStatus = input.status;
      return {
        id: jobId,
        serverId,
        status: input.status,
        operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
        resourceType: 'mail_domain',
        resourceId: mailDomainId,
        payload,
        result: input.result ?? null,
        error: input.error ?? null,
      };
    },
    async acknowledgeReconciliation(identity) {
      events.push('ack');
      return { ...identity, status: jobStatus, acknowledged: true };
    },
  };
  const options = {
    serverId,
    jobId,
    jobRegistry,
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    mailDomainRegistry: {
      getMailDomain: async () => ({
        id: mailDomainId,
        managementMode: 'local',
        status: 'enabled',
        revision: 5,
      }),
      transitionLocalStatus: async () => {},
    },
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    inspect: async () => ({
      jobs: [{
        jobId,
        serverId,
        status: 'running',
        operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
        resourceType: 'mail_domain',
        resourceId: mailDomainId,
      }],
    }),
    loadJobContext: async () => {
      events.push('context');
      return {
        id: jobId,
        serverId,
        status: 'running',
        operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
        resourceType: 'mail_domain',
        resourceId: mailDomainId,
        payload,
      };
    },
    readRollbackJournal: async () => {
      events.push('journal.read');
      return journal;
    },
    transitionRollbackJournal: async (_serverId, _jobId, update) => {
      events.push(`journal.${update.status}`);
      journal = { ...journal, ...update };
      return journal;
    },
    readRollbackReceipt: async () => {
      events.push('receipt.read');
      return receipt === true ? makeReceipt() : receipt;
    },
    writeRollbackReceipt: async (input) => {
      events.push('receipt.write');
      return { version: 1, ...input };
    },
    materializeCurrent: async () => {
      events.push('materialize');
      return {
        state: { mailDomainId, revision: 5, status: 'enabled' },
        preview: { sha256: configurationSha256 },
        sensitiveArtifacts: [{ content: 'must-not-escape' }],
      };
    },
    inspectRollbackConfiguration: async () => {
      events.push('host.inspect');
      return {
        version: 1,
        currentConfigurationSha256: configurationSha256,
        sourcePlanSha256: planSha256,
        sourceBackupSha256: backupSha256,
        compensationBackupSha256,
        state: hostState,
        sourceMatches: hostState === 'source',
        currentMatches: hostState === 'current',
        operationOwned: hostState !== 'drifted',
        sideEffects: false,
      };
    },
    recoverRollbackConfiguration: async () => {
      events.push('host.recover');
      return {
        version: 1,
        currentConfigurationSha256: configurationSha256,
        sourcePlanSha256: planSha256,
        sourceBackupSha256: backupSha256,
        compensationBackupSha256,
        restored: true,
        sideEffects: true,
      };
    },
    reconcile: async ({ job }) => {
      events.push(`reconcile.${job.status}`);
      return { reconciled: true, error: null };
    },
  };
  return { events, options, payload };
}

test('running mail rollback recovery completes operation-owned mixed state and persists receipt', async () => {
  const fx = fixture();
  let completion;
  const complete = fx.options.jobRegistry.complete;
  fx.options.jobRegistry.complete = async (input) => {
    completion = input;
    return complete(input);
  };

  const result = await recoverRunningMailConfigRollback(fx.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.recoveryMethod, 'verified_mail_config_rollback_journal_backups_and_host_state');
  assert.deepEqual(fx.events, [
    'get', 'context', 'journal.read', 'receipt.read', 'materialize', 'host.inspect',
    'host.recover', 'journal.restored', 'receipt.write', 'begin', 'complete.succeeded',
    'reconcile.succeeded', 'ack',
  ]);
  assert.deepEqual(completion.result, {
    version: 1,
    ...fx.payload,
    compensationBackupSha256,
    restored: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape|content|password|path/i);
});

test('running mail rollback recovery closes exact current state as compensated failure without host mutation', async () => {
  const fx = fixture({ hostState: 'current' });
  let completion;
  const complete = fx.options.jobRegistry.complete;
  fx.options.jobRegistry.complete = async (input) => {
    completion = input;
    return complete(input);
  };

  const result = await recoverRunningMailConfigRollback(fx.options);
  assert.equal(result.status, 'failed');
  assert.equal(result.recoveryMethod, 'verified_mail_config_rollback_current_compensation');
  assert.equal(completion.error.code, 'mail_rollback_recovery_current');
  assert.deepEqual(fx.events, [
    'get', 'context', 'journal.read', 'receipt.read', 'materialize', 'host.inspect',
    'journal.compensated', 'begin', 'complete.failed', 'reconcile.failed', 'ack',
  ]);
});

test('running mail rollback recovery leaves unowned host drift unresolved', async () => {
  const fx = fixture({ hostState: 'drifted' });
  await assert.rejects(
    recoverRunningMailConfigRollback(fx.options),
    { code: 'job_mail_config_rollback_recovery_host_drifted' },
  );
  assert.equal(fx.events.includes('host.recover'), false);
  assert.equal(fx.events.some((event) => event.startsWith('complete.')), false);
});

test('running mail rollback recovery revalidates existing receipt and exact source before completion', async () => {
  const fx = fixture({ hostState: 'source', receipt: true });
  const result = await recoverRunningMailConfigRollback(fx.options);
  assert.equal(result.status, 'succeeded');
  assert.equal(fx.events.includes('receipt.write'), false);
  assert.equal(fx.events.includes('host.recover'), true);
});

test('running mail rollback recovery rejects journal identity drift before protected materialization', async () => {
  const fx = fixture();
  const readJournal = fx.options.readRollbackJournal;
  fx.options.readRollbackJournal = async (...args) => ({
    ...(await readJournal(...args)),
    backupSha256: 'f'.repeat(64),
  });
  await assert.rejects(
    recoverRunningMailConfigRollback(fx.options),
    { code: 'job_mail_config_rollback_recovery_journal_mismatch' },
  );
  assert.equal(fx.events.includes('materialize'), false);
  assert.equal(fx.events.includes('host.inspect'), false);
});
