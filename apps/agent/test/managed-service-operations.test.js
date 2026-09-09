import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { operationHandlers } from '../src/operations.js';

test('legacy agent exposes managed service handlers during local-runtime migration', () => {
  for (const operation of [
    OPERATIONS.SYSTEM_SERVICES_INSPECT,
    OPERATIONS.SYSTEM_SERVICE_INSTALL,
    OPERATIONS.SYSTEM_SERVICE_CONTROL,
  ]) {
    assert.equal(typeof operationHandlers[operation], 'function');
  }
});
