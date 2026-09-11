import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { operationHandlers } from '../src/operations.js';

test('legacy agent transport exposes the bounded Node process operation during migration', () => {
  assert.equal(typeof operationHandlers[OPERATIONS.APP_NODE_PROCESS], 'function');
});
