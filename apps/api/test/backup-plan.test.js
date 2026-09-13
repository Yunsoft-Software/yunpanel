import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupManifest } from '../src/backup-manifest.js';
import { BackupPlanError, createBackupPlan } from '../src/backup-plan.js';
import { databaseBackupResources } from '../src/database-backup-resource.js';
import { mailDataBackupResource } from '../src/mail-data-backup-resource.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';
const inventoryJobId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const mailDomainId = 'f15f21e0-3ce8-47cf-93bf-d45c8c723246';

function baseManifest() {
  return createBackupManifest({
    serverId,
    dockerProjects: [{
      id: '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0',
      serverId,
      projectName: 'shop_stack',
      revision: 2,
      services: [{
        name: 'db',
        storageMounts: [
          { kind: 'named_volume', source: 'database', sourceScope: 'project', target: '/var/lib/mysql', readOnly: false },
          { kind: 'bind', source: '/srv/imports', sourceScope: 'host', target: '/imports', readOnly: true },
          { kind: 'ephemeral', source: null, sourceScope: null, target: '/run/cache', readOnly: false },
        ],
      }],
    }],
    applicationSnapshots: [{
      application: {
        id: applicationId,
        serverId,
        name: 'Storefront',
        type: 'node',
        desiredRevision: 4,
        appliedRevision: 3,
        currentReleaseId: releaseId,
        currentCommitSha: 'a'.repeat(40),
      },
      environment: {
        applicationId,
        savedRevision: 9,
        appliedRevision: 8,
        appliedReleaseId: releaseId,
      },
    }],
    createdAt: '2026-09-13T20:00:00.000Z',
  });
}

function databases(sizeBytes = 4096) {
  return databaseBackupResources({
    serverId,
    inventory: {
      engine: 'mariadb',
      version: '11.4.3-MariaDB',
      databases: [{ name: 'novasis', sizeBytes }],
      snapshot: { jobId: inventoryJobId, refreshedAt: '2026-09-13T20:01:00.000Z' },
    },
  });
}

function mail({ sourcePresent = true, bytes = 1234, sha = 'b'.repeat(64) } = {}) {
  return [mailDataBackupResource({
    serverId,
    preview: {
      version: 1,
      operation: 'mail_data_backup',
      mailDomainId,
      scope: 'domain',
      resourceId: mailDomainId,
      identity: 'example.com',
      expectedRevision: 5,
      snapshotSha256: sha,
      sourcePresent,
      bytes,
    },
  })];
}

test('default backup plan selects only resources admitted by policy across all resource types', () => {
  const plan = createBackupPlan({
    baseManifest: baseManifest(),
    databaseResources: databases(),
    mailDataResources: mail(),
  });

  assert.equal(plan.version, 1);
  assert.equal(plan.manifestVersion, 1);
  assert.equal(plan.serverId, serverId);
  assert.equal(plan.selectionMode, 'all_managed');
  assert.equal(plan.resources.length, 6);
  assert.deepEqual(plan.counts, {
    total: 6,
    selected: 4,
    included: 4,
    excluded: 1,
    rejected: 1,
  });
  assert.equal(plan.decisions.find((entry) => entry.policy.reason === 'arbitrary_host_bind').selected, false);
  assert.equal(plan.decisions.find((entry) => entry.policy.reason === 'ephemeral_storage').selected, false);
  assert.equal(plan.decisions.find((entry) => entry.type === 'database').selected, true);
  assert.equal(plan.decisions.find((entry) => entry.type === 'mail_data').selected, true);
  assert.match(plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.confirmation, `backup:${serverId}:${plan.previewDigest}`);
  assert.equal(plan.sideEffects, false);
});

test('backup plan digest is deterministic and changes with selected source evidence', () => {
  const first = createBackupPlan({ baseManifest: baseManifest(), databaseResources: databases(), mailDataResources: mail() });
  const repeated = createBackupPlan({ baseManifest: baseManifest(), databaseResources: databases(), mailDataResources: mail() });
  const changedDatabase = createBackupPlan({ baseManifest: baseManifest(), databaseResources: databases(5000), mailDataResources: mail() });
  const changedMail = createBackupPlan({ baseManifest: baseManifest(), databaseResources: databases(), mailDataResources: mail({ bytes: 2000, sha: 'c'.repeat(64) }) });

  assert.equal(first.previewDigest, repeated.previewDigest);
  assert.notEqual(first.previewDigest, changedDatabase.previewDigest);
  assert.notEqual(first.previewDigest, changedMail.previewDigest);
});

test('explicit backup selection is sorted, deterministic and cannot select rejected resources', () => {
  const all = createBackupPlan({ baseManifest: baseManifest(), databaseResources: databases(), mailDataResources: mail() });
  const selectable = all.resources.filter((resource) => resource.policy.disposition === 'include').map((resource) => resource.identity);
  const selected = [selectable[2], selectable[0]];
  const plan = createBackupPlan({
    baseManifest: baseManifest(),
    databaseResources: databases(),
    mailDataResources: mail(),
    selectedResourceIdentities: selected,
  });

  assert.equal(plan.selectionMode, 'explicit');
  assert.deepEqual(plan.selectedResourceIdentities, [...selected].sort());
  assert.equal(plan.counts.selected, 2);

  const rejected = all.resources.find((resource) => resource.policy.disposition === 'reject');
  assert.throws(
    () => createBackupPlan({
      baseManifest: baseManifest(),
      databaseResources: databases(),
      mailDataResources: mail(),
      selectedResourceIdentities: [rejected.identity],
    }),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_resource_not_selectable',
  );
});

test('absent mail data remains visible in decisions but is not selected', () => {
  const plan = createBackupPlan({
    baseManifest: baseManifest(),
    databaseResources: databases(),
    mailDataResources: mail({ sourcePresent: false, bytes: 0, sha: '0'.repeat(64) }),
  });
  const mailDecision = plan.decisions.find((entry) => entry.type === 'mail_data');
  assert.deepEqual(mailDecision.policy, { disposition: 'exclude', reason: 'mail_data_absent' });
  assert.equal(mailDecision.selected, false);
  assert.equal(plan.counts.excluded, 2);
});

test('backup plan rejects unknown, duplicated and tampered selections/resources', () => {
  assert.throws(
    () => createBackupPlan({
      baseManifest: baseManifest(),
      databaseResources: databases(),
      mailDataResources: mail(),
      selectedResourceIdentities: ['database:missing'],
    }),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_resource_not_found',
  );

  const resource = databases()[0];
  assert.throws(
    () => createBackupPlan({
      baseManifest: baseManifest(),
      databaseResources: [resource, resource],
      mailDataResources: mail(),
    }),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_resource_duplicate',
  );

  const tampered = JSON.parse(JSON.stringify(mail()[0]));
  tampered.policy = { disposition: 'include', reason: 'managed_database' };
  assert.throws(
    () => createBackupPlan({
      baseManifest: baseManifest(),
      databaseResources: databases(),
      mailDataResources: [tampered],
    }),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_resources_invalid',
  );
});
