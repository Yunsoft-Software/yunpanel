import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackupExecutionPlan } from '../src/backup-execution-plan.js';
import {
  BackupOperationRegistryError,
  createBackupOperationRegistry,
} from '../src/backup-operation-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';
const operationId = '2c387b02-8747-458a-b509-8f531d4d149e';
const previewDigest = 'a'.repeat(64);

function databaseResource(name, sizeBytes) {
  return {
    identity: `database:${serverId}:${name}`,
    type: 'database',
    serverId,
    databaseName: name,
    snapshot: {
      engine: 'mariadb',
      databaseVersion: '11.4.3-MariaDB',
      sizeBytes,
      inventoryJobId,
      inventoryRefreshedAt: '2026-09-13T20:01:00.000Z',
    },
    policy: { disposition: 'include', reason: 'managed_database' },
  };
}

function executionPlan(names = ['alpha', 'zeta']) {
  const resources = names.map((name, index) => databaseResource(name, 1024 + index));
  const plan = {
    version: 1,
    serverId,
    previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
    selectionMode: 'explicit',
    resources,
    selectedResourceIdentities: resources.map((resource) => resource.identity),
    sideEffects: false,
  };
  return createBackupExecutionPlan({
    plan,
    expectedPreviewDigest: previewDigest,
    confirmation: plan.confirmation,
  });
}

function clock() {
  let value = Date.parse('2026-09-13T20:10:00.000Z');
  return () => value += 1000;
}

function evidence(artifactId, sha = 'b'.repeat(64), bytes = 2048) {
  return {
    artifactId,
    contentSha256: sha,
    bytes,
    createdAt: '2026-09-13T20:11:00.000Z',
  };
}

async function temporaryStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-backup-operation-'));
  return {
    directory,
    filePath: path.join(directory, 'operations.json'),
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}

test('aggregate backup operation persists private durable state and survives restart', async () => {
  const store = await temporaryStore();
  try {
    const registry = createBackupOperationRegistry({
      filePath: store.filePath,
      now: clock(),
      randomId: () => operationId,
    });
    await registry.init();
    const created = await registry.create(executionPlan());
    assert.equal(created.status, 'queued');
    assert.equal(created.steps.every((step) => step.status === 'pending'), true);

    const started = await registry.start(created.id);
    const first = started.plan.steps[0];
    const workRef = { kind: 'job', id: '0bb78242-03a6-429f-9d17-7725c521437c' };
    await registry.linkStep({ operationId: created.id, stepId: first.stepId, workRef });

    const mode = (await stat(store.filePath)).mode & 0o777;
    assert.equal(mode, 0o600);

    const restarted = createBackupOperationRegistry({ filePath: store.filePath, now: clock() });
    await restarted.init();
    const recovered = await restarted.getOperation(created.id);
    assert.equal(recovered.status, 'running');
    assert.equal(recovered.steps[0].status, 'dispatched');
    assert.deepEqual(recovered.steps[0].workRef, workRef);
    assert.equal(recovered.steps[1].status, 'pending');
  } finally {
    await store.cleanup();
  }
});

test('child dispatch and success evidence are idempotent but conflicting evidence is rejected', async () => {
  const registry = createBackupOperationRegistry({ now: clock(), randomId: () => operationId });
  const created = await registry.create(executionPlan(['alpha']));
  const running = await registry.start(created.id);
  const step = running.plan.steps[0];
  const workRef = { kind: 'job', id: '0bb78242-03a6-429f-9d17-7725c521437c' };

  const linked = await registry.linkStep({ operationId: created.id, stepId: step.stepId, workRef });
  const linkedAgain = await registry.linkStep({ operationId: created.id, stepId: step.stepId, workRef });
  assert.deepEqual(linkedAgain, linked);

  const completed = await registry.succeedStep({
    operationId: created.id,
    stepId: step.stepId,
    workRef,
    evidence: evidence(workRef.id),
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.steps[0].status, 'succeeded');

  const repeated = await registry.succeedStep({
    operationId: created.id,
    stepId: step.stepId,
    workRef,
    evidence: evidence(workRef.id),
  });
  assert.deepEqual(repeated, completed);

  await assert.rejects(
    () => registry.succeedStep({
      operationId: created.id,
      stepId: step.stepId,
      workRef,
      evidence: evidence(workRef.id, 'c'.repeat(64)),
    }),
    (error) => error instanceof BackupOperationRegistryError
      && error.code === 'backup_step_completion_conflict'
      && error.status === 409,
  );
});

test('failed child work makes the aggregate operation terminal without retrying the step', async () => {
  const registry = createBackupOperationRegistry({ now: clock(), randomId: () => operationId });
  const created = await registry.create(executionPlan(['alpha', 'zeta']));
  const running = await registry.start(created.id);
  const step = running.plan.steps[0];
  const workRef = { kind: 'job', id: '0bb78242-03a6-429f-9d17-7725c521437c' };
  await registry.linkStep({ operationId: created.id, stepId: step.stepId, workRef });

  const failed = await registry.failStep({
    operationId: created.id,
    stepId: step.stepId,
    workRef,
    error: { code: 'database_backup_failed', message: 'Database backup failed' },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps[0].status, 'failed');
  assert.equal(failed.steps[1].status, 'pending');

  await assert.rejects(
    () => registry.linkStep({ operationId: created.id, stepId: step.stepId, workRef }),
    (error) => error instanceof BackupOperationRegistryError
      && error.code === 'backup_operation_not_running',
  );
});

test('operation creation is idempotent and blocks different active work on the same Server', async () => {
  const registry = createBackupOperationRegistry({ now: clock(), randomId: () => operationId });
  const plan = executionPlan(['alpha']);
  const first = await registry.create(plan);
  const repeated = await registry.create(plan);
  assert.deepEqual(repeated, first);

  const other = executionPlan(['zeta']);
  await assert.rejects(
    () => registry.create(other),
    (error) => error instanceof BackupOperationRegistryError
      && error.code === 'backup_operation_conflict'
      && error.status === 409,
  );
});

test('registry startup fails closed when persisted execution evidence is tampered', async () => {
  const store = await temporaryStore();
  try {
    const registry = createBackupOperationRegistry({
      filePath: store.filePath,
      now: clock(),
      randomId: () => operationId,
    });
    await registry.create(executionPlan(['alpha']));
    const persisted = JSON.parse(await readFile(store.filePath, 'utf8'));
    persisted.operations[0].plan.steps[0].input.sizeBytes += 10;
    await writeFile(store.filePath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });

    const restarted = createBackupOperationRegistry({ filePath: store.filePath });
    await assert.rejects(
      () => restarted.init(),
      (error) => error instanceof BackupOperationRegistryError
        && error.code === 'backup_operation_store_invalid'
        && error.status === 409,
    );
  } finally {
    await store.cleanup();
  }
});
