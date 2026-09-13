import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupDependencyGraph, BackupDependencyGraphError } from '../src/backup-dependency-graph.js';
import { createBackupManifest } from '../src/backup-manifest.js';
import { databaseBackupResources } from '../src/database-backup-resource.js';
import { mailDataBackupResource } from '../src/mail-data-backup-resource.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const projectId = '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0';
const domainId = 'c2591ea3-e1c2-4c37-a194-cc5650acd9ef';
const databaseBindingId = 'd1432e13-edb5-49f5-8f9b-302c407c784b';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';
const mailDomainId = 'f15f21e0-3ce8-47cf-93bf-d45c8c723246';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';

function resources() {
  const manifest = createBackupManifest({
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
  const database = databaseBackupResources({
    serverId,
    inventory: {
      engine: 'mariadb',
      version: '11.4.3-MariaDB',
      databases: [{ name: 'novasis', sizeBytes: 4096 }],
      snapshot: { jobId: inventoryJobId, refreshedAt: '2026-09-13T20:01:00.000Z' },
    },
  });
  const mail = mailDataBackupResource({
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
  });
  return [...manifest.resources, ...database, mail];
}

function state(overrides = {}) {
  return {
    serverId,
    resources: resources(),
    websites: [{
      id: websiteId,
      serverId,
      name: 'Storefront',
      revision: 7,
      applicationId,
      managedComposeBinding: { projectId, serviceName: 'web', targetPort: 3000, protocol: 'tcp' },
    }],
    domains: [{
      id: domainId,
      serverId,
      websiteId,
      primaryDomain: 'example.com',
      desiredRevision: 4,
      appliedRevision: 4,
    }],
    databaseBindings: [{
      id: databaseBindingId,
      serverId,
      databaseName: 'novasis',
      websiteId,
      applicationId,
      revision: 3,
    }],
    mailDomains: [{
      id: mailDomainId,
      domainName: 'example.com',
      webDomainId: domainId,
      managementMode: 'local',
      revision: 5,
    }],
    ...overrides,
  };
}

test('backup dependency graph maps Application, database, Docker storage and Mail data to Website/Domain impact', () => {
  const graph = createBackupDependencyGraph(state());

  assert.equal(graph.version, 1);
  assert.equal(graph.serverId, serverId);
  assert.deepEqual(graph.counts, { resources: 4, associatedResources: 4, websites: 1, domains: 1 });
  assert.equal(graph.impacts.length, 4);

  for (const impact of graph.impacts) {
    assert.deepEqual(impact.websiteIds, [websiteId]);
    assert.deepEqual(impact.domainIds, [domainId]);
    assert.equal(impact.references.some((reference) => reference.type === 'website' && reference.revision === 7), true);
    assert.equal(impact.references.some((reference) => reference.type === 'domain'
      && reference.revision === 4 && reference.appliedRevision === 4), true);
  }

  const databaseImpact = graph.impacts.find((impact) => impact.resourceType === 'database');
  assert.equal(databaseImpact.references.some((reference) => reference.type === 'database_binding'
    && reference.id === databaseBindingId && reference.revision === 3), true);

  const mailImpact = graph.impacts.find((impact) => impact.resourceType === 'mail_data');
  assert.equal(mailImpact.references.some((reference) => reference.type === 'mail_domain'
    && reference.id === mailDomainId && reference.revision === 5), true);
});

test('backup dependency graph remains deterministic when inventory ordering changes', () => {
  const input = state();
  const first = createBackupDependencyGraph(input);
  const second = createBackupDependencyGraph({
    ...input,
    resources: [...input.resources].reverse(),
    websites: [...input.websites].reverse(),
    domains: [...input.domains].reverse(),
    databaseBindings: [...input.databaseBindings].reverse(),
    mailDomains: [...input.mailDomains].reverse(),
  });
  assert.deepEqual(second, first);
});

test('unbound managed resources stay visible with empty Website/Domain impact', () => {
  const graph = createBackupDependencyGraph(state({
    websites: [],
    domains: [],
    databaseBindings: [],
    mailDomains: [],
    resources: resources().filter((resource) => resource.type !== 'mail_data'),
  }));

  assert.equal(graph.counts.resources, 3);
  assert.equal(graph.counts.associatedResources, 0);
  assert.equal(graph.impacts.every((impact) => impact.websiteIds.length === 0 && impact.domainIds.length === 0), true);
});

test('backup dependency graph fails closed on stale database ownership', () => {
  assert.throws(
    () => createBackupDependencyGraph(state({
      databaseBindings: [{
        id: databaseBindingId,
        serverId,
        databaseName: 'novasis',
        websiteId,
        applicationId: '771abf90-ec8c-450b-bbe5-23f5f68fd9b0',
        revision: 3,
      }],
    })),
    (error) => error instanceof BackupDependencyGraphError
      && error.code === 'backup_dependency_database_binding_stale'
      && error.status === 409,
  );
});

test('backup dependency graph fails closed when a Mail resource loses its domain association', () => {
  assert.throws(
    () => createBackupDependencyGraph(state({ domains: [] })),
    (error) => error instanceof BackupDependencyGraphError
      && error.code === 'backup_dependency_website_missing'
      && error.status === 409,
  );
});
