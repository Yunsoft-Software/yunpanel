import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCKER_COMPOSE_OPERATIONS,
  DOCKER_VOLUME_OPERATIONS,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  validateOperationEnvelope,
} from '../src/index-node-passenger.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);
const FP = 'b'.repeat(64);
const DIGEST = 'c'.repeat(64);

function validPayload(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    projectName: 'shop_stack',
    expectedProjectRevision: 2,
    expectedComposeSha256: SHA,
    volumeKey: 'db_data',
    volumeName: 'shop_stack_db_data',
    volumeFingerprint: FP,
    previewDigest: DIGEST,
    ...overrides,
  };
}

test('DOCKER_VOLUME_DELETE is registered separately without altering the 6 Compose lifecycle operations', () => {
  assert.equal(DOCKER_COMPOSE_OPERATIONS.length, 6);
  assert.deepEqual(DOCKER_VOLUME_OPERATIONS, [OPERATIONS.DOCKER_VOLUME_DELETE]);
  assert.equal(isKnownOperation(OPERATIONS.DOCKER_VOLUME_DELETE), true);

  const envelope = createOperationEnvelope({
    id: 'job-volume-delete-1',
    operation: OPERATIONS.DOCKER_VOLUME_DELETE,
    payload: validPayload(),
  });
  assert.equal(envelope.operation, 'docker.volume.delete');
  assert.equal(validateOperationEnvelope(envelope).ok, true);
});

test('DOCKER_VOLUME_DELETE rejects mismatched volumeName, unsafe keys, and forbidden prune/force/all flags', () => {
  const invalidPayloads = [
    validPayload({ volumeName: 'other_project_db_data' }),
    validPayload({ volumeKey: '../escape', volumeName: 'shop_stack_../escape' }),
    validPayload({ volumeKey: '/srv/bind', volumeName: 'shop_stack_/srv/bind' }),
    validPayload({ volumeFingerprint: 'not-a-sha' }),
    validPayload({ previewDigest: 'short' }),
    validPayload({ expectedProjectRevision: 0 }),
    validPayload({ force: true }),
    validPayload({ prune: true }),
    validPayload({ all: true }),
    validPayload({ volumes: ['shop_stack_db_data'] }),
  ];

  for (const payload of invalidPayloads) {
    assert.throws(() => createOperationEnvelope({
      id: 'job-volume-delete-bad',
      operation: OPERATIONS.DOCKER_VOLUME_DELETE,
      payload,
    }));
  }
});
