import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationEnvelope,
  DOCKER_COMPOSE_OPERATIONS,
  isKnownOperation,
  OPERATIONS,
  validateOperationEnvelope,
} from '../src/index-docker.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const payload = Object.freeze({
  projectId,
  expectedProjectRevision: 3,
  expectedEnvironmentRevision: 2,
  expectedComposeSha256: 'a'.repeat(64),
  credentialRevisions: [
    { registryHost: 'docker.io', revision: 1 },
    { registryHost: 'ghcr.io', revision: 4 },
  ],
});

test('compose lifecycle operations are known and accept only secret-free pinned desired-state metadata', () => {
  assert.deepEqual(DOCKER_COMPOSE_OPERATIONS, [
    OPERATIONS.DOCKER_COMPOSE_BUILD,
    OPERATIONS.DOCKER_COMPOSE_PULL,
    OPERATIONS.DOCKER_COMPOSE_START,
    OPERATIONS.DOCKER_COMPOSE_STOP,
    OPERATIONS.DOCKER_COMPOSE_RESTART,
    OPERATIONS.DOCKER_COMPOSE_REMOVE,
  ]);
  for (const operation of DOCKER_COMPOSE_OPERATIONS) {
    assert.equal(isKnownOperation(operation), true);
    const desired = operation === OPERATIONS.DOCKER_COMPOSE_REMOVE ? { ...payload, projectName: 'owned-project' } : payload;
    const envelope = createOperationEnvelope({ id: 'docker-job-0001', operation, payload: desired });
    assert.equal(validateOperationEnvelope(envelope).ok, true);
    assert.deepEqual(envelope.payload, desired);
    assert.equal(JSON.stringify(envelope).includes('password'), false);
    assert.equal(JSON.stringify(envelope).includes('token'), false);
  }
});

test('compose removal requires a pinned project name and rejects shell or unrelated target arguments', () => {
  for (const candidate of [payload, { ...payload, projectName: '../foreign' },
    { ...payload, projectName: 'owned; down' }, { ...payload, projectName: 'owned', volumes: true }]) {
    assert.throws(() => createOperationEnvelope({ id: 'docker-remove-0001', operation: OPERATIONS.DOCKER_COMPOSE_REMOVE, payload: candidate }));
  }
});

test('compose removal accepts an explicit pinned named-volume deletion and rejects loose shapes (T969)', () => {
  const base = { ...payload, projectName: 'owned-project' };
  const volume = { volumeKey: 'data', volumeName: 'owned-project_data', volumeFingerprint: 'b'.repeat(64) };
  const desired = { ...base, deleteVolumes: true, volumes: [volume] };
  const envelope = createOperationEnvelope({ id: 'docker-remove-0002', operation: OPERATIONS.DOCKER_COMPOSE_REMOVE, payload: desired });
  assert.equal(validateOperationEnvelope(envelope).ok, true);
  assert.deepEqual(envelope.payload, desired);
  for (const candidate of [
    { ...base, deleteVolumes: true },
    { ...base, volumes: [volume] },
    { ...base, deleteVolumes: false, volumes: [volume] },
    { ...base, deleteVolumes: true, volumes: [] },
    { ...base, deleteVolumes: true, volumes: [{ ...volume, volumeName: 'foreign_data' }] },
    { ...base, deleteVolumes: true, volumes: [{ ...volume, volumeFingerprint: 'bad' }] },
    { ...base, deleteVolumes: true, volumes: [{ ...volume, extra: 1 }] },
    { ...base, deleteVolumes: true, volumes: [volume, volume] },
  ]) {
    assert.throws(() => createOperationEnvelope({ id: 'docker-remove-0003', operation: OPERATIONS.DOCKER_COMPOSE_REMOVE, payload: candidate }));
  }
  assert.throws(() => createOperationEnvelope({ id: 'docker-stop-0001', operation: OPERATIONS.DOCKER_COMPOSE_STOP, payload: { ...payload, deleteVolumes: true, volumes: [volume] } }));
});

test('compose lifecycle payload rejects stale-shaped credentials and unsupported fields', () => {
  for (const candidate of [
    { ...payload, expectedProjectRevision: 0 },
    { ...payload, expectedEnvironmentRevision: -1 },
    { ...payload, expectedComposeSha256: 'bad' },
    { ...payload, credentialRevisions: [{ registryHost: 'https://ghcr.io', revision: 1 }] },
    { ...payload, credentialRevisions: [{ registryHost: 'ghcr.io', revision: 1 }, { registryHost: 'ghcr.io', revision: 2 }] },
    { ...payload, credentialRevisions: [...payload.credentialRevisions].reverse() },
    { ...payload, secret: 'not-allowed' },
  ]) {
    const result = validateOperationEnvelope({
      id: 'docker-job-0001',
      operation: OPERATIONS.DOCKER_COMPOSE_START,
      payload: candidate,
      protocolVersion: 8,
    });
    assert.equal(result.ok, false);
  }
});
