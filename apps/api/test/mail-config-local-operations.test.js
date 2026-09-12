import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const MAIL_DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG_DIGEST = 'a'.repeat(64);
const PREVIEW_DIGEST = 'b'.repeat(64);
const PLAN_DIGEST = 'c'.repeat(64);
const READINESS_DIGEST = 'd'.repeat(64);
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

test('local managed mail execution keeps protected material private and preserves stage backup activate order', async () => {
  const calls = [];
  const preview = { sha256: CONFIG_DIGEST };
  const sensitiveArtifacts = [{ path: '/etc/yunpanel/mail/dovecot/users', content: PASSWORD_HASH }];
  const operations = createLocalHostOperations({
    loadManagedMailConfiguration: async (input) => {
      calls.push(['load', input]);
      return { preview, sensitiveArtifacts };
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
        return { backedUp: true };
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
    version: 1,
    mailDomainId: MAIL_DOMAIN_ID,
    desiredStatus: 'enabled',
    previewDigest: PREVIEW_DIGEST,
    configurationSha256: CONFIG_DIGEST,
    planSha256: PLAN_DIGEST,
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
