import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const MAIL_DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG_DIGEST = 'a'.repeat(64);
const PREVIEW_DIGEST = 'b'.repeat(64);
const PLAN_DIGEST = 'c'.repeat(64);
const READINESS_DIGEST = 'd'.repeat(64);
const BACKUP_DIGEST = 'e'.repeat(64);
const COMPENSATION_DIGEST = 'f'.repeat(64);
const PASSWORD_HASH = '$argon2id$protected';

function payload() {
  return {
    mailDomainId: MAIL_DOMAIN_ID,
    expectedRevision: 1,
    desiredStatus: 'enabled',
    previewDigest: PREVIEW_DIGEST,
    configurationSha256: CONFIG_DIGEST,
  };
}

function execution(overrides = {}) {
  return {
    jobId: '11111111-2222-4333-8444-555555555555',
    serverId: 'local-server',
    resourceType: 'mail_domain',
    resourceId: MAIL_DOMAIN_ID,
    ...overrides,
  };
}

function transition(overrides = {}) {
  return {
    mailDomainId: MAIL_DOMAIN_ID,
    previousRevision: 1,
    previousStatus: 'disabled',
    desiredStatus: 'enabled',
    ...overrides,
  };
}

function rollbackPayload(overrides = {}) {
  return {
    mailDomainId: MAIL_DOMAIN_ID,
    sourceApplyJobId: 'mail-job-source-0001',
    previousRevision: 1,
    expectedCurrentRevision: 2,
    currentStatus: 'enabled',
    targetStatus: 'disabled',
    currentConfigurationSha256: CONFIG_DIGEST,
    sourcePlanSha256: PLAN_DIGEST,
    backupSha256: BACKUP_DIGEST,
    previewDigest: PREVIEW_DIGEST,
    ...overrides,
  };
}

test('local managed mail execution keeps protected material private and preserves stage backup activate order', async () => {
  const calls = [];
  const preview = { sha256: CONFIG_DIGEST };
  const sensitiveArtifacts = [{ path: '/etc/yunpanel/mail/dovecot/users', content: PASSWORD_HASH }];
  const operations = createLocalHostOperations({
    loadManagedMailConfiguration: async (input) => {
      calls.push(['load', input]);
      return { transition: transition(), preview, sensitiveArtifacts };
    },
    mailConfigManager: {
      stageConfiguration: async (input, options) => {
        calls.push(['stage', input, options]);
        return { staged: true };
      },
    },
    mailConfigBackupManager: {
      backupConfiguration: async (input, options) => {
        calls.push(['backup', input, options]);
        return {
          previewSha256: CONFIG_DIGEST,
          planSha256: PLAN_DIGEST,
          manifestSha256: BACKUP_DIGEST,
        };
      },
    },
    mailConfigActivator: {
      activateConfiguration: async (input, options) => {
        calls.push(['activate', input, options]);
        return {
          previewSha256: CONFIG_DIGEST,
          planSha256: PLAN_DIGEST,
          readinessSha256: READINESS_DIGEST,
          applied: true,
          sideEffects: true,
        };
      },
    },
  });

  assert.equal(operations.supports(OPERATIONS.MAIL_CONFIG_APPLY), true);
  const result = await operations.executeOperation(OPERATIONS.MAIL_CONFIG_APPLY, payload(), execution());
  assert.deepEqual(calls.map((entry) => entry[0]), ['load', 'stage', 'backup', 'activate']);
  assert.equal(calls[1][2].sensitiveArtifacts[0].content, PASSWORD_HASH);
  assert.equal(calls[2][2].transactionId, execution().jobId);
  assert.equal(calls[3][2].transactionId, execution().jobId);
  assert.deepEqual(result, {
    version: 3,
    mailDomainId: MAIL_DOMAIN_ID,
    previousRevision: 1,
    previousStatus: 'disabled',
    desiredStatus: 'enabled',
    previewDigest: PREVIEW_DIGEST,
    configurationSha256: CONFIG_DIGEST,
    planSha256: PLAN_DIGEST,
    backupSha256: BACKUP_DIGEST,
    readinessSha256: READINESS_DIGEST,
    applied: true,
    sideEffects: true,
  });
  assert.equal(JSON.stringify(result).includes(PASSWORD_HASH), false);
});

