import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createDockerComposeOperationsService,
  DockerComposeOperationsError,
} from '../src/docker-compose-operations.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const composeSha256 = 'a'.repeat(64);

function fixture({ jobs = [] } = {}) {
  const enqueued = [];
  const service = createDockerComposeOperationsService({
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
