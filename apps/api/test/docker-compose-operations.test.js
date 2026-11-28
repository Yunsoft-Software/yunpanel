import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS, createOperationEnvelope } from '@yunpanel/protocol';
import {
  createDockerComposeOperationsService,
  DockerComposeOperationsError,
} from '../src/docker/docker-compose-operations.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const composeSha256 = 'a'.repeat(64);

function fixture({ jobs = [], backupLocked = false, backupLockError = null, removalVolumes = [] } = {}) {
  const enqueued = [];
  const service = createDockerComposeOperationsService({
    async inspectRemoval(input) {
      assert.deepEqual(input, { projectId, projectName: 'shop_app', serverId });
      return { ready: true, volumes: structuredClone(removalVolumes) };
    },
    projectRegistry: {
      async getProject(id) {
        return id === projectId ? {
          id, serverId, projectName: 'shop_app', revision: 3, composeSha256,
        } : null;
      },
    },
    environmentRegistry: {
      async getEnvironment(id) { return { projectId: id, revision: 2 }; },
    },
    credentialRegistry: {
      async listCredentials() {
        return [
          { registryHost: 'ghcr.io', revision: 4, configured: true },
          { registryHost: 'docker.io', revision: 1, configured: true },
        ];
      },
    },
    jobRegistry: {
      async listJobs() { return jobs; },
      async enqueue(input) {
        enqueued.push(structuredClone(input));
        return { id: '32345678-1234-4234-8234-123456789012', status: 'queued', ...input };
      },
    },
    async projectBackupLocked(id) {
      assert.equal(id, projectId);
      if (backupLockError) throw backupLockError;
      return backupLocked;
    },
  });
  return { service, enqueued };
}

test('compose lifecycle preview pins server project environment digest and sorted credential revisions', async () => {
  const { service } = fixture();
  const preview = await service.preview({ projectId, action: 'start' });
  assert.equal(preview.serverId, serverId);
  assert.equal(preview.operation, OPERATIONS.DOCKER_COMPOSE_START);
  assert.equal(preview.projectRevision, 3);
  assert.equal(preview.environmentRevision, 2);
  assert.equal(preview.composeSha256, composeSha256);
  assert.deepEqual(preview.credentialRevisions, [
    { registryHost: 'docker.io', revision: 1 },
    { registryHost: 'ghcr.io', revision: 4 },
  ]);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.sideEffects, false);
});

test('start stop start with unchanged configuration creates a new intent after completed work', async () => {
  const jobs = [];
  const { service, enqueued } = fixture({ jobs });
  const first = await service.preview({ projectId, action: 'start' });
  assert.equal((await service.preview({ projectId, action: 'start' })).previewDigest, first.previewDigest);
  await service.queue({ projectId, action: 'start', expectedPreviewDigest: first.previewDigest, confirmation: first.confirmation });
  jobs.push({ id: 'first-start', operation: OPERATIONS.DOCKER_COMPOSE_START, status: 'succeeded' });
  const stopped = await service.preview({ projectId, action: 'stop' });
  await service.queue({ projectId, action: 'stop', expectedPreviewDigest: stopped.previewDigest, confirmation: stopped.confirmation });
  jobs.push({ id: 'first-stop', operation: OPERATIONS.DOCKER_COMPOSE_STOP, status: 'succeeded' });
  const second = await service.preview({ projectId, action: 'start' });
  assert.notEqual(second.previewDigest, first.previewDigest);
  await service.queue({ projectId, action: 'start', expectedPreviewDigest: second.previewDigest, confirmation: second.confirmation });
  assert.notEqual(enqueued[0].idempotencyKey, enqueued[2].idempotencyKey);
  await assert.rejects(service.queue({ projectId, action: 'start', expectedPreviewDigest: first.previewDigest, confirmation: first.confirmation }), { code: 'docker_compose_preview_stale' });
});

