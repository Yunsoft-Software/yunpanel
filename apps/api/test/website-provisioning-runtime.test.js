import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';

function plan() {
  return {
    operationId,
    websiteId,
    steps: [{
      id: 'unix_identity',
      kind: 'unix_identity',
      state: 'pending',
      intent: {
        unixUser: 'yunapp-0123456789ab',
        homeDirectory: '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76',
      },
      compensation: { state: 'pending' },
    }],
  };
}

test('runtime composes registry, identity handler and orchestrator', async () => {
  const calls = [];
  const runtime = createWebsiteProvisioningRuntime({
    identityManager: {
      inspect: async (intent) => ({ satisfied: true, ...intent, uid: 1201, gid: 1201 }),
      apply: async (intent) => {
        calls.push(intent);
        return { satisfied: true, ...intent, uid: 1201, gid: 1201 };
      },
    },
  });

  await runtime.init();
  await runtime.create(plan());
  const result = await runtime.runNext(operationId);

  assert.equal(result.outcome, 'ready');
  assert.equal(result.operation.ready, true);
  assert.deepEqual(calls, [{
    user: 'yunapp-0123456789ab',
    homeDirectory: '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76',
  }]);
  assert.deepEqual(await runtime.get(operationId), result.operation);
  assert.deepEqual(await runtime.listInterrupted(), []);
});
