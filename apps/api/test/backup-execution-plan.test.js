import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupExecutionPlan, BackupExecutionPlanError } from '../src/backup-execution-plan.js';
import { createBackupManifest } from '../src/backup-manifest.js';
import { createBackupPlan } from '../src/backup-plan.js';
import { databaseBackupResources } from '../src/database-backup-resource.js';
import { mailDataBackupResource } from '../src/mail-data-backup-resource.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';
const projectId = '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';
const mailDomainId = 'f15f21e0-3ce8-47cf-93bf-d45c8c723246';

function preview({ selectedResourceIdentities = null } = {}) {
  const baseManifest = createBackupManifest({
    serverId,
    dockerProjects: [{
      id: projectId,
      serverId,
      projectName: 'shop_stack',
      revision: 4,
      services: [{
        name: 'web',
        storageMounts: [
          { kind: 'named_volume', source: 'uploads', sourceScope: 'project', target: '/app/uploads', readOnly: false },
          { kind: 'ephemeral', source: null, sourceScope: null, target: '/tmp/cache', readOnly: false },
        ],
      }],
    }],
    applicationSnapshots: [{
      application: {
        id: applicationId,
        serverId,
        name: 'Storefront',
        type: 'node',
        desiredRevision: 3,
        appliedRevision: 3,
        currentReleaseId: releaseId,
        currentCommitSha: 'a'.repeat(40),
      },
      environment: {
        applicationId,
        savedRevision: 2,
        appliedRevision: 2,
        appliedReleaseId: releaseId,
      },
    }],
    createdAt: '2026-09-13T20:00:00.000Z',
  });
  const databaseResources = databaseBackupResources({
    serverId,
    inventory: {
      engine: 'mariadb',
      version: '11.4.3-MariaDB',
      databases: [{ name: 'novasis', sizeBytes: 4096 }],
      snapshot: { jobId: inventoryJobId, refreshedAt: '2026-09-13T20:01:00.000Z' },
    },
  });
  const mailDataResources = [mailDataBackupResource({
    serverId,
    preview: {
      version: 1,
      operation: 'mail_data_backup',
      mailDomainId,
      scope: 'domain',
      resourceId: mailDomainId,
      identity: 'example.com',
      expectedRevision: 5,
      snapshotSha256: 'b'.repeat(64),
      sourcePresent: true,
      bytes: 2048,
    },
  })];
  return createBackupPlan({
    baseManifest,
    databaseResources,
    mailDataResources,
    selectedResourceIdentities,
  });
}

function execute(plan) {
  return createBackupExecutionPlan({
    plan,
    expectedPreviewDigest: plan.previewDigest,
    confirmation: plan.confirmation,
  });
}

test('aggregate execution contract creates one deterministic typed step per selected resource', () => {
  const current = preview();
  const execution = execute(current);

  assert.equal(execution.version, 1);
  assert.equal(execution.serverId, serverId);
  assert.equal(execution.previewDigest, current.previewDigest);
  assert.equal(execution.steps.length, 4);
  assert.deepEqual(
    execution.steps.map((step) => step.executorKind).sort(),
    ['application_snapshot', 'database_backup', 'docker_storage_backup', 'mail_data_backup'],
  );
  assert.equal(execution.steps.every((step) => /^backup-step:[a-f0-9]{64}$/.test(step.stepId)), true);
  assert.match(execution.executionDigest, /^[a-f0-9]{64}$/);
  assert.equal(execution.idempotencyKey, `general-backup:${execution.executionDigest}`);
  assert.equal(execution.sideEffects, true);

  const docker = execution.steps.find((step) => step.executorKind === 'docker_storage_backup');
  assert.deepEqual(docker.input.storage, {
    kind: 'named_volume', source: 'uploads', sourceScope: 'project', target: '/app/uploads', readOnly: false,
  });
  const database = execution.steps.find((step) => step.executorKind === 'database_backup');
  assert.equal(database.input.databaseName, 'novasis');
  assert.equal(database.input.inventoryJobId, inventoryJobId);
  const mail = execution.steps.find((step) => step.executorKind === 'mail_data_backup');
  assert.equal(mail.input.mailDomainId, mailDomainId);
  assert.equal(mail.input.expectedRevision, 5);
  assert.equal(mail.input.expectedSnapshotSha256, 'b'.repeat(64));
});

test('aggregate execution contract is deterministic for the same current preview', () => {
  const current = preview();
  const first = execute(current);
  const second = execute(structuredClone(current));
  assert.deepEqual(second, first);
});

test('explicit selection only materializes selected include resources', () => {
  const all = preview();
  const application = all.resources.find((resource) => resource.type === 'application');
  const database = all.resources.find((resource) => resource.type === 'database');
  const current = preview({ selectedResourceIdentities: [database.identity, application.identity] });
  const execution = execute(current);

  assert.equal(execution.steps.length, 2);
  assert.deepEqual(
    execution.steps.map((step) => step.resourceIdentity).sort(),
    [application.identity, database.identity].sort(),
  );
});

test('aggregate execution contract rejects stale preview digest and wrong confirmation', () => {
  const current = preview();
  assert.throws(
    () => createBackupExecutionPlan({
      plan: current,
      expectedPreviewDigest: 'f'.repeat(64),
      confirmation: current.confirmation,
    }),
    (error) => error instanceof BackupExecutionPlanError
      && error.code === 'backup_execution_preview_stale'
      && error.status === 409,
  );
  assert.throws(
    () => createBackupExecutionPlan({
      plan: current,
      expectedPreviewDigest: current.previewDigest,
      confirmation: `backup:${serverId}:${'0'.repeat(64)}`,
    }),
    (error) => error instanceof BackupExecutionPlanError
      && error.code === 'backup_execution_confirmation_invalid'
      && error.status === 409,
  );
});

test('aggregate execution contract refuses tampered excluded resources even if injected into selection', () => {
  const current = structuredClone(preview());
  const ephemeral = current.resources.find((resource) => resource.type === 'docker_storage'
    && resource.policy.disposition === 'exclude');
  current.selectedResourceIdentities.push(ephemeral.identity);
  current.selectedResourceIdentities.sort();

  assert.throws(
    () => createBackupExecutionPlan({
      plan: current,
      expectedPreviewDigest: current.previewDigest,
      confirmation: current.confirmation,
    }),
    (error) => error instanceof BackupExecutionPlanError
      && error.code === 'backup_execution_resource_not_selectable'
      && error.status === 409,
  );
});
