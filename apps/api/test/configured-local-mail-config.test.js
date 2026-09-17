import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const mailDomainId = '87654321-1234-4234-8234-123456789012';
const jobId = '12345678-1234-4234-8234-123456789012';
const previewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const planSha256 = 'c'.repeat(64);
const readinessSha256 = 'd'.repeat(64);
const backupSha256 = 'e'.repeat(64);

const base = {
  hostname: 'host-1.example.local',
  jobStorePath: '/var/lib/yunpanel/control-plane/job-registry.json',
  runtimeVersion: '0.3.0',
  registry: {},
  jobRegistry: {},
  domainRegistry: {},
  certificateRegistry: {},
  applicationRegistry: {},
  applicationEnvironmentRegistry: { materialize: async () => ({}) },
    websiteRegistry: { listWebsites: async () => [] },
    runtimeBindingRegistry: { getBinding: async () => null, activate: async () => null },
};

test('configured runtime hydrates managed mail privately and records only secret-free crash evidence', async () => {
  let operationOptions;
  let startOptions;
  const materializations = [];
  const currentMaterializations = [];
  const receipts = [];
  const rollbackReceipts = [];
  const mailDomainRegistry = { transitionLocalStatus: async () => ({}) };
  const mailConfigurationService = {
    async materializeTransition(input, expected) {
      materializations.push([input, expected]);
      return {
        transition: {
          mailDomainId,
          previousRevision: input.expectedRevision,
          previousStatus: 'disabled',
          desiredStatus: input.status,
        },
        preview: { sha256: configurationSha256 },
        sensitiveArtifacts: [{ path: '/etc/yunpanel/mail/dovecot/users', content: 'must-not-enter-receipt' }],
      };
    },
    async materializeCurrent(input, expected) {
      currentMaterializations.push([input, expected]);
      return {
        state: { mailDomainId, revision: input.expectedRevision, status: input.status },
        preview: { sha256: configurationSha256 },
        sensitiveArtifacts: [{ path: '/etc/yunpanel/mail/dovecot/users', content: 'rollback-private' }],
      };
    },
  };

  await startConfiguredLocalRuntime({
    ...base,
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
    mailDomainRegistry,
    mailConfigurationService,
    createMailConfigOperationReceipts: () => ({
      async write(value) { receipts.push(structuredClone(value)); },
    }),
    createMailConfigRollbackReceipts: () => ({
      async write(value) { rollbackReceipts.push(structuredClone(value)); },
    }),
    createOperations: (options) => {
      operationOptions = options;
      return { operations: [OPERATIONS.MAIL_CONFIG_APPLY], supports: () => true, executeOperation: async () => ({}) };
    },
    startRuntime: async (options) => {
      startOptions = options;
      return { stop: async () => {} };
    },
  });

  assert.equal(startOptions.mailDomainRegistry, mailDomainRegistry);
  const payload = {
    mailDomainId,
    expectedRevision: 3,
    desiredStatus: 'enabled',
    previewDigest,
    configurationSha256,
  };
  const privateBundle = await operationOptions.loadManagedMailConfiguration(payload);
  assert.match(privateBundle.sensitiveArtifacts[0].content, /must-not-enter-receipt/);
  assert.deepEqual(materializations, [[
    { mailDomainId, expectedRevision: 3, status: 'enabled' },
    { expectedPreviewDigest: previewDigest, expectedConfigurationSha256: configurationSha256 },
  ]]);

  const rollbackPayload = {
    mailDomainId,
    sourceApplyJobId: 'mail-job-source-0001',
    previousRevision: 3,
    expectedCurrentRevision: 4,
    currentStatus: 'enabled',
    targetStatus: 'disabled',
    previewDigest,
    currentConfigurationSha256: configurationSha256,
    sourcePlanSha256: planSha256,
    backupSha256,
  };
  const currentBundle = await operationOptions.loadManagedMailRollbackConfiguration(rollbackPayload);
  assert.match(currentBundle.sensitiveArtifacts[0].content, /rollback-private/);
  assert.deepEqual(currentMaterializations, [[
    { mailDomainId, expectedRevision: 4, status: 'enabled' },
    { expectedConfigurationSha256: configurationSha256 },
  ]]);

  await startOptions.recordExecutionEvidence({
    serverId,
    jobId,
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    payload,
    result: {
      version: 3,
      mailDomainId,
      previousRevision: 3,
      previousStatus: 'disabled',
      desiredStatus: 'enabled',
      previewDigest,
      configurationSha256,
      planSha256,
      backupSha256,
      readinessSha256,
      applied: true,
      sideEffects: true,
    },
  });

  assert.deepEqual(receipts, [{
    serverId,
    jobId,
    mailDomainId,
    previousRevision: 3,
    previousStatus: 'disabled',
    desiredStatus: 'enabled',
    previewDigest,
    configurationSha256,
    planSha256,
    backupSha256,
    readinessSha256,
    applied: true,
  }]);
  assert.doesNotMatch(JSON.stringify(receipts), /must-not-enter-receipt|argon2|password|content/i);

  await startOptions.recordExecutionEvidence({
    serverId,
    jobId: 'mail-job-rollback-0001',
    operation: OPERATIONS.MAIL_CONFIG_ROLLBACK,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    payload: rollbackPayload,
    result: {
      version: 1,
      ...rollbackPayload,
      compensationBackupSha256: 'f'.repeat(64),
      restored: true,
      sideEffects: true,
    },
  });
  assert.deepEqual(rollbackReceipts, [{
    serverId,
    jobId: 'mail-job-rollback-0001',
    ...rollbackPayload,
    compensationBackupSha256: 'f'.repeat(64),
    restored: true,
  }]);
  assert.doesNotMatch(JSON.stringify(rollbackReceipts), /rollback-private|argon2|password|content|path/i);
});

test('configured runtime refuses managed mail without reconciliation registry', async () => {
  await assert.rejects(
    startConfiguredLocalRuntime({
      ...base,
      env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
      mailConfigurationService: {
        materializeTransition: async () => ({}),
        materializeCurrent: async () => ({}),
      },
    }),
    { code: 'local_mail_domain_registry_invalid' },
  );
});
