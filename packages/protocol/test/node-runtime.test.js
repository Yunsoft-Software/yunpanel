import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationEnvelope,
  isReadOnlyOperation,
  MANAGED_NODE_RUNTIME_MAJORS,
  OPERATIONS,
} from '../src/index.js';

test('managed Node runtime inventory and install have bounded protocol contracts', () => {
  assert.deepEqual(MANAGED_NODE_RUNTIME_MAJORS, [22, 24]);
  assert.equal(isReadOnlyOperation(OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL), false);
  assert.doesNotThrow(() => createOperationEnvelope({
    id: 'runtime-inspect-job', operation: OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, payload: {},
  }));
  assert.doesNotThrow(() => createOperationEnvelope({
    id: 'runtime-install-job', operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, payload: { major: 24 },
  }));
  for (const payload of [{ major: 20 }, { major: 24, command: 'curl evil' }, {}, { major: '24' }]) {
    assert.throws(() => createOperationEnvelope({
      id: 'runtime-install-job', operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, payload,
    }));
  }
});
