import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackupApplicationLocalExecutorError,
  backupApplicationLocalExecutorInternals,
  createBackupApplicationLocalExecutor,
} from '../src/backup-application-local-executor.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';
const previousReleaseId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';

function application(overrides = {}) {
  return {
    id: applicationId,
    serverId,
    name: 'Storefront',
    type: 'node',
    repositoryUrl: 'https://github.com/example/storefront.git',
    branch: 'main',
    retention: 5,
    desiredRevision: 4,
    appliedRevision: 3,
    currentReleaseId: releaseId,
    previousReleaseId,
    currentCommitSha: 'a'.repeat(40),
    currentGitTarget: { kind: 'branch', value: 'main' },
    build: null,
    runtime: { nodeMajor: 24, port: 3100, healthPath: '/health' },
    activeRuntime: { nodeMajor: 24, port: 3100, healthPath: '/health' },
    activeDeploymentId: null,
    deploymentCredential: 'must-not-appear',
    githubWebhookSecret: 'must-not-appear',
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    applicationId,
    savedRevision: 9,
    appliedRevision: 8,
    appliedReleaseId: releaseId,
    ...overrides,
  };
}

function step(overrides = {}) {
  return {
    stepId: `backup-step:${'b'.repeat(64)}`,
    stepDigest: 'b'.repeat(64),
    resourceIdentity: `application:${applicationId}`,
    resourceType: 'application',
    executorKind: 'application_snapshot',
    input: {
      applicationId,
      applicationType: 'node',
      desiredRevision: 4,
      appliedRevision: 3,
      currentReleaseId: releaseId,
      currentCommitSha: 'a'.repeat(40),
      environment: {
        savedRevision: 9,
        appliedRevision: 8,
        appliedReleaseId: releaseId,
      },
    },
    ...overrides,
  };
}

function fixture({ applicationValue = application(), environmentValue = environment(), values = { ZETA: '2', ALPHA: 'secret-value' } } = {}) {
  const calls = { status: [], materialize: [], archive: [] };
  const executor = createBackupApplicationLocalExecutor({
    applicationRegistry: {
      async getApplication(id) {
        assert.equal(id, applicationId);
        return applicationValue;
      },
    },
    applicationEnvironmentRegistry: {
      async environmentStatus(id, options) {
        calls.status.push({ id, options });
        return environmentValue;
      },
      async materialize(id, options) {
        calls.materialize.push({ id, options });
        return values;
      },
    },
    localBackupArtifactManager: {
      async archive(request) {
        calls.archive.push(request);
        return {
          artifactId: request.artifactId,
          contentSha256: 'c'.repeat(64),
          bytes: 12345,
          createdAt: '2026-09-13T20:10:00.000Z',
        };
      },
    },
  });
  return { executor, calls };
}

test('Application local executor verifies live state and archives exact active Node release plus materialized env', async () => {
  const { executor, calls } = fixture();
  const currentStep = step();
  const prepared = await executor.prepare(serverId, currentStep);
  assert.deepEqual(prepared.workRef, { kind: 'local', id: `application-backup:${currentStep.stepDigest}` });

  const result = await executor.executePrepared(serverId, currentStep, prepared.workRef);
  assert.equal(result.evidence.artifactId, currentStep.stepDigest);
  assert.equal(calls.status.length, 1);
  assert.deepEqual(calls.materialize, [{ id: applicationId, options: { expectedRevision: 9 } }]);
  assert.equal(calls.archive.length, 1);
  assert.deepEqual(calls.archive[0].entries, [{
    directory: `${backupApplicationLocalExecutorInternals.nodeReleaseRoot}/${applicationId}/releases`,
    name: releaseId,
  }]);
  assert.equal(calls.archive[0].artifactId, currentStep.stepDigest);
  assert.equal(calls.archive[0].sourceDigest, currentStep.stepDigest);

  const control = JSON.parse(calls.archive[0].inlineFiles.find((file) => file.name === 'control.json').content);
  const materialized = JSON.parse(calls.archive[0].inlineFiles.find((file) => file.name === 'environment.json').content);
  assert.equal(control.applicationId, applicationId);
  assert.equal(control.currentReleaseId, releaseId);
  assert.equal(control.previousReleaseId, previousReleaseId);
  assert.deepEqual(materialized, { ALPHA: 'secret-value', ZETA: '2' });
  const controlText = JSON.stringify(control);
  assert.doesNotMatch(controlText, /must-not-appear|deploymentCredential|githubWebhookSecret/);
});

