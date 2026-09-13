import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupExecutionOrchestrator, BackupExecutionOrchestratorError } from '../src/backup-execution-orchestrator.js';
import { createBackupOperationRegistry } from '../src/backup-operation-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const operationId = '2c387b02-8747-458a-b509-8f531d4d149e';
const previewDigest = 'a'.repeat(64);
const childJobId = '0bb78242-03a6-429f-9d17-7725c521437c';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const releaseId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';

function databaseResource() {
  return {
    identity: `database:${serverId}:novasis`,
    type: 'database',
    serverId,
    databaseName: 'novasis',
    snapshot: {
      engine: 'mariadb',
      databaseVersion: '11.4.3-MariaDB',
      sizeBytes: 4096,
      inventoryJobId,
      inventoryRefreshedAt: '2026-09-13T20:01:00.000Z',
    },
    policy: { disposition: 'include', reason: 'managed_database' },
  };
}

function applicationResource() {
  return {
    identity: `application:${applicationId}`,
    type: 'application',
    serverId,
    applicationId,
    name: 'Storefront',
    applicationType: 'node',
    snapshot: {
      desiredRevision: 3,
      appliedRevision: 3,
      currentReleaseId: releaseId,
      currentCommitSha: 'c'.repeat(40),
      environment: {
        savedRevision: 2,
        appliedRevision: 2,
        appliedReleaseId: releaseId,
      },
    },
    policy: { disposition: 'include', reason: 'managed_application' },
  };
}

function preview(resource) {
  return {
    version: 1,
    manifestVersion: 1,
    serverId,
    selectionMode: 'explicit',
    selectedResourceIdentities: [resource.identity],
    resources: [resource],
    previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
    counts: { total: 1, selected: 1, included: 1, excluded: 0, rejected: 0 },
    decisions: [{ identity: resource.identity, type: resource.type, selected: true, policy: resource.policy }],
    sideEffects: false,
  };
}

function clock() {
  let value = Date.parse('2026-09-13T20:10:00.000Z');
  return () => value += 1000;
}

function registry() {
  return createBackupOperationRegistry({ now: clock(), randomId: () => operationId });
}

test('child orchestration persists dispatch intent and reconciles without re-running prepare', async () => {
  const calls = { prepare: 0, enqueue: 0, evidence: 0 };
  const resource = databaseResource();
  const childJobDispatcher = {
    async prepare(_serverId, step) {
      calls.prepare += 1;
      return { workRef: { kind: 'job', id: `general-backup-step:${step.stepDigest}` } };
    },
    async enqueuePrepared(_serverId, step) {
      calls.enqueue += 1;
      return calls.enqueue === 1
        ? {
            id: childJobId,
            operation: 'database.backup',
            resourceType: 'database',
            resourceId: 'novasis',
            status: 'queued',
            result: null,
            error: null,
          }
        : {
            id: childJobId,
            operation: 'database.backup',
            resourceType: 'database',
            resourceId: 'novasis',
            status: 'succeeded',
            result: { backupId: childJobId },
            error: null,
          };
    },
    evidence() {
      calls.evidence += 1;
      return {
        artifactId: childJobId,
        contentSha256: 'b'.repeat(64),
        bytes: 1234,
        createdAt: '2026-09-13T20:10:10.000Z',
      };
    },
  };
  const operationRegistry = registry();
  const orchestrator = createBackupExecutionOrchestrator({
    backupResourceProvider: { async preview() { return preview(resource); } },
    backupOperationRegistry: operationRegistry,
    childJobDispatcher,
  });

  const created = await orchestrator.create({
    serverId,
    selectedResourceIdentities: [resource.identity],
    expectedPreviewDigest: previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
  });
  const first = await orchestrator.advance(created.id);
  assert.equal(first.waiting, true);
  assert.equal(first.operation.status, 'running');
  assert.equal(first.operation.steps[0].status, 'dispatched');
  assert.equal(calls.prepare, 1);
  assert.equal(calls.enqueue, 1);

  const second = await orchestrator.advance(created.id);
  assert.equal(second.waiting, false);
  assert.equal(second.operation.status, 'succeeded');
  assert.equal(second.operation.steps[0].status, 'succeeded');
  assert.equal(calls.prepare, 1);
  assert.equal(calls.enqueue, 2);
  assert.equal(calls.evidence, 1);
});

