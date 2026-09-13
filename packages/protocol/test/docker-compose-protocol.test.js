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
  ]);
  for (const operation of DOCKER_COMPOSE_OPERATIONS) {
    assert.equal(isKnownOperation(operation), true);
    const envelope = createOperationEnvelope({ id: 'docker-job-0001', operation, payload });
    assert.equal(validateOperationEnvelope(envelope).ok, true);
    assert.deepEqual(envelope.payload, payload);
    assert.equal(JSON.stringify(envelope).includes('password'), false);
    assert.equal(JSON.stringify(envelope).includes('token'), false);
  }
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
