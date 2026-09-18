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

test('blocked required step without inspection stays blocked and never mutates', async () => {
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

test('unsatisfied handler result persists a blocked step instead of false success', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => ({ satisfied: false, reason: 'website_release_missing' }),
        inspect: async () => ({ satisfied: false, reason: 'website_release_missing' }),
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.error, 'website_release_missing');
  assert.equal(result.operation.steps[0].state, 'blocked');
  assert.equal(result.operation.steps[0].error, 'website_release_missing');
  assert.deepEqual(result.operation.steps[0].evidence, { satisfied: false, reason: 'website_release_missing' });
});

test('confirmed continuation can reconcile a fixed blocked dependency without re-applying it', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.blockStep({
    operationId,
    stepId: 'unix_identity',
    error: 'website_release_missing',
    evidence: { satisfied: false, reason: 'website_release_missing' },
  });
  let applyCalls = 0;
  let inspectCalls = 0;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => { applyCalls += 1; return { uid: 1201 }; },
        inspect: async () => {
          inspectCalls += 1;
          return { satisfied: true, uid: 1201, gid: 1201 };
        },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(applyCalls, 0);
  assert.equal(inspectCalls, 1);
  assert.equal(result.outcome, 'reconciled');
  assert.equal(result.operation.steps[0].state, 'succeeded');
  assert.equal(result.operation.steps[0].error, null);
  assert.deepEqual(result.operation.steps[0].evidence, { satisfied: true, uid: 1201, gid: 1201 });
});

test('blocked continuation refreshes actionable inspection evidence without re-applying', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.blockStep({
    operationId,
    stepId: 'unix_identity',
    error: 'passenger_runtime_unavailable',
    evidence: { satisfied: false, reason: 'passenger_runtime_unavailable' },
  });
  let applyCalls = 0;
  let inspectCalls = 0;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => { applyCalls += 1; return { satisfied: true }; },
        inspect: async () => {
          inspectCalls += 1;
          return { satisfied: false, reason: 'passenger_node_unavailable', nodeMajor: 24 };
        },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(applyCalls, 0);
  assert.equal(inspectCalls, 1);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.error, 'passenger_node_unavailable');
  assert.equal(result.operation.steps[0].state, 'blocked');
  assert.equal(result.operation.steps[0].error, 'passenger_node_unavailable');
  assert.deepEqual(result.operation.steps[0].evidence, {
    satisfied: false,
    reason: 'passenger_node_unavailable',
    nodeMajor: 24,
  });
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

test('explicit retry resets only the failed step and re-runs it through the normal durable path', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  let attempts = 0;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('first attempt failed');
            error.code = 'unix_identity_apply_failed';
            throw error;
          }
          return { satisfied: true, uid: 1201, gid: 1201 };
        },
      },
    },
  });

  const failed = await orchestrator.runNext(operationId);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.operation.steps[0].state, 'failed');

  const retried = await orchestrator.retryStep(operationId, 'unix_identity');
  assert.equal(attempts, 2);
  assert.equal(retried.outcome, 'progressed');
  assert.equal(retried.operation.steps[0].state, 'succeeded');
  assert.equal(retried.operation.steps[0].error, null);
  assert.equal(retried.operation.steps[1].state, 'pending');
});

test('compensation intent is persisted before invoking the compensating handler', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.completeStep({
    operationId,
    stepId: 'unix_identity',
    evidence: { satisfied: true, uid: 1201, gid: 1201 },
  });
  let observedState = null;
  let observedEvidence = null;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => ({ satisfied: true, uid: 1201 }),
        compensate: async ({ evidence: stepEvidence }) => {
          observedState = (await registry.get(operationId)).steps[0].state;
          observedEvidence = stepEvidence;
          return { satisfied: true, removedUser: true };
        },
      },
    },
  });

  const result = await orchestrator.compensateStep(operationId, 'unix_identity');
  assert.equal(observedState, 'compensating');
  assert.deepEqual(observedEvidence, { satisfied: true, uid: 1201, gid: 1201 });
  assert.equal(result.outcome, 'compensated');
  assert.equal(result.operation.steps[0].state, 'compensated');
  assert.equal(result.operation.steps[0].compensation.state, 'succeeded');
  assert.deepEqual(result.operation.steps[0].compensation.evidence, { satisfied: true, removedUser: true });
});

test('failed compensation returns to the stable step state and can be retried', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.completeStep({
    operationId,
    stepId: 'unix_identity',
    evidence: { satisfied: true, uid: 1201 },
  });
  let attempts = 0;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => ({ satisfied: true, uid: 1201 }),
        compensate: async () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('private host details');
            error.code = 'unix_identity_compensation_failed';
            throw error;
          }
          return { satisfied: true, removedUser: true };
        },
      },
    },
  });

  const failed = await orchestrator.compensateStep(operationId, 'unix_identity');
  assert.equal(failed.outcome, 'compensation_failed');
  assert.equal(failed.error, 'unix_identity_compensation_failed');
  assert.equal(failed.operation.steps[0].state, 'succeeded');
  assert.equal(failed.operation.steps[0].compensation.state, 'failed');

  const retried = await orchestrator.compensateStep(operationId, 'unix_identity');
  assert.equal(attempts, 2);
  assert.equal(retried.outcome, 'compensated');
  assert.equal(retried.operation.steps[0].state, 'compensated');
});

test('interrupted compensation is inspected and never blindly repeated', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(plan());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.completeStep({
    operationId,
    stepId: 'unix_identity',
    evidence: { satisfied: true, uid: 1201 },
  });
  await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
  let compensateCalls = 0;
  let inspectCalls = 0;
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => ({ satisfied: true, uid: 1201 }),
        compensate: async () => { compensateCalls += 1; return { satisfied: true, removedUser: true }; },
        inspectCompensation: async () => {
          inspectCalls += 1;
          return { satisfied: true, removedUser: true };
        },
      },
    },
  });

  const result = await orchestrator.runNext(operationId);
  assert.equal(compensateCalls, 0);
  assert.equal(inspectCalls, 1);
  assert.equal(result.outcome, 'compensated');
  assert.equal(result.operation.steps[0].state, 'compensated');
});

test('orchestrator reports compensation support from concrete handlers only', () => {
  const registry = createWebsiteProvisioningRegistry();
  const orchestrator = createWebsiteProvisioningOrchestrator({
    registry,
    handlers: {
      unix_identity: {
        apply: async () => ({ satisfied: true }),
        compensate: async () => ({ satisfied: true }),
      },
      runtime: {
        apply: async () => ({ satisfied: true }),
      },
    },
  });

  assert.equal(orchestrator.supportsCompensation('unix_identity'), true);
  assert.equal(orchestrator.supportsCompensation('runtime'), false);
  assert.equal(orchestrator.supportsCompensation('certificate'), false);
});