test('static Application uses the published static release root and preserves appliedRevision zero', async () => {
  const staticApplication = application({
    type: 'static',
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
    runtime: null,
    activeRuntime: null,
    appliedRevision: 0,
  });
  const staticStep = step({
    input: {
      ...step().input,
      applicationType: 'static',
      appliedRevision: 0,
    },
  });
  const { executor, calls } = fixture({ applicationValue: staticApplication });
  const prepared = await executor.prepare(serverId, staticStep);
  await executor.executePrepared(serverId, staticStep, prepared.workRef);
  assert.deepEqual(calls.archive[0].entries, [{
    directory: `${backupApplicationLocalExecutorInternals.staticReleaseRoot}/${applicationId}/releases`,
    name: releaseId,
  }]);
  const control = JSON.parse(calls.archive[0].inlineFiles[0].content);
  assert.equal(control.appliedRevision, 0);
  assert.equal(control.runtime, null);
  assert.deepEqual(control.build, staticApplication.build);
});

test('draft Application produces a metadata-only artifact with no release path', async () => {
  const draftApplication = application({
    type: 'static',
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
    runtime: null,
    activeRuntime: null,
    desiredRevision: 1,
    appliedRevision: 0,
    currentReleaseId: null,
    previousReleaseId: null,
    currentCommitSha: null,
    currentGitTarget: null,
  });
  const draftEnvironment = environment({ savedRevision: 0, appliedRevision: null, appliedReleaseId: null });
  const draftStep = step({
    input: {
      applicationId,
      applicationType: 'static',
      desiredRevision: 1,
      appliedRevision: 0,
      currentReleaseId: null,
      currentCommitSha: null,
      environment: { savedRevision: 0, appliedRevision: null, appliedReleaseId: null },
    },
  });
  const { executor, calls } = fixture({ applicationValue: draftApplication, environmentValue: draftEnvironment, values: {} });
  const prepared = await executor.prepare(serverId, draftStep);
  await executor.executePrepared(serverId, draftStep, prepared.workRef);
  assert.deepEqual(calls.archive[0].entries, []);
  assert.equal(calls.archive[0].inlineFiles.length, 2);
});

test('Application local executor fails before archive when live state changes after preview', async () => {
  const { executor, calls } = fixture({ applicationValue: application({ desiredRevision: 5 }) });
  const currentStep = step();
  const prepared = await executor.prepare(serverId, currentStep);
  await assert.rejects(
    () => executor.executePrepared(serverId, currentStep, prepared.workRef),
    (error) => error instanceof BackupApplicationLocalExecutorError
      && error.code === 'backup_application_preview_stale'
      && error.status === 409,
  );
  assert.equal(calls.archive.length, 0);
});

test('Application local executor rejects active deployment and stale environment state', async () => {
  const active = fixture({ applicationValue: application({ activeDeploymentId: previousReleaseId }) });
  const currentStep = step();
  const activePrepared = await active.executor.prepare(serverId, currentStep);
  await assert.rejects(
    () => active.executor.executePrepared(serverId, currentStep, activePrepared.workRef),
    (error) => error instanceof BackupApplicationLocalExecutorError
      && error.code === 'backup_application_preview_stale',
  );

  const staleEnvironment = fixture({ environmentValue: environment({ savedRevision: 10 }) });
  const stalePrepared = await staleEnvironment.executor.prepare(serverId, currentStep);
  await assert.rejects(
    () => staleEnvironment.executor.executePrepared(serverId, currentStep, stalePrepared.workRef),
    (error) => error instanceof BackupApplicationLocalExecutorError
      && error.code === 'backup_application_preview_stale',
  );
});

test('Application local executor requires the exact persisted local dispatch intent', async () => {
  const { executor, calls } = fixture();
  await assert.rejects(
    () => executor.executePrepared(serverId, step(), { kind: 'local', id: 'application-backup:wrong' }),
    (error) => error instanceof BackupApplicationLocalExecutorError
      && error.code === 'backup_application_dispatch_intent_invalid',
  );
  assert.equal(calls.materialize.length, 0);
  assert.equal(calls.archive.length, 0);
  assert.equal(calls.status.length, 0);
});
