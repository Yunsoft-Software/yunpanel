import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  recoverRunningDatabaseCredential,
  JobRunningDatabaseCredentialRecoveryError,
} from '../src/job-running-database-credential-recovery.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const jobId = 'database-credential-job-0001';
const credentialId = '22345678-1234-4234-8234-123456789012';
const bindingId = '32345678-1234-4234-8234-123456789012';
const desired = 'a'.repeat(64);
const username = 'ydb_0123456789abcdef01234567';

function payload() {
  return {
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    expectedCredentialRevision: 3,
    expectedBindingRevision: 2,
    desiredStateSha256: desired,
  };
}

function result(operation) {
  return {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 2,
    databaseName: 'app_main',
    username,
    host: 'localhost',
    desiredStateSha256: desired,
    [operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'applied' : 'deleted']: true,
    sideEffects: true,
  };
}

function fixture({ operation = OPERATIONS.DATABASE_CREDENTIAL_APPLY, evidenceOverride = {}, bundleOverride = {} } = {}) {
  const completed = [];
  const job = {
    id: jobId,
    serverId,
    status: 'running',
    operation,
    resourceType: 'database',
    resourceId: 'app_main',
    payload: payload(),
  };
  const context = structuredClone(job);
  const receipt = { serverId, jobId, operation, result: result(operation) };
  const bundle = {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 2,
    desiredStateSha256: desired,
    databaseName: 'app_main',
    username,
    host: 'localhost',
    privileges: ['SELECT', 'INSERT'],
    ...bundleOverride,
  };
  const evidence = operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY
    ? {
      version: 1,
      engine: 'mariadb',
      databaseCredentialId: credentialId,
      databaseBindingId: bindingId,
      databaseName: 'app_main',
      username,
      host: 'localhost',
      desiredStateSha256: desired,
      accountPresent: true,
      markerHealthy: true,
      grantsHealthy: true,
      applied: true,
      sideEffects: false,
      ...evidenceOverride,
    }
    : {
      version: 1,
      engine: 'mariadb',
      databaseCredentialId: credentialId,
      databaseBindingId: bindingId,
      databaseName: 'app_main',
      username,
      host: 'localhost',
      desiredStateSha256: desired,
      accountPresent: false,
      markerPresent: false,
      deleted: true,
      sideEffects: false,
      ...evidenceOverride,
    };
  const jobRegistry = {
    async getJob(id) { return id === jobId ? structuredClone(job) : null; },
    async beginReconciliation(identity) { return { ...identity, status: 'running', pending: true }; },
    async complete(input) {
      completed.push(structuredClone(input));
      return { ...job, status: 'succeeded', result: structuredClone(input.result) };
    },
    async acknowledgeReconciliation(identity) { return { ...identity, status: 'succeeded', acknowledged: true }; },
  };
  return {
    completed,
    args: {
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: async () => structuredClone(context),
      readReceipt: async () => structuredClone(receipt),
      materializeDesiredState: async () => structuredClone(bundle),
      inspectLiveState: async () => structuredClone(evidence),
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation, resourceType: 'database', resourceId: 'app_main' }],
      }),
      reconcile: async () => ({ reconciled: true }),
    },
  };
}

test('database credential apply recovery closes only exact receipt and live evidence', async () => {
  const state = fixture();
  const recovered = await recoverRunningDatabaseCredential(state.args);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.operation, OPERATIONS.DATABASE_CREDENTIAL_APPLY);
  assert.equal(recovered.recoveryMethod, 'verified_database_credential_receipt_marker_and_grants');
  assert.equal(state.completed.length, 1);
  assert.equal(state.completed[0].result.desiredStateSha256, desired);
  assert.equal(Object.hasOwn(state.completed[0].result, 'password'), false);
});

test('database credential delete recovery requires account and marker absence', async () => {
  const healthy = fixture({ operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE });
  const recovered = await recoverRunningDatabaseCredential(healthy.args);
  assert.equal(recovered.recoveryMethod, 'verified_database_credential_receipt_and_absence');

  const stale = fixture({
    operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    evidenceOverride: { markerPresent: true, deleted: false },
  });
  await assert.rejects(
    recoverRunningDatabaseCredential(stale.args),
    (error) => error instanceof JobRunningDatabaseCredentialRecoveryError
      && error.code === 'job_database_credential_recovery_evidence_not_satisfied',
  );
  assert.equal(stale.completed.length, 0);
});

test('database credential recovery refuses desired-state drift', async () => {
  const state = fixture({ bundleOverride: { credentialRevision: 4 } });
  await assert.rejects(
    recoverRunningDatabaseCredential(state.args),
    (error) => error instanceof JobRunningDatabaseCredentialRecoveryError
      && error.code === 'job_database_credential_recovery_desired_state_mismatch',
  );
  assert.equal(state.completed.length, 0);
});
