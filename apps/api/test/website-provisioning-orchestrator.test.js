import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningOrchestrator } from '../src/website-provisioning-orchestrator.js';
import { createWebsiteProvisioningRegistry } from '../src/website-provisioning-registry.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';

function plan() {
  return {
    operationId,
    websiteId,
    steps: [
      {
        id: 'unix_identity',
        kind: 'unix_identity',
        state: 'pending',
        intent: { user: 'yunapp-example' },
        compensation: { state: 'pending' },
      },
      {
        id: 'runtime',
        kind: 'runtime',
        state: 'pending',
        intent: { adapter: 'passenger' },
        compensation: { state: 'pending' },
      },
    ],
  };
}

test('orchestrator persists applying state before invoking a mutating handler', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  let observedState = null;
  let contextOperation = null;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async ({ operation }) => {
          contextOperation = operation;
          observedState = (await registry.get(operationId)).steps[0].state;
          return { uid: 1201, gid: 1201 };
        },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(observedState, 'applying');
  assert.equal(contextOperation.operationId, operationId);
  assert.equal(contextOperation.steps[0].state, 'applying');
  assert.equal(result.outcome, 'progressed');
  assert.equal(result.operation.steps[0].state, 'succeeded');
  assert.equal(result.operation.steps[1].state, 'pending');
});

test('orchestrator never blindly re-applies an interrupted step', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  let applyCalls = 0;
  let inspectCalls = 0;
  let inspectOperation = null;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => { applyCalls += 1; return { uid: 1201 }; },
        inspect: async ({ operation }) => {
          inspectCalls += 1;
          inspectOperation = operation;
          return { satisfied: true, uid: 1201 };
        },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(applyCalls, 0);
  assert.equal(inspectCalls, 1);
  assert.equal(inspectOperation.steps[0].state, 'applying');
  assert.equal(result.outcome, 'reconciled');
  assert.equal(result.operation.steps[0].state, 'succeeded');
});

test('interrupted step without safe inspection stays interrupted for remediation', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  let applyCalls = 0;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => { applyCalls += 1; return { uid: 1201 }; },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(applyCalls, 0);
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.actionRequired, 'inspect_or_remediate');
  assert.equal((await registry.get(operationId)).steps[0].state, 'applying');
});

test('blocked required step never invokes a handler automatically', async () => {
  const registry = createWebsiteProvisioningRegistry();
  const blockedPlan = plan();
  blockedPlan.steps[0].state = 'blocked';
  await registry.create(blockedPlan);
  let applyCalls = 0;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => { applyCalls += 1; return { uid: 1201 }; },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.stepId, 'unix_identity');
  assert.equal(result.actionRequired, 'remediate_or_compensate');
  assert.equal(applyCalls, 0);
});

test('handler failure records bounded failed state instead of advancing', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => {
          const error = new Error('private host details that must not persist');
          error.code = 'unix_identity_apply_failed';
          throw error;
        },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error, 'unix_identity_apply_failed');
  assert.equal(result.operation.steps[0].state, 'failed');
  assert.equal(result.operation.steps[0].error, 'unix_identity_apply_failed');
});
