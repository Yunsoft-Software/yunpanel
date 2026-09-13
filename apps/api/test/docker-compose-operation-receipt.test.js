import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createDockerComposeOperationReceiptStore,
  DockerComposeOperationReceiptError,
} from '../src/docker-compose-operation-receipt.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const jobId = '12345678-1234-4234-8234-123456789012';

function result(overrides = {}) {
  return {
    version: 1,
    projectId,
    projectRevision: 3,
    environmentRevision: 2,
    composeSha256: 'a'.repeat(64),
    action: 'start',
    runtimeState: 'running',
    executed: true,
    sideEffects: true,
    ...overrides,
  };
}

test('compose receipt is private, idempotent and bound to operation action', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createDockerComposeOperationReceiptStore({ root });
  const first = await store.write({ serverId, jobId, operation: OPERATIONS.DOCKER_COMPOSE_START, result: result() });
  const second = await store.write({ serverId, jobId, operation: OPERATIONS.DOCKER_COMPOSE_START, result: result() });
  assert.deepEqual(second, first);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, `${jobId}.json`))).mode & 0o777, 0o600);
  await assert.rejects(
    store.write({ serverId, jobId: '22345678-1234-4234-8234-123456789012', operation: OPERATIONS.DOCKER_COMPOSE_STOP, result: result() }),
    (error) => error instanceof DockerComposeOperationReceiptError && error.code === 'docker_compose_receipt_invalid',
  );
});
