import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { startConfiguredLocalRuntime } from '../src/configured-local-runtime.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const certificateId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(':').toUpperCase();

async function recorderFixture() {
  const writes = [];
  let startOptions;
  await startConfiguredLocalRuntime({
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId },
    hostname: 'host-1.example.local',
    jobStorePath: '/var/lib/yunpanel/control-plane/job-registry.json',
    runtimeVersion: '0.3.0',
    registry: {}, jobRegistry: {}, domainRegistry: {}, certificateRegistry: {}, applicationRegistry: {},
    applicationEnvironmentRegistry: { materialize: async () => ({}) },
    createOperations: () => ({ operations: [], supports: () => true, executeOperation: async () => ({}) }),
    createCertificateOperationReceipts: () => ({ async write(value) { writes.push(value); } }),
    createDatabaseDeletionReceipts: () => ({ write: async () => {} }),
    createDomainActivationReceipts: () => ({ write: async () => {} }),
    createManagedServiceReceipts: () => ({ write: async () => {} }),
    createNodeDeploymentReceipts: () => ({ write: async () => {} }),
    createNodeRestartReceipts: () => ({ write: async () => {} }),
    createNodeRollbackReceipts: () => ({ write: async () => {} }),
    createSystemUpgradeReceipts: () => ({ write: async () => {} }),
    inspectInventory: async () => ({ hostname: 'host-1.example.local' }),
    startRuntime: async (options) => { startOptions = options; return { stop: async () => {} }; },
  });
  return { writes, recorder: startOptions.recordExecutionEvidence };
}

const production = {
  fingerprint256: fingerprint,
  validFrom: '2026-09-10T00:00:00.000Z',
  validTo: '2026-12-09T00:00:00.000Z',
};

for (const scenario of [
  {
    name: 'staging issue',
    operation: OPERATIONS.SSL_ISSUE,
    payload: { domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: true },
    result: { certName: 'example.com', domains: ['example.com', 'www.example.com'], staging: true, status: 'validated' },
  },
  {
    name: 'production issue',
    operation: OPERATIONS.SSL_ISSUE,
    payload: { domains: ['example.com', 'www.example.com'], email: 'ops@example.com', staging: false },
    result: { certName: 'example.com', domains: ['example.com', 'www.example.com'], staging: false, status: 'issued', ...production },
  },
  {
    name: 'renew dry-run',
    operation: OPERATIONS.SSL_RENEW,
    payload: { certName: 'example.com', dryRun: true },
    result: { certName: 'example.com', dryRun: true, status: 'validated' },
  },
  {
    name: 'production renewal',
    operation: OPERATIONS.SSL_RENEW,
    payload: { certName: 'example.com', dryRun: false },
    result: { certName: 'example.com', dryRun: false, status: 'renewed', ...production },
  },
]) {
  test(`configured runtime records exact ${scenario.name} certificate receipt`, async () => {
    const fx = await recorderFixture();
    await fx.recorder({
      serverId,
      jobId,
      operation: scenario.operation,
      resourceType: 'certificate',
      resourceId: certificateId,
      payload: scenario.payload,
      result: scenario.result,
    });
    assert.deepEqual(fx.writes, [{
      serverId,
      jobId,
      certificateId,
      operation: scenario.operation,
      result: scenario.result,
    }]);
  });
}

test('certificate receipt recorder rejects resource and result drift before persistence', async () => {
  const fx = await recorderFixture();
  await assert.rejects(
    fx.recorder({
      serverId,
      jobId,
      operation: OPERATIONS.SSL_ISSUE,
      resourceType: 'domain',
      resourceId: certificateId,
      payload: { domains: ['example.com'], email: 'ops@example.com', staging: false },
      result: { certName: 'example.com', domains: ['example.com'], staging: false, status: 'issued', ...production },
    }),
    /not safe recovery evidence/,
  );
  await assert.rejects(
    fx.recorder({
      serverId,
      jobId,
      operation: OPERATIONS.SSL_RENEW,
      resourceType: 'certificate',
      resourceId: certificateId,
      payload: { certName: 'example.com', dryRun: false },
      result: { certName: 'other.example.com', dryRun: false, status: 'renewed', ...production },
    }),
    /not safe recovery evidence/,
  );
  assert.deepEqual(fx.writes, []);
});
