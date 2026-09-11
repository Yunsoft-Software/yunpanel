import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationEnvelope, isKnownOperation, isReadOnlyOperation, OPERATIONS } from '../src/index.js';

const payload = {
  applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
  releaseId: 'ff830043-9752-4640-83b4-3a1998de78a0',
  runtime: { nodeMajor: 24, port: 3100 },
  action: 'stop',
};

test('Node process actions are explicit mutations bound to one release', () => {
  assert.equal(isKnownOperation(OPERATIONS.APP_NODE_PROCESS), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.APP_NODE_PROCESS), false);
  const envelope = createOperationEnvelope({ id: 'process-job-1', operation: OPERATIONS.APP_NODE_PROCESS, payload });
  assert.deepEqual(envelope.payload, payload);
});

test('Node process rejects arbitrary actions and malformed release state', () => {
  for (const candidate of [
    { ...payload, action: 'restart' },
    { ...payload, action: 'stop;id' },
    { ...payload, releaseId: 'current' },
  ]) {
    assert.throws(() => createOperationEnvelope({ id: 'process-job-1', operation: OPERATIONS.APP_NODE_PROCESS, payload: candidate }));
  }
});
