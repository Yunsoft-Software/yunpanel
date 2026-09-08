import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  isKnownOperation,
  isReadOnlyOperation,
  validateOperationEnvelope,
} from '../src/index.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const RELEASE_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

function runtime() {
  return {
    nodeMajor: 24,
    installMode: 'ci',
    buildScript: 'build',
    start: { mode: 'node', entryFile: 'dist/server.js', script: null },
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 10,
    restartPolicy: 'on-failure',
  };
}

test('Node status is allowlisted as a read-only managed operation', () => {
  assert.equal(isKnownOperation(OPERATIONS.APP_NODE_STATUS), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.APP_NODE_STATUS), true);

  const result = validateOperationEnvelope({
    id: 'node-status-request-0001',
    operation: OPERATIONS.APP_NODE_STATUS,
    payload: { applicationId: APPLICATION_ID, releaseId: RELEASE_ID, runtime: runtime() },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(result.ok, true);
});

test('Node status rejects invalid application release state', () => {
  const result = validateOperationEnvelope({
    id: 'node-status-request-0002',
    operation: OPERATIONS.APP_NODE_STATUS,
    payload: { applicationId: APPLICATION_ID, releaseId: '../bad', runtime: runtime() },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /releaseId/);
});
