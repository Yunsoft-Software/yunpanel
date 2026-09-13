import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackupManifestError,
  backupManifestInternals,
  createBackupManifest,
  dockerStorageBackupPolicy,
  dockerStorageBackupResources,
  normalizeBackupManifest,
} from '../src/backup-manifest.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

function project(overrides = {}) {
  return {
    id: projectId,
    serverId,
    projectName: 'shop_app',
    revision: 7,
    services: [{
      name: 'web',
      storageMounts: [
        { kind: 'named_volume', source: 'data', sourceScope: 'project', target: '/data', readOnly: false },
        { kind: 'bind', source: './config', sourceScope: 'project', target: '/app/config', readOnly: true },
        { kind: 'bind', source: '/srv/shared', sourceScope: 'host', target: '/shared', readOnly: false },
        { kind: 'ephemeral', source: null, sourceScope: null, target: '/run/cache', readOnly: false },
      ],
    }],
    ...overrides,
  };
}

test('docker storage policy includes managed storage but excludes ephemeral and rejects arbitrary host binds', () => {
  assert.deepEqual(
    dockerStorageBackupPolicy({ kind: 'named_volume', source: 'data', sourceScope: 'project', target: '/data', readOnly: false }),
    { disposition: 'include', reason: 'managed_named_volume' },
  );
  assert.deepEqual(
    dockerStorageBackupPolicy({ kind: 'bind', source: './config', sourceScope: 'project', target: '/config', readOnly: false }),
    { disposition: 'include', reason: 'managed_project_bind' },
  );
  assert.deepEqual(
    dockerStorageBackupPolicy({ kind: 'bind', source: '/srv/shared', sourceScope: 'host', target: '/shared', readOnly: false }),
    { disposition: 'reject', reason: 'arbitrary_host_bind' },
  );
  assert.deepEqual(
    dockerStorageBackupPolicy({ kind: 'ephemeral', source: null, sourceScope: null, target: '/tmp/cache', readOnly: false }),
    { disposition: 'exclude', reason: 'ephemeral_storage' },
  );
});

test('backup manifest carries deterministic Docker storage identities and policy counts', () => {
  const manifest = createBackupManifest({
    serverId,
    dockerProjects: [project()],
    createdAt: '2026-09-13T19:00:00.000Z',
  });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.serverId, serverId);
  assert.equal(manifest.createdAt, '2026-09-13T19:00:00.000Z');
  assert.deepEqual(manifest.counts, { total: 4, included: 2, excluded: 1, rejected: 1 });
  assert.equal(manifest.resources.every((resource) => resource.type === 'docker_storage'), true);
  assert.equal(manifest.resources.every((resource) => resource.identity.startsWith('docker-storage:')), true);
  assert.equal(manifest.resources.find((resource) => resource.storage.source === '/srv/shared').policy.disposition, 'reject');
  assert.equal(manifest.resources.find((resource) => resource.storage.kind === 'ephemeral').policy.disposition, 'exclude');
  assert.equal(manifest.resources.filter((resource) => resource.policy.disposition === 'include').length, 2);

  const roundTrip = normalizeBackupManifest(JSON.parse(JSON.stringify(manifest)));
  assert.deepEqual(roundTrip, manifest);
});

test('Docker storage policy identity is stable across unrelated project revisions and input ordering', () => {
  const first = dockerStorageBackupResources(project());
  const reversedMounts = [...project().services[0].storageMounts].reverse();
  const second = dockerStorageBackupResources(project({
    revision: 8,
    services: [{ name: 'web', storageMounts: reversedMounts }],
  }));

  assert.deepEqual(first.map((resource) => resource.identity), second.map((resource) => resource.identity));
  assert.deepEqual(first.map((resource) => resource.storage), second.map((resource) => resource.storage));
  assert.equal(first.every((resource) => resource.projectRevision === 7), true);
  assert.equal(second.every((resource) => resource.projectRevision === 8), true);
});

test('backup manifest rejects cross-server projects and duplicate Docker storage identities', () => {
  assert.throws(
    () => createBackupManifest({
      serverId,
      dockerProjects: [project({ serverId: '9d5ef7b5-cd0e-43e8-89ce-5b26e3cf6009' })],
    }),
    (error) => error instanceof BackupManifestError && error.code === 'backup_manifest_server_mismatch',
  );

  const duplicateService = project().services[0];
  assert.throws(
    () => createBackupManifest({
      serverId,
      dockerProjects: [project({ services: [duplicateService, duplicateService] })],
    }),
    (error) => error instanceof BackupManifestError && error.code === 'backup_manifest_duplicate_resource',
  );
});

test('backup manifest validation fails closed when a rejected host bind is relabeled as included', () => {
  const manifest = JSON.parse(JSON.stringify(createBackupManifest({ serverId, dockerProjects: [project()] })));
  const hostBind = manifest.resources.find((resource) => resource.storage.sourceScope === 'host');
  hostBind.policy = { disposition: 'include', reason: 'managed_project_bind' };

  assert.throws(
    () => normalizeBackupManifest(manifest),
    (error) => error instanceof BackupManifestError && error.code === 'backup_manifest_policy_invalid',
  );
});

test('backup manifest rejects unsafe project bind identity before a policy can be created', () => {
  assert.throws(
    () => dockerStorageBackupPolicy({
      kind: 'bind', source: './../outside', sourceScope: 'project', target: '/data', readOnly: false,
    }),
    (error) => error instanceof BackupManifestError && error.code === 'backup_manifest_storage_invalid',
  );
});

test('backup resource identity changes when the storage source changes but not when read-only mode changes', () => {
  const base = { kind: 'bind', source: './data', sourceScope: 'project', target: '/data', readOnly: false };
  const first = backupManifestInternals.dockerStorageIdentity({ projectId, serviceName: 'web', storage: base });
  const readOnly = backupManifestInternals.dockerStorageIdentity({ projectId, serviceName: 'web', storage: { ...base, readOnly: true } });
  const moved = backupManifestInternals.dockerStorageIdentity({ projectId, serviceName: 'web', storage: { ...base, source: './other' } });

  assert.equal(first, readOnly);
  assert.notEqual(first, moved);
});
