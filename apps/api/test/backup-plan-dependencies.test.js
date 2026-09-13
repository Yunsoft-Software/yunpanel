import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupDependencyGraph } from '../src/backup-dependency-graph.js';
import { createBackupManifest } from '../src/backup-manifest.js';
import { BackupPlanError, createBackupPlan } from '../src/backup-plan.js';
import { databaseBackupResources } from '../src/database-backup-resource.js';
import { mailDataBackupResource } from '../src/mail-data-backup-resource.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const projectId = '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0';
const domainId = 'c2591ea3-e1c2-4c37-a194-cc5650acd9ef';
const databaseBindingId = 'd1432e13-edb5-49f5-8f9b-302c407c784b';
const mailDomainId = 'f15f21e0-3ce8-47cf-93bf-d45c8c723246';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';

function sources() {
  const baseManifest = createBackupManifest({
    serverId,
    dockerProjects: [{
      id: projectId,
      serverId,
      projectName: 'shop_stack',
      revision: 4,
      services: [{
        name: 'web',
        storageMounts: [{
          kind: 'named_volume', source: 'uploads', sourceScope: 'project', target: '/uploads', readOnly: false,
        }],
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
  return { baseManifest, databaseResources, mailDataResources };
}

function dependencyGraph({ websiteRevision = 7, bindingRevision = 3 } = {}) {
  const { baseManifest, databaseResources, mailDataResources } = sources();
  return createBackupDependencyGraph({
    serverId,
    resources: [...baseManifest.resources, ...databaseResources, ...mailDataResources],
    websites: [{
      id: websiteId,
      serverId,
      revision: websiteRevision,
      applicationId,
      managedComposeBinding: { projectId, serviceName: 'web', targetPort: 3000, protocol: 'tcp' },
    }],
    domains: [{
      id: domainId,
      serverId,
      websiteId,
      desiredRevision: 4,
      appliedRevision: 4,
    }],
    databaseBindings: [{
      id: databaseBindingId,
      serverId,
      databaseName: 'novasis',
      websiteId,
      applicationId,
      revision: bindingRevision,
    }],
    mailDomains: [{
      id: mailDomainId,
      managementMode: 'local',
      webDomainId: domainId,
      revision: 5,
    }],
  });
}

function plan(graph) {
  const input = sources();
  return createBackupPlan({ ...input, dependencyGraph: graph });
}

test('backup plan carries normalized dependency impact metadata in the preview identity', () => {
  const graph = dependencyGraph();
  const current = plan(graph);

  assert.deepEqual(current.dependencyGraph, graph);
  assert.equal(current.dependencyGraph.impacts.length, current.resources.length);
  assert.equal(current.dependencyGraph.impacts.every((impact) => impact.websiteIds.includes(websiteId)), true);
  assert.match(current.previewDigest, /^[a-f0-9]{64}$/);
});

test('backup preview digest changes when dependency revisions change without resource-byte changes', () => {
  const first = plan(dependencyGraph());
  const websiteChanged = plan(dependencyGraph({ websiteRevision: 8 }));
  const bindingChanged = plan(dependencyGraph({ bindingRevision: 4 }));

  assert.deepEqual(first.resources, websiteChanged.resources);
  assert.deepEqual(first.resources, bindingChanged.resources);
  assert.notEqual(first.previewDigest, websiteChanged.previewDigest);
  assert.notEqual(first.previewDigest, bindingChanged.previewDigest);
});

test('backup plan rejects dependency graphs that omit a resource or relabel its type', () => {
  const missing = structuredClone(dependencyGraph());
  missing.impacts.pop();
  missing.counts.resources -= 1;
  assert.throws(
    () => plan(missing),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_dependencies_invalid',
  );

  const tampered = structuredClone(dependencyGraph());
  tampered.impacts[0].resourceType = 'database';
  assert.throws(
    () => plan(tampered),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_dependencies_invalid',
  );
});

test('backup plan rejects duplicate dependency references and inconsistent counts', () => {
  const duplicated = structuredClone(dependencyGraph());
  duplicated.impacts[0].references.push({ ...duplicated.impacts[0].references[0] });
  assert.throws(
    () => plan(duplicated),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_dependencies_invalid',
  );

  const wrongCounts = structuredClone(dependencyGraph());
  wrongCounts.counts.associatedResources = 0;
  assert.throws(
    () => plan(wrongCounts),
    (error) => error instanceof BackupPlanError && error.code === 'backup_plan_dependencies_invalid',
  );
});
