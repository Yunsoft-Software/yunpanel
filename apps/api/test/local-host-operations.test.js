import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations, LOCAL_HOST_OPERATIONS } from '../src/local-host-operations.js';

test('local host operation map exposes only migrated package operations', () => {
  const operations = createLocalHostOperations({ packageManager: { inspect: async () => ({}), upgrade: async () => ({}) } });
  assert.deepEqual(operations.operations, [OPERATIONS.SYSTEM_PACKAGES_INSPECT, OPERATIONS.SYSTEM_UPGRADE]);
  assert.deepEqual(LOCAL_HOST_OPERATIONS, operations.operations);
  assert.equal(operations.supports(OPERATIONS.SYSTEM_PACKAGES_INSPECT), true);
  assert.equal(operations.supports(OPERATIONS.SYSTEM_UPGRADE), true);
  assert.equal(operations.supports(OPERATIONS.DOMAIN_STAGE), false);
  assert.equal(operations.supports(OPERATIONS.APP_NODE_DEPLOY), false);
});

test('package operations execute through the in-process host manager', async () => {
  const calls = [];
  const operations = createLocalHostOperations({
    packageManager: {
      inspect: async () => { calls.push('inspect'); return { packageName: 'yunpanel' }; },
      upgrade: async () => { calls.push('upgrade'); return { upgraded: true }; },
    },
  });
  assert.deepEqual(await operations.executeOperation(OPERATIONS.SYSTEM_PACKAGES_INSPECT, {}), { packageName: 'yunpanel' });
  assert.deepEqual(await operations.executeOperation(OPERATIONS.SYSTEM_UPGRADE, {}), { upgraded: true });
  assert.deepEqual(calls, ['inspect', 'upgrade']);
});

test('unmigrated or malformed local operations fail closed', async () => {
  const operations = createLocalHostOperations({ packageManager: { inspect: async () => ({}), upgrade: async () => ({}) } });
  await assert.rejects(() => operations.executeOperation(OPERATIONS.DOMAIN_STAGE, {}), { code: 'local_operation_not_migrated' });
  await assert.rejects(() => operations.executeOperation(OPERATIONS.SYSTEM_PACKAGES_INSPECT, null), { code: 'invalid_local_operation_payload' });
});
