import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  BackupDockerLocalExecutorError,
  createBackupDockerLocalExecutor,
} from '../src/backup-docker-local-executor.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';

function storage(kind = 'bind') {
  return kind === 'bind'
    ? { kind: 'bind', source: './uploads', sourceScope: 'project', target: '/app/uploads', readOnly: false }
    : { kind: 'named_volume', source: 'data', sourceScope: 'project', target: '/data', readOnly: false };
}

function step(kind = 'bind') {
  const digest = kind === 'bind' ? 'a'.repeat(64) : 'b'.repeat(64);
  return {
    stepId: `backup-step:${digest}`,
    stepDigest: digest,
    resourceIdentity: `docker-storage:${digest}`,
    resourceType: 'docker_storage',
    executorKind: 'docker_storage_backup',
    input: {
      projectId,
      projectRevision: 3,
      serviceName: 'web',
      storage: storage(kind),
    },
  };
}

function project(mount = storage('bind'), overrides = {}) {
  return {
    id: projectId,
    serverId,
    projectName: 'shop_app',
    revision: 3,
    services: [{ name: 'web', storageMounts: [mount] }],
    ...overrides,
  };
}

function fixture({
  projectValue = project(),
  locked = true,
  jobs = [],
  runtimeStatus = 'stopped',
  volume = null,
} = {}) {
  const calls = { observer: [], inspectVolume: [], archive: [] };
  const executor = createBackupDockerLocalExecutor({
    dockerComposeProjectRegistry: {
      async getProject(id) {
        assert.equal(id, projectId);
        return projectValue;
      },
    },
    dockerComposeObserver: {
      async inspect(input) {
        calls.observer.push(input);
        return { version: 1, projectName: 'shop_app', service: null, status: runtimeStatus, containerCount: 0, containers: [] };
      },
    },
    jobRegistry: {
      async listJobs(input) {
        assert.deepEqual(input, { resourceType: 'docker_project', resourceId: projectId });
        return jobs;
      },
    },
    async projectBackupLocked(id) {
      assert.equal(id, projectId);
      return locked;
    },
    async inspectDockerVolume(name) {
      calls.inspectVolume.push(name);
      return volume ?? { name, driver: 'local', mountpoint: `/var/lib/docker/volumes/${name}/_data` };
    },
    localBackupArtifactManager: {
      async archive(request) {
        calls.archive.push(request);
        return {
          artifactId: request.artifactId,
          contentSha256: 'c'.repeat(64),
          bytes: 9000,
          createdAt: '2026-09-13T20:10:00.000Z',
        };
      },
    },
    composeRuntimeRoot: '/var/lib/yunpanel/docker/compose-runtime',
    projectWorkspacePath: (root, id) => `${root}/projects/workspace-${id}`,
  });
  return { executor, calls };
}

test('project-bind backup uses only the persistent managed Compose workspace', async () => {
  const currentStep = step('bind');
  const { executor, calls } = fixture();
  const prepared = await executor.prepare(serverId, currentStep);
  assert.deepEqual(prepared.workRef, { kind: 'local', id: `docker-storage-backup:${currentStep.stepDigest}` });

  const result = await executor.executePrepared(serverId, currentStep, prepared.workRef);
  assert.equal(result.evidence.artifactId, currentStep.stepDigest);
  assert.deepEqual(calls.inspectVolume, []);
  assert.deepEqual(calls.archive[0].entries, [{
    directory: `/var/lib/yunpanel/docker/compose-runtime/projects/workspace-${projectId}`,
    name: 'uploads',
  }]);
  const control = JSON.parse(calls.archive[0].inlineFiles[0].content);
  assert.equal(control.projectName, 'shop_app');
  assert.deepEqual(control.runtimeSource, { kind: 'project_bind', source: './uploads' });
});

test('named-volume backup resolves only the exact Compose-managed volume name', async () => {
  const currentStep = step('named_volume');
  const { executor, calls } = fixture({ projectValue: project(storage('named_volume')) });
  const prepared = await executor.prepare(serverId, currentStep);
  await executor.executePrepared(serverId, currentStep, prepared.workRef);

  assert.deepEqual(calls.inspectVolume, ['shop_app_data']);
  assert.deepEqual(calls.archive[0].entries, [{
    directory: '/var/lib/docker/volumes/shop_app_data',
    name: '_data',
  }]);
  const control = JSON.parse(calls.archive[0].inlineFiles[0].content);
  assert.deepEqual(control.runtimeSource, { kind: 'named_volume', name: 'shop_app_data' });
});

test('Docker storage backup is blocked without durable lock or while Compose is active', async () => {
  const unlocked = fixture({ locked: false });
  await assert.rejects(
    () => unlocked.executor.prepare(serverId, step()),
    (error) => error instanceof BackupDockerLocalExecutorError
      && error.code === 'backup_docker_lock_required'
      && error.status === 409,
  );
  assert.equal(unlocked.calls.archive.length, 0);

  const running = fixture({ runtimeStatus: 'running' });
  await assert.rejects(
    () => running.executor.prepare(serverId, step()),
    (error) => error instanceof BackupDockerLocalExecutorError
      && error.code === 'backup_docker_consistency_blocked'
      && error.status === 409,
  );
  assert.equal(running.calls.archive.length, 0);
});

test('Docker storage backup rejects pre-existing active lifecycle jobs', async () => {
  const busy = fixture({
    jobs: [{ operation: OPERATIONS.DOCKER_COMPOSE_RESTART, status: 'queued' }],
  });
  await assert.rejects(
    () => busy.executor.prepare(serverId, step()),
    (error) => error instanceof BackupDockerLocalExecutorError
      && error.code === 'backup_docker_job_conflict'
      && error.status === 409,
  );
  assert.equal(busy.calls.observer.length, 0);
  assert.equal(busy.calls.archive.length, 0);
});

test('Docker storage backup fails closed when project revision or mount identity changes', async () => {
  for (const projectValue of [
    project(storage('bind'), { revision: 4 }),
    project({ ...storage('bind'), source: './other' }),
  ]) {
    const fx = fixture({ projectValue });
    await assert.rejects(
      () => fx.executor.prepare(serverId, step()),
      (error) => error instanceof BackupDockerLocalExecutorError
        && error.code === 'backup_docker_preview_stale'
        && error.status === 409,
    );
    assert.equal(fx.calls.archive.length, 0);
  }
});

test('Docker storage backup rechecks consistency before archive and requires exact dispatch intent', async () => {
  const currentStep = step('bind');
  let inspections = 0;
  const fx = fixture();
  fx.executor;
  const prepared = await fx.executor.prepare(serverId, currentStep);
  await assert.rejects(
    () => fx.executor.executePrepared(serverId, currentStep, { kind: 'local', id: 'docker-storage-backup:wrong' }),
    (error) => error instanceof BackupDockerLocalExecutorError
      && error.code === 'backup_docker_dispatch_intent_invalid',
  );
  assert.equal(fx.calls.archive.length, 0);
  assert.deepEqual(prepared.workRef, { kind: 'local', id: `docker-storage-backup:${currentStep.stepDigest}` });
  inspections += fx.calls.observer.length;
  assert.equal(inspections >= 2, true);
});