test('compose lifecycle queue uses pinned secret-free payload and correct server resource lock', async () => {
  const { service, enqueued } = fixture();
  const preview = await service.preview({ projectId, action: 'restart' });
  const queued = await service.queue({
    projectId,
    action: 'restart',
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    serverId,
    type: OPERATIONS.DOCKER_COMPOSE_RESTART,
    operation: OPERATIONS.DOCKER_COMPOSE_RESTART,
    payload: {
      projectId,
      expectedProjectRevision: 3,
      expectedEnvironmentRevision: 2,
      expectedComposeSha256: composeSha256,
      credentialRevisions: [
        { registryHost: 'docker.io', revision: 1 },
        { registryHost: 'ghcr.io', revision: 4 },
      ],
    },
    resourceType: 'docker_project',
    resourceId: projectId,
    idempotencyKey: `docker-compose:restart:${projectId}:${preview.previewDigest}`,
  });
  assert.equal(JSON.stringify(queued).includes('secret'), false);
  assert.equal(JSON.stringify(queued).includes('username'), false);
});

test('compose lifecycle queue rejects active project job and stale confirmation without enqueueing', async () => {
  const conflict = fixture({ jobs: [{ operation: OPERATIONS.DOCKER_COMPOSE_BUILD, status: 'running' }] });
  await assert.rejects(
    conflict.service.preview({ projectId, action: 'pull' }),
    (error) => error instanceof DockerComposeOperationsError && error.code === 'docker_compose_job_conflict',
  );
  assert.equal(conflict.enqueued.length, 0);

  const fx = fixture();
  const preview = await fx.service.preview({ projectId, action: 'pull' });
  await assert.rejects(
    fx.service.queue({ projectId, action: 'pull', expectedPreviewDigest: preview.previewDigest, confirmation: 'wrong' }),
    (error) => error instanceof DockerComposeOperationsError && error.code === 'docker_compose_confirmation_invalid',
  );
  assert.equal(fx.enqueued.length, 0);
});

test('compose lifecycle preview is blocked while a durable general backup owns the project', async () => {
  const locked = fixture({ backupLocked: true });
  await assert.rejects(
    () => locked.service.preview({ projectId, action: 'start' }),
    (error) => error instanceof DockerComposeOperationsError
      && error.code === 'docker_compose_backup_conflict'
      && error.status === 409,
  );
  assert.equal(locked.enqueued.length, 0);
});

test('compose lifecycle fails closed when backup lock state is unavailable', async () => {
  const unavailable = fixture({ backupLockError: new Error('private backup state') });
  await assert.rejects(
    () => unavailable.service.preview({ projectId, action: 'restart' }),
    (error) => error instanceof DockerComposeOperationsError
      && error.code === 'docker_compose_backup_state_unavailable'
      && error.status === 503
      && !error.message.includes('private backup state'),
  );
  assert.equal(unavailable.enqueued.length, 0);
});

test('compose history is sourced from durable jobs and excludes unrelated operations', async () => {
  const newer = {
    id: '52345678-1234-4234-8234-123456789012',
    serverId,
    operation: OPERATIONS.DOCKER_COMPOSE_RESTART,
    resourceType: 'docker_project',
    resourceId: projectId,
    status: 'succeeded',
    createdAt: '2026-09-13T10:05:00.000Z',
    result: { action: 'restart', runtimeState: 'running' },
  };
  const older = {
    id: '42345678-1234-4234-8234-123456789012',
    serverId,
    operation: OPERATIONS.DOCKER_COMPOSE_START,
    resourceType: 'docker_project',
    resourceId: projectId,
    status: 'failed',
    createdAt: '2026-09-13T10:00:00.000Z',
    error: { code: 'docker_failed' },
  };
  const { service } = fixture({
    jobs: [older, { ...older, operation: OPERATIONS.APP_NODE_RESTART }, newer],
  });
  const history = await service.history({ projectId });
  assert.deepEqual(history, [newer, older]);
  assert.equal(JSON.stringify(history).includes('payload'), false);
});

