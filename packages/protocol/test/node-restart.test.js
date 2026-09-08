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
    startMode: 'node',
    entryFile: 'dist/server.js',
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 10,
    restartPolicy: 'on-failure',
  };
}

test('Node restart is allowlisted as a control-plane mutation bound to the active release', () => {
  assert.equal(isKnownOperation(OPERATIONS.APP_NODE_RESTART), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.APP_NODE_RESTART), false);

  const result = validateOperationEnvelope({
    id: 'node-restart-request-0001',
    operation: OPERATIONS.APP_NODE_RESTART,
    payload: { applicationId: APPLICATION_ID, releaseId: RELEASE_ID, runtime: runtime() },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(result.ok, true);
});

test('Node restart rejects invalid desired runtime or release state', () => {
  const invalidRuntime = validateOperationEnvelope({
    id: 'node-restart-request-0002',
    operation: OPERATIONS.APP_NODE_RESTART,
    payload: { applicationId: APPLICATION_ID, releaseId: RELEASE_ID, runtime: { ...runtime(), port: 80 } },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidRuntime.ok, false);
  assert.match(invalidRuntime.errors.join(' '), /port/);

  const invalidRelease = validateOperationEnvelope({
    id: 'node-restart-request-0003',
    operation: OPERATIONS.APP_NODE_RESTART,
    payload: { applicationId: APPLICATION_ID, releaseId: '../bad', runtime: runtime() },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidRelease.ok, false);
  assert.match(invalidRelease.errors.join(' '), /releaseId/);
});
