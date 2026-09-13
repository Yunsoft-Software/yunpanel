import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createDockerComposeRecoveryService,
  DockerComposeRecoveryError,
} from '../src/docker-compose-recovery.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const jobId = '420e65d7-3205-43d7-89aa-8f2d66714ee0';

function runningJob(overrides = {}) {
  return {
    id: jobId,
    serverId,
    type: OPERATIONS.DOCKER_COMPOSE_START,
    operation: OPERATIONS.DOCKER_COMPOSE_START,
    resourceType: 'docker_project',
    resourceId: projectId,
    status: 'running',
    payload: {
      projectId,
      expectedProjectRevision: 3,
      expectedEnvironmentRevision: 2,
      expectedComposeSha256: 'a'.repeat(64),
      credentialRevisions: [],
    },
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    version: 1,
    serverId,
    jobId,
    operation: OPERATIONS.DOCKER_COMPOSE_START,
    projectId,
    projectRevision: 3,
    environmentRevision: 2,
    composeSha256: 'a'.repeat(64),
    action: 'start',
    runtimeState: 'running',
    executed: true,
    sideEffects: true,
    ...overrides,
  };
}

function fixture({ job = runningJob(), storedReceipt = receipt() } = {}) {
  const calls = [];
  let current = structuredClone(job);
  const registry = {
    recovery() { return { code: 'durable_job_reconciliation_required', jobs: [{ jobId: current.id, serverId: current.serverId }] }; },
    async getJob(id) { return id === current.id ? structuredClone(current) : null; },
    async beginReconciliation(input) {
      calls.push(['begin', input]);
      return { ...input, status: current.status, pending: true };
    },
    async complete(input) {
      calls.push(['complete', input]);
      current = { ...current, status: input.status, result: structuredClone(input.result) };
      return structuredClone(current);
    },
    async acknowledgeReconciliation(input) {
      calls.push(['ack', input]);
      return { ...input, status: current.status, acknowledged: true };
    },
  };
  const receiptStore = {
    async read(id) {
      calls.push(['read', id]);
      return storedReceipt === null ? null : structuredClone(storedReceipt);
    },
  };
  const reconcileCompletedJob = async (terminal) => {
    calls.push(['reconcile', terminal]);
    return { reconciled: true, error: null };
  };
  return {
    calls,
    registry,
    service: createDockerComposeRecoveryService({ jobRegistry: registry, receiptStore, reconcileCompletedJob }),
  };
}

test('running compose job is completed from an exact receipt without host re-execution', async () => {
  const fx = fixture();
  const result = await fx.service.recover();
  assert.deepEqual(result, {
    recovered: [{ jobId, serverId, status: 'succeeded', source: 'operation_receipt' }],
    pending: [],
  });
  assert.deepEqual(fx.calls.map(([name]) => name), ['read', 'begin', 'complete', 'reconcile', 'ack']);
  const completion = fx.calls.find(([name]) => name === 'complete')[1];
  assert.deepEqual(completion.result, {
    version: 1,
    projectId,
    projectRevision: 3,
    environmentRevision: 2,
    composeSha256: 'a'.repeat(64),
    action: 'start',
    runtimeState: 'running',
    executed: true,
    sideEffects: true,
  });
});

test('missing compose receipt keeps the running job pending and never completes it', async () => {
  const fx = fixture({ storedReceipt: null });
  const result = await fx.service.recover();
  assert.deepEqual(result, {
    recovered: [],
    pending: [{ jobId, serverId, reason: 'receipt_missing' }],
  });
  assert.deepEqual(fx.calls.map(([name]) => name), ['read']);
});

test('receipt drift is rejected instead of completing or replaying the mutation', async () => {
  const fx = fixture({ storedReceipt: receipt({ composeSha256: 'b'.repeat(64) }) });
  await assert.rejects(
    fx.service.recover(),
    (error) => error instanceof DockerComposeRecoveryError
      && error.code === 'docker_compose_recovery_receipt_mismatch',
  );
  assert.deepEqual(fx.calls.map(([name]) => name), ['read']);
});

test('terminal compose recovery only reconciles and acknowledges the durable result', async () => {
  const terminal = runningJob({
    status: 'succeeded',
    result: {
      version: 1,
      projectId,
      projectRevision: 3,
      environmentRevision: 2,
      composeSha256: 'a'.repeat(64),
      action: 'start',
      runtimeState: 'running',
      executed: true,
      sideEffects: true,
    },
  });
  const fx = fixture({ job: terminal, storedReceipt: null });
  const result = await fx.service.recover();
  assert.deepEqual(result, {
    recovered: [{ jobId, serverId, status: 'succeeded', source: 'durable_result' }],
    pending: [],
  });
  assert.deepEqual(fx.calls.map(([name]) => name), ['reconcile', 'ack']);
});
