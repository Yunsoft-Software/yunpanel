import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { operationHandlers } from '../src/operations.js';

test('legacy migration transport exposes bounded Node runtime inventory and install handlers', () => {
  assert.equal(typeof operationHandlers[OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT], 'function');
  assert.equal(typeof operationHandlers[OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL], 'function');
});