// T969: the removal preview lists named volumes and the delete choice is part of
// the digest and confirmation. Default removal keeps volumes.
const removalVolumes = [
  { volumeKey: 'data', volumeName: 'shop_app_data', present: true, deletable: true, fingerprint: 'c'.repeat(64), blockCode: null, blockReason: null },
  { volumeKey: 'shared', volumeName: 'shared_uploads', present: null, deletable: false, fingerprint: null, blockCode: 'docker_volume_external_forbidden', blockReason: 'Harici veya özel adlı volume silinemez.' },
];

test('compose removal preview lists named volumes and binds the delete choice into the digest', async () => {
  const { service } = fixture({ removalVolumes });
  const keep = await service.preview({ projectId, action: 'remove' });
  const remove = await service.preview({ projectId, action: 'remove', deleteVolumes: true });
  assert.equal(keep.deleteVolumes, false);
  assert.equal(remove.deleteVolumes, true);
  assert.deepEqual(keep.volumes.map((volume) => [volume.volumeName, volume.deletable]), [['shop_app_data', true], ['shared_uploads', false]]);
  assert.deepEqual(remove.volumes, keep.volumes);
  assert.notEqual(keep.previewDigest, remove.previewDigest);
  assert.notEqual(keep.confirmation, remove.confirmation);
  assert.equal((await service.preview({ projectId, action: 'remove', deleteVolumes: false })).previewDigest, keep.previewDigest);
});

test('compose removal queue pins deletable volumes only after explicit opt-in', async () => {
  const kept = fixture({ removalVolumes });
  const keep = await kept.service.preview({ projectId, action: 'remove' });
  await kept.service.queue({ projectId, action: 'remove', expectedPreviewDigest: keep.previewDigest, confirmation: keep.confirmation });
  assert.equal(Object.hasOwn(kept.enqueued[0].payload, 'deleteVolumes'), false);
  assert.equal(Object.hasOwn(kept.enqueued[0].payload, 'volumes'), false);

  const opted = fixture({ removalVolumes });
  const remove = await opted.service.preview({ projectId, action: 'remove', deleteVolumes: true });
  await assert.rejects(
    opted.service.queue({ projectId, action: 'remove', expectedPreviewDigest: remove.previewDigest, confirmation: remove.confirmation }),
    { code: 'docker_compose_preview_stale' },
  );
  await opted.service.queue({ projectId, action: 'remove', deleteVolumes: true, expectedPreviewDigest: remove.previewDigest, confirmation: remove.confirmation });
  assert.equal(opted.enqueued.length, 1);
  assert.equal(opted.enqueued[0].payload.deleteVolumes, true);
  assert.deepEqual(opted.enqueued[0].payload.volumes, [{ volumeKey: 'data', volumeName: 'shop_app_data', volumeFingerprint: 'c'.repeat(64) }]);
  assert.notEqual(opted.enqueued[0].idempotencyKey, kept.enqueued[0].idempotencyKey);
});

test('compose removal job payloads pass the real protocol envelope used by the job registry (T969)', async () => {
  // The job registry validates every payload with createOperationEnvelope; a fake registry alone hid a mismatch.
  for (const deleteVolumes of [false, true]) {
    const { service, enqueued } = fixture({ removalVolumes });
    const preview = await service.preview({ projectId, action: 'remove', deleteVolumes });
    await service.queue({ projectId, action: 'remove', deleteVolumes, expectedPreviewDigest: preview.previewDigest, confirmation: preview.confirmation });
    const envelope = createOperationEnvelope({ id: 'docker-remove-envelope', operation: enqueued[0].operation, payload: enqueued[0].payload });
    assert.deepEqual(envelope.payload, enqueued[0].payload);
  }
});

test('compose volume deletion choice is rejected outside removal or without deletable volumes', async () => {
  const { service } = fixture({ removalVolumes: [removalVolumes[1]] });
  await assert.rejects(service.preview({ projectId, action: 'stop', deleteVolumes: true }), { code: 'docker_compose_input_invalid' });
  await assert.rejects(service.preview({ projectId, action: 'remove', deleteVolumes: 'yes' }), { code: 'docker_compose_input_invalid' });
  await assert.rejects(service.preview({ projectId, action: 'remove', deleteVolumes: true }), { code: 'docker_compose_removal_volumes_none' });
});