test('stale managed mail materialization stops before staging backup or activation', async () => {
  const calls = [];
  const operations = createLocalHostOperations({
    loadManagedMailConfiguration: async () => ({
      preview: { sha256: 'f'.repeat(64) },
      sensitiveArtifacts: [],
    }),
    mailConfigManager: { stageConfiguration: async () => { calls.push('stage'); } },
    mailConfigBackupManager: { backupConfiguration: async () => { calls.push('backup'); } },
    mailConfigActivator: { activateConfiguration: async () => { calls.push('activate'); } },
  });

  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_CONFIG_APPLY, payload(), execution()),
    (error) => error.code === 'mail_configuration_preview_stale',
  );
  assert.deepEqual(calls, []);
});

test('managed mail execution rejects unbound backup evidence before activation', async () => {
  let activated = false;
  const operations = createLocalHostOperations({
    loadManagedMailConfiguration: async () => ({
      transition: transition(), preview: { sha256: CONFIG_DIGEST }, sensitiveArtifacts: [],
    }),
    mailConfigManager: { stageConfiguration: async () => ({}) },
    mailConfigBackupManager: {
      backupConfiguration: async () => ({
        previewSha256: CONFIG_DIGEST,
        planSha256: PLAN_DIGEST,
        manifestSha256: 'invalid',
      }),
    },
    mailConfigActivator: { activateConfiguration: async () => { activated = true; return {}; } },
  });

  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_CONFIG_APPLY, payload(), execution()),
    (error) => error.code === 'mail_config_backup_unconfirmed',
  );
  assert.equal(activated, false);
});

test('managed mail execution rejects transition drift before staging', async () => {
  let staged = false;
  const operations = createLocalHostOperations({
    loadManagedMailConfiguration: async () => ({
      transition: transition({ previousRevision: 2 }),
      preview: { sha256: CONFIG_DIGEST },
      sensitiveArtifacts: [],
    }),
    mailConfigManager: { stageConfiguration: async () => { staged = true; } },
    mailConfigBackupManager: { backupConfiguration: async () => ({}) },
    mailConfigActivator: { activateConfiguration: async () => ({}) },
  });

  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_CONFIG_APPLY, payload(), execution()),
    (error) => error.code === 'mail_configuration_transition_stale',
  );
  assert.equal(staged, false);
});

test('managed mail execution context must match the queued mail-domain resource', async () => {
  let loaded = false;
  const operations = createLocalHostOperations({
    loadManagedMailConfiguration: async () => { loaded = true; return null; },
    mailConfigManager: { stageConfiguration: async () => {} },
    mailConfigBackupManager: { backupConfiguration: async () => {} },
    mailConfigActivator: { activateConfiguration: async () => {} },
  });

  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_CONFIG_APPLY, payload(), execution({ resourceId: 'other-resource' })),
    (error) => error.code === 'mail_execution_context_invalid',
  );
  assert.equal(loaded, false);
});

