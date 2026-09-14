import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteProvisioningPlan,
  WebsiteProvisioningPlanError,
} from '../src/website-provisioning-plan.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';

function step(id, state, extra = {}) {
  return {
    id,
    kind: id,
    state,
    intent: { resourceId: `${id}-resource` },
    ...extra,
  };
}

test('provisioning plan is not ready while required host work remains', () => {
  const plan = createWebsiteProvisioningPlan({
    operationId,
    websiteId,
    resources: { website: { id: websiteId } },
    steps: [
      step('metadata', 'succeeded'),
      step('unix_identity', 'pending'),
      step('runtime', 'pending'),
      step('nginx', 'pending'),
    ],
  });

  assert.equal(plan.status, 'partial');
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.progress, { required: 4, completed: 1, remaining: 3 });
  assert.equal(plan.steps[0].evidence, null);
  assert.equal(plan.steps[1].compensation.state, 'not_required');
});

test('provisioning plan becomes ready only when every required step succeeds', () => {
  const plan = createWebsiteProvisioningPlan({
    operationId,
    websiteId,
    steps: [
      step('metadata', 'succeeded', { evidence: { revision: 1 } }),
      step('unix_identity', 'succeeded', { compensation: { state: 'pending' } }),
      step('runtime', 'succeeded'),
      step('nginx', 'succeeded'),
      step('optional_mail', 'pending', { required: false }),
    ],
  });

  assert.equal(plan.status, 'ready');
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.progress, { required: 4, completed: 4, remaining: 0 });
  assert.deepEqual(plan.steps[0].evidence, { revision: 1 });
  assert.equal(plan.steps[1].compensation.state, 'pending');
});

test('provisioning plan surfaces failed and compensating required work', () => {
  const failed = createWebsiteProvisioningPlan({
    operationId,
    websiteId,
    steps: [step('metadata', 'succeeded'), step('runtime', 'failed', { error: 'runtime_failed' })],
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.ready, false);

  const compensating = createWebsiteProvisioningPlan({
    operationId,
    websiteId,
    steps: [step('metadata', 'succeeded'), step('runtime', 'compensating')],
  });
  assert.equal(compensating.status, 'compensating');
  assert.equal(compensating.ready, false);
});

test('provisioning plan rejects duplicate steps and invalid state', () => {
  assert.throws(
    () => createWebsiteProvisioningPlan({
      operationId,
      websiteId,
      steps: [step('runtime', 'pending'), step('runtime', 'pending')],
    }),
    (error) => error instanceof WebsiteProvisioningPlanError && error.code === 'website_provisioning_plan_invalid',
  );

  assert.throws(
    () => createWebsiteProvisioningPlan({ operationId, websiteId, steps: [step('runtime', 'unknown')] }),
    (error) => error instanceof WebsiteProvisioningPlanError && error.code === 'website_provisioning_plan_invalid',
  );
});
