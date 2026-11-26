const BLOCKING_LATER_STEP_STATES = new Set([
  'applying',
  'succeeded',
  'failed',
  'compensating',
]);

function blocksEarlierCompensation(step) {
  if (!step || !BLOCKING_LATER_STEP_STATES.has(step.state)) return false;
  if (step.state === 'applying' || step.state === 'compensating') return true;
  return step.compensation?.state !== 'not_required';
}

export function findBlockingLaterCompensationStep(operation, stepId) {
  const steps = Array.isArray(operation?.steps) ? operation.steps : [];
  const index = steps.findIndex((step) => step?.id === stepId);
  if (index < 0) return null;
  return steps.slice(index + 1).find(blocksEarlierCompensation) ?? null;
}

export function canBeginCompensationInOrder(operation, stepId) {
  const steps = Array.isArray(operation?.steps) ? operation.steps : [];
  if (!steps.some((step) => step?.id === stepId)) return false;
  return findBlockingLaterCompensationStep(operation, stepId) === null;
}

export const websiteProvisioningCompensationOrderInternals = Object.freeze({
  BLOCKING_LATER_STEP_STATES,
  blocksEarlierCompensation,
});