test('local managed mail rollback materializes current state privately and returns bounded restore evidence', async () => {
  const calls = [];
  const operations = createLocalHostOperations({
    loadManagedMailRollbackConfiguration: async (input) => {
      calls.push(['load', input]);
      return {
        state: { mailDomainId: MAIL_DOMAIN_ID, revision: 2, status: 'enabled' },
        preview: { sha256: CONFIG_DIGEST },
        sensitiveArtifacts: [{ path: '/etc/yunpanel/mail/dovecot/users', content: PASSWORD_HASH }],
      };
    },
    mailConfigActivator: {
      activateConfiguration: async () => ({}),
      rollbackConfiguration: async (preview, options) => {
        calls.push(['rollback', preview, options]);
        await options.onPrepared({
          currentConfigurationSha256: CONFIG_DIGEST,
          sourcePlanSha256: PLAN_DIGEST,
          sourceBackupSha256: BACKUP_DIGEST,
          compensationBackupSha256: COMPENSATION_DIGEST,
        });
        return {
          currentConfigurationSha256: CONFIG_DIGEST,
          sourcePlanSha256: PLAN_DIGEST,
          sourceBackupSha256: BACKUP_DIGEST,
          compensationBackupSha256: COMPENSATION_DIGEST,
          restored: true,
          sideEffects: true,
        };
      },
    },
    mailConfigRollbackJournal: {
      async begin(input) { calls.push(['journal.begin', input]); },
      async transition(serverId, jobId, update) { calls.push(['journal.transition', serverId, jobId, update]); },
    },
  });

  assert.equal(operations.supports(OPERATIONS.MAIL_CONFIG_ROLLBACK), true);
  const result = await operations.executeOperation(
    OPERATIONS.MAIL_CONFIG_ROLLBACK,
    rollbackPayload(),
    execution(),
  );
  assert.deepEqual(calls.map(([name]) => name), ['load', 'rollback', 'journal.begin', 'journal.transition']);
  assert.deepEqual({ ...calls[1][2], onPrepared: undefined }, {
    transactionId: execution().jobId,
    sourceTransactionId: 'mail-job-source-0001',
    sourcePlanSha256: PLAN_DIGEST,
    sourceBackupSha256: BACKUP_DIGEST,
    onPrepared: undefined,
  });
  assert.equal(typeof calls[1][2].onPrepared, 'function');
  assert.equal(calls[2][1].compensationBackupSha256, COMPENSATION_DIGEST);
  assert.deepEqual(calls[3].slice(1), [
    execution().serverId,
    execution().jobId,
    { status: 'restored' },
  ]);
  assert.deepEqual(result, {
    version: 1,
    ...rollbackPayload(),
    compensationBackupSha256: COMPENSATION_DIGEST,
    restored: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /argon2|password|content|path/i);
});

test('local managed mail rollback rejects stale protected current state before host restore', async () => {
  let restored = false;
  const operations = createLocalHostOperations({
    loadManagedMailRollbackConfiguration: async () => ({
      state: { mailDomainId: MAIL_DOMAIN_ID, revision: 3, status: 'enabled' },
      preview: { sha256: CONFIG_DIGEST },
      sensitiveArtifacts: [],
    }),
    mailConfigActivator: {
      activateConfiguration: async () => ({}),
      rollbackConfiguration: async () => { restored = true; },
    },
    mailConfigRollbackJournal: { begin: async () => {}, transition: async () => {} },
  });
  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_CONFIG_ROLLBACK, rollbackPayload(), execution()),
    { code: 'mail_rollback_current_bundle_stale' },
  );
  assert.equal(restored, false);
});

test('local managed mail rollback journals compensated host failure without changing the surfaced error', async () => {
  const transitions = [];
  const failure = Object.assign(new Error('fixture source validation failure'), { code: 'mail_restore_validation_failed' });
  const operations = createLocalHostOperations({
    loadManagedMailRollbackConfiguration: async () => ({
      state: { mailDomainId: MAIL_DOMAIN_ID, revision: 2, status: 'enabled' },
      preview: { sha256: CONFIG_DIGEST },
      sensitiveArtifacts: [],
    }),
    mailConfigActivator: {
      activateConfiguration: async () => ({}),
      rollbackConfiguration: async (_preview, options) => {
        await options.onPrepared({
          currentConfigurationSha256: CONFIG_DIGEST,
          sourcePlanSha256: PLAN_DIGEST,
          sourceBackupSha256: BACKUP_DIGEST,
          compensationBackupSha256: COMPENSATION_DIGEST,
        });
        throw failure;
      },
    },
    mailConfigRollbackJournal: {
      begin: async () => {},
      async transition(...args) { transitions.push(args); },
    },
  });
  await assert.rejects(
    operations.executeOperation(OPERATIONS.MAIL_CONFIG_ROLLBACK, rollbackPayload(), execution()),
    (error) => error === failure,
  );
  assert.deepEqual(transitions, [[
    execution().serverId,
    execution().jobId,
    { status: 'compensated', lastErrorCode: 'mail_restore_validation_failed' },
  ]]);
});
