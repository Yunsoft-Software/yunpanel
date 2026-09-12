import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  JobRunningMailDkimRecoveryError,
  recoverRunningMailDkim,
} from '../src/job-running-mail-dkim-recovery.js';

const serverId = 'local-server';
const jobId = 'mail-dkim-job-001';
const mailDomainId = '85f4ca20-56df-4ecb-a335-384e67fd3ca0';
const previewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const payload = Object.freeze({
  mailDomainId,
  expectedKeyRevision: 1,
  previewDigest,
  configurationSha256,
});

function fixture({ receipt = true, evidence = true, materializeError = null, servicesActive = false } = {}) {
  const calls = [];
  const runningJob = {
    id: jobId,
    serverId,
    status: 'running',
    operation: OPERATIONS.MAIL_DKIM_APPLY,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    payload,
  };
  const candidate = {
    jobId,
    serverId,
    status: 'running',
    operation: OPERATIONS.MAIL_DKIM_APPLY,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
  };
  const context = { ...runningJob };
  const terminal = {
    ...runningJob,
    status: 'succeeded',
    result: null,
  };
  const jobRegistry = {
    async getJob(id) { calls.push(['getJob', id]); return runningJob; },
    async beginReconciliation(identity) {
      calls.push(['begin', structuredClone(identity)]);
      return { ...identity, status: 'running', pending: true };
    },
    async complete(input) {
      calls.push(['complete', structuredClone(input)]);
      terminal.result = input.result;
      return { ...terminal, result: input.result };
    },
    async acknowledgeReconciliation(identity) {
      calls.push(['ack', structuredClone(identity)]);
      return { ...identity, acknowledged: true, status: 'succeeded' };
    },
  };
  return {
    calls,
    dependencies: {
      serverId,
      jobId,
      jobRegistry,
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: {},
      mailDomainRegistry: { async getMailDomain() { return { id: mailDomainId }; } },
      serviceStatus: async () => ({ apiActive: servicesActive, agentActive: false }),
      loadJobContext: async () => context,
      materializeApply: async (input, expected) => {
        calls.push(['materialize', structuredClone(input), structuredClone(expected)]);
        if (materializeError) throw materializeError;
        return { preview: { sha256: configurationSha256 }, keys: [] };
      },
      readOperationReceipt: async () => receipt ? {
        serverId,
        jobId,
        mailDomainId,
        expectedKeyRevision: 1,
        previewDigest,
        configurationSha256,
        applied: true,
      } : null,
      inspectActiveEvidence: async (bundle) => {
        calls.push(['evidence', bundle.keys.length]);
        return evidence ? {
          satisfied: true,
          result: {
            previewSha256: configurationSha256,
            applied: true,
            sideEffects: true,
          },
        } : { satisfied: false, result: null };
      },
      inspect: async () => ({ jobs: [candidate] }),
      reconcile: async ({ job }) => {
        calls.push(['reconcile', job.status, job.result?.configurationSha256]);
        return { reconciled: true, error: null };
      },
    },
  };
}

test('recovers an empty DKIM teardown from receipt plus current private desired-state and live evidence without replaying activation', async () => {
  const state = fixture();
  const result = await recoverRunningMailDkim(state.dependencies);
  assert.deepEqual(result, {
    serverId,
    jobId,
    operation: OPERATIONS.MAIL_DKIM_APPLY,
    status: 'succeeded',
    recoveryMethod: 'verified_dkim_receipt_and_active_host_state',
    reconciled: true,
  });
  assert.deepEqual(state.calls.find(([name]) => name === 'materialize'), [
    'materialize',
    { mailDomainId, expectedKeyRevision: 1 },
    { expectedPreviewDigest: previewDigest, expectedConfigurationSha256: configurationSha256 },
  ]);
  assert.deepEqual(state.calls.find(([name]) => name === 'evidence'), ['evidence', 0]);
  const completed = state.calls.find(([name]) => name === 'complete')[1];
  assert.equal(completed.result.configurationSha256, configurationSha256);
  assert.equal(completed.result.applied, true);
  assert.doesNotMatch(JSON.stringify(completed.result), /PRIVATE KEY|privateKey|selector|publicKey/i);
});

test('missing receipt, changed desired-state or failed live evidence leaves the running DKIM job unresolved', async () => {
  for (const options of [
    { receipt: false, code: 'job_mail_dkim_recovery_receipt_missing' },
    { materializeError: new Error('stale'), code: 'job_mail_dkim_recovery_materialization_failed' },
    { evidence: false, code: 'job_mail_dkim_recovery_evidence_not_satisfied' },
  ]) {
    const { code, ...fixtureOptions } = options;
    const state = fixture(fixtureOptions);
    await assert.rejects(
      recoverRunningMailDkim(state.dependencies),
      (error) => error instanceof JobRunningMailDkimRecoveryError && error.code === code,
    );
    assert.equal(state.calls.some(([name]) => name === 'complete'), false);
  }
});

test('recovery refuses to inspect or mutate while YunPanel API is still active', async () => {
  const state = fixture({ servicesActive: true });
  await assert.rejects(
    recoverRunningMailDkim(state.dependencies),
    (error) => error instanceof JobRunningMailDkimRecoveryError
      && error.code === 'job_mail_dkim_recovery_consumers_must_be_stopped',
  );
  assert.deepEqual(state.calls, []);
});
