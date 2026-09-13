import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackupManifestError,
  applicationBackupResource,
  createBackupManifest,
  normalizeBackupManifest,
} from '../src/backup-manifest.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';
const previousReleaseId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const commitSha = 'a'.repeat(40);

function application(overrides = {}) {
  return {
    id: applicationId,
    serverId,
    name: 'Storefront',
    type: 'node',
    desiredRevision: 4,
    appliedRevision: 3,
    currentReleaseId: releaseId,
    previousReleaseId,
    currentCommitSha: commitSha,
    repositoryUrl: 'https://github.com/example/storefront.git',
    runtime: { nodeMajor: 24, port: 3100 },
    releases: [{ releaseId, commitSha }],
    deploymentCredential: 'must-not-appear',
    webhookSecret: 'must-not-appear',
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    applicationId,
    savedRevision: 9,
    appliedRevision: 8,
    appliedReleaseId: releaseId,
    state: 'saved_on_disk',
    secretValue: 'must-not-appear',
    ...overrides,
  };
}

test('Application backup resource captures only stable identity and revision metadata', () => {
  const resource = applicationBackupResource(application(), environment());

  assert.equal(resource.identity, `application:${applicationId}`);
  assert.equal(resource.type, 'application');
  assert.equal(resource.serverId, serverId);
  assert.equal(resource.applicationType, 'node');
  assert.equal(resource.name, 'Storefront');
  assert.deepEqual(resource.policy, { disposition: 'include', reason: 'managed_application' });
  assert.deepEqual(resource.snapshot, {
    desiredRevision: 4,
    appliedRevision: 3,
    currentReleaseId: releaseId,
    currentCommitSha: commitSha,
    environment: {
      savedRevision: 9,
      appliedRevision: 8,
      appliedReleaseId: releaseId,
    },
  });

  const serialized = JSON.stringify(resource);
  assert.doesNotMatch(serialized, /must-not-appear/);
  assert.doesNotMatch(serialized, /repositoryUrl|runtime|releases|deploymentCredential|webhookSecret|secretValue/);
});

test('Application backup identity is stable across release, configuration and environment revisions', () => {
  const first = applicationBackupResource(application(), environment());
  const second = applicationBackupResource(application({
    desiredRevision: 5,
    appliedRevision: 5,
    currentReleaseId: previousReleaseId,
    currentCommitSha: 'b'.repeat(40),
  }), environment({
    savedRevision: 10,
    appliedRevision: 10,
    appliedReleaseId: previousReleaseId,
  }));

  assert.equal(first.identity, second.identity);
  assert.notDeepEqual(first.snapshot, second.snapshot);
});

test('Versioned manifest mixes Application and Docker resources without changing Docker policy identity', () => {
  const dockerProject = {
    id: '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0',
    serverId,
    projectName: 'store_stack',
    revision: 2,
    services: [{
      name: 'db',
      storageMounts: [
        { kind: 'named_volume', source: 'database', sourceScope: 'project', target: '/var/lib/mysql', readOnly: false },
        { kind: 'bind', source: '/srv/imports', sourceScope: 'host', target: '/imports', readOnly: true },
      ],
    }],
  };

  const manifest = createBackupManifest({
    serverId,
    dockerProjects: [dockerProject],
    applicationSnapshots: [{ application: application(), environment: environment() }],
    createdAt: '2026-09-13T20:00:00.000Z',
  });

  assert.deepEqual(manifest.counts, { total: 3, included: 2, excluded: 0, rejected: 1 });
  assert.equal(manifest.resources.filter((resource) => resource.type === 'application').length, 1);
  assert.equal(manifest.resources.filter((resource) => resource.type === 'docker_storage').length, 2);
  assert.equal(
    manifest.resources.find((resource) => resource.type === 'docker_storage' && resource.storage.source === '/srv/imports').policy.disposition,
    'reject',
  );
  assert.deepEqual(normalizeBackupManifest(JSON.parse(JSON.stringify(manifest))), manifest);
});

test('Draft Application backup uses explicit zero environment and release state', () => {
  const resource = applicationBackupResource(application({
    type: 'static',
    desiredRevision: 1,
    appliedRevision: 0,
    currentReleaseId: null,
    currentCommitSha: null,
  }));

  assert.equal(resource.applicationType, 'static');
  assert.deepEqual(resource.snapshot.environment, {
    savedRevision: 0,
    appliedRevision: null,
    appliedReleaseId: null,
  });
});

test('Application manifest rejects malformed commit state instead of normalizing it away', () => {
  assert.throws(
    () => applicationBackupResource(application({
      appliedRevision: 0,
      currentReleaseId: null,
      currentCommitSha: 'not-a-commit',
    })),
    (error) => error instanceof BackupManifestError && error.code === 'backup_manifest_application_invalid',
  );
});

test('Application manifest rejects environment metadata from another Application', () => {
  assert.throws(
    () => applicationBackupResource(application(), environment({
      applicationId: 'f15f21e0-3ce8-47cf-93bf-d45c8c723246',
    })),
    (error) => error instanceof BackupManifestError,
  );
});

test('Application manifest rejects tampered inclusion policy and unknown snapshot wrapper fields', () => {
  const manifest = JSON.parse(JSON.stringify(createBackupManifest({
    serverId,
    applicationSnapshots: [{ application: application(), environment: environment() }],
  })));
  manifest.resources[0].policy = { disposition: 'exclude', reason: 'ephemeral_storage' };
  assert.throws(
    () => normalizeBackupManifest(manifest),
    (error) => error instanceof BackupManifestError && error.code === 'backup_manifest_policy_invalid',
  );

  assert.throws(
    () => createBackupManifest({
      serverId,
      applicationSnapshots: [{ application: application(), environment: environment(), secret: 'ignored-before' }],
    }),
    (error) => error instanceof BackupManifestError && error.code === 'backup_manifest_applications_invalid',
  );
});
