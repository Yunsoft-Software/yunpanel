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
};

test('configured runtime hydrates managed mail privately and records only secret-free crash evidence', async () => {
  let operationOptions;
  let startOptions;
  const materializations = [];
  const receipts = [];
  const mailDomainRegistry = { transitionLocalStatus: async () => ({}) };
  const mailConfigurationService = {
    async materializeTransition(input, expected) {
      materializations.push([input, expected]);
      return {
        preview: { sha256: configurationSha256 },
        sensitiveArtifacts: [{ path: '/etc/yunpanel/mail/dovecot/users', content: 'must-not-enter-receipt' }],
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

  await startOptions.recordExecutionEvidence({
    serverId,
    jobId,
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    payload,
    result: {
      version: 1,
      mailDomainId,
      desiredStatus: 'enabled',
      previewDigest,
      configurationSha256,
      planSha256,
      readinessSha256,
      applied: true,
      sideEffects: true,
    },
  });

  assert.deepEqual(receipts, [{
    serverId,
    jobId,
    mailDomainId,
    desiredStatus: 'enabled',
    previewDigest,
    configurationSha256,
    planSha256,
    readinessSha256,
    applied: true,
  }]);
  assert.doesNotMatch(JSON.stringify(receipts), /must-not-enter-receipt|argon2|password|content/i);
});

test('configured runtime refuses managed mail without reconciliation registry', async () => {
  await assert.rejects(
    startConfiguredLocalRuntime({
      ...base,
      env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
      mailConfigurationService: { materializeTransition: async () => ({}) },
    }),
    { code: 'local_mail_domain_registry_invalid' },
  );
});