test('failed child job becomes terminal parent failure with bounded error', async () => {
  const resource = databaseResource();
  const orchestrator = createBackupExecutionOrchestrator({
    backupResourceProvider: { async preview() { return preview(resource); } },
    backupOperationRegistry: registry(),
    childJobDispatcher: {
      async prepare(_serverId, step) {
        return { workRef: { kind: 'job', id: `general-backup-step:${step.stepDigest}` } };
      },
      async enqueuePrepared() {
        return {
          id: childJobId,
          status: 'failed',
          error: { code: 'database_dump_failed', message: '/private/path/should/not/persist' },
        };
      },
      evidence() { throw new Error('must not be called'); },
    },
  });
  const created = await orchestrator.create({
    serverId,
    selectedResourceIdentities: [resource.identity],
    expectedPreviewDigest: previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
  });
  const result = await orchestrator.advance(created.id);
  assert.equal(result.operation.status, 'failed');
  assert.deepEqual(result.operation.error, {
    code: 'database_dump_failed',
    message: 'Backup child job failed',
  });
});

test('local executor follows the same durable prepare then evidence completion contract', async () => {
  const resource = applicationResource();
  const calls = { prepare: 0, execute: 0 };
  const orchestrator = createBackupExecutionOrchestrator({
    backupResourceProvider: { async preview() { return preview(resource); } },
    backupOperationRegistry: registry(),
    childJobDispatcher: {
      async prepare() { throw new Error('child dispatcher must not be used'); },
      async enqueuePrepared() { throw new Error('child dispatcher must not be used'); },
      evidence() { throw new Error('child dispatcher must not be used'); },
    },
    localExecutors: {
      application_snapshot: {
        async prepare(_serverId, step) {
          calls.prepare += 1;
          return { workRef: { kind: 'local', id: `local:${step.stepDigest}` } };
        },
        async executePrepared(_serverId, _step, workRef) {
          calls.execute += 1;
          assert.match(workRef.id, /^local:/);
          return {
            evidence: {
              artifactId: `application:${applicationId}`,
              contentSha256: 'd'.repeat(64),
              bytes: 8192,
              createdAt: '2026-09-13T20:10:10.000Z',
            },
          };
        },
      },
    },
  });
  const created = await orchestrator.create({
    serverId,
    selectedResourceIdentities: [resource.identity],
    expectedPreviewDigest: previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
  });
  const result = await orchestrator.advance(created.id);
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(calls.prepare, 1);
  assert.equal(calls.execute, 1);
});

test('execution creation fails before durable mutation when a selected executor is unavailable', async () => {
  const resource = applicationResource();
  let created = 0;
  const orchestrator = createBackupExecutionOrchestrator({
    backupResourceProvider: { async preview() { return preview(resource); } },
    backupOperationRegistry: {
      async create() { created += 1; },
      async start() {},
      async linkStep() {},
      async succeedStep() {},
      async failStep() {},
      async getOperation() {},
    },
    childJobDispatcher: {
      async prepare() {},
      async enqueuePrepared() {},
      evidence() {},
    },
  });
  await assert.rejects(
    () => orchestrator.create({
      serverId,
      selectedResourceIdentities: [resource.identity],
      expectedPreviewDigest: previewDigest,
      confirmation: `backup:${serverId}:${previewDigest}`,
    }),
    (error) => error instanceof BackupExecutionOrchestratorError
      && error.code === 'backup_executor_unavailable'
      && error.status === 503,
  );
  assert.equal(created, 0);
});
