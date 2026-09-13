import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupExecutionPlan } from '../src/backup-execution-plan.js';
import {
  BackupExecutionStateError,
  normalizeBackupExecutionPlan,
} from '../src/backup-execution-state.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';
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

function execution() {
  const resources = [databaseResource('alpha', 1024), databaseResource('zeta', 2048)];
  const plan = {
    version: 1,
    serverId,
    previewDigest,
    confirmation: `backup:${serverId}:${previewDigest}`,
    selectionMode: 'explicit',
    resources,
    selectedResourceIdentities: resources.map((resource) => resource.identity).reverse(),
    sideEffects: false,
  };
  return createBackupExecutionPlan({
    plan,
    expectedPreviewDigest: previewDigest,
    confirmation: plan.confirmation,
  });
}

test('persisted execution validator round-trips producer output exactly', () => {
  const produced = execution();
  const normalized = normalizeBackupExecutionPlan(JSON.parse(JSON.stringify(produced)));

  assert.deepEqual(normalized, produced);
  assert.equal(normalized.steps.length, 2);
  assert.equal(normalized.steps[0].resourceIdentity.endsWith(':alpha'), true);
  assert.equal(normalized.steps[1].resourceIdentity.endsWith(':zeta'), true);
});

test('persisted execution validator rejects tampered step input even when stored digests are unchanged', () => {
  const tampered = JSON.parse(JSON.stringify(execution()));
  tampered.steps[0].input.sizeBytes += 1;

  assert.throws(
    () => normalizeBackupExecutionPlan(tampered),
    (error) => error instanceof BackupExecutionStateError
      && error.code === 'backup_execution_state_tampered',
  );
});

test('persisted execution validator rejects tampered aggregate digest and idempotency identity', () => {
  for (const field of ['executionDigest', 'idempotencyKey']) {
    const tampered = JSON.parse(JSON.stringify(execution()));
    tampered[field] = field === 'executionDigest' ? 'f'.repeat(64) : `general-backup:${'f'.repeat(64)}`;
    assert.throws(
      () => normalizeBackupExecutionPlan(tampered),
      (error) => error instanceof BackupExecutionStateError
        && error.code === 'backup_execution_state_tampered',
    );
  }
});

test('persisted execution validator rejects duplicate or reordered steps', () => {
  const duplicate = JSON.parse(JSON.stringify(execution()));
  duplicate.steps[1] = structuredClone(duplicate.steps[0]);
  assert.throws(
    () => normalizeBackupExecutionPlan(duplicate),
    (error) => error instanceof BackupExecutionStateError,
  );

  const reordered = JSON.parse(JSON.stringify(execution()));
  reordered.steps.reverse();
  assert.throws(
    () => normalizeBackupExecutionPlan(reordered),
    (error) => error instanceof BackupExecutionStateError
      && error.code === 'backup_execution_state_invalid',
  );
});

test('persisted execution validator rejects unsupported executor/input expansion', () => {
  const tampered = JSON.parse(JSON.stringify(execution()));
  tampered.steps[0].input.secret = 'must-not-be-persisted';
  assert.throws(
    () => normalizeBackupExecutionPlan(tampered),
    (error) => error instanceof BackupExecutionStateError
      && error.code === 'backup_execution_state_invalid',
  );
});
