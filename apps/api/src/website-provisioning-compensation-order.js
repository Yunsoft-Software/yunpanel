const BLOCKING_LATER_STEP_STATES = new Set([
  'applying',
  'succeeded',
  'failed',
  'compensating',
]);

export function findBlockingLaterCompensationStep(operation, stepId) {
  const steps = Array.isArray(operation?.steps) ? operation.steps : [];
  const index = steps.findIndex((step) => step?.id === stepId);
  if (index < 0) return null;
  return steps.slice(index + 1)
    .find((step) => BLOCKING_LATER_STEP_STATES.has(step?.state)) ?? null;
}

export function canBeginCompensationInOrder(operation, stepId) {
  const steps = Array.isArray(operation?.steps) ? operation.steps : [];
  if (!steps.some((step) => step?.id === stepId)) return false;
  return findBlockingLaterCompensationStep(operation, stepId) === null;
}

export const websiteProvisioningCompensationOrderInternals = Object.freeze({
  BLOCKING_LATER_STEP_STATES,
});
