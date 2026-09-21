import { panelRequest } from '../api.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_PATTERN = /^[a-z0-9_]{1,80}$/;

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function stepId(value) {
  if (typeof value !== 'string' || !STEP_PATTERN.test(value)) throw new Error('provisioning step id is invalid');
  return value;
}

function continueConfirmation(operationId) {
  return `continue-site-provisioning:${uuid(operationId, 'provisioning operation id')}`;
}

function retryConfirmation(operationId, provisioningStepId) {
  return `retry-site-provisioning:${uuid(operationId, 'provisioning operation id')}:${stepId(provisioningStepId)}`;
}

function compensationConfirmation(operationId, provisioningStepId) {
  return `compensate-site-provisioning:${uuid(operationId, 'provisioning operation id')}:${stepId(provisioningStepId)}`;
}

export function provisioningConfirmation(action, operationId, provisioningStepId = null) {
  if (action === 'continue') return continueConfirmation(operationId);
  if (action === 'retry') return retryConfirmation(operationId, provisioningStepId);
  if (action === 'compensate') return compensationConfirmation(operationId, provisioningStepId);
  throw new Error('unsupported provisioning recovery action');
}

export function getLatestWebsiteProvisioning(websiteId, { signal } = {}) {
  const id = uuid(websiteId, 'website id');
  return panelRequest(`/sites/${encodeURIComponent(id)}/provisioning/latest`, { signal });
}

export function continueWebsiteProvisioning(operationId) {
  const id = uuid(operationId, 'provisioning operation id');
  return panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/continue`, {
    method: 'POST',
    body: { confirmation: provisioningConfirmation('continue', id) },
  });
}

export function retryWebsiteProvisioningStep(operationId, provisioningStepId) {
  const id = uuid(operationId, 'provisioning operation id');
  const step = stepId(provisioningStepId);
  return panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/retry`, {
    method: 'POST',
    body: { confirmation: provisioningConfirmation('retry', id, step) },
  });
}

export function compensateWebsiteProvisioningStep(operationId, provisioningStepId) {
  const id = uuid(operationId, 'provisioning operation id');
  const step = stepId(provisioningStepId);
  return panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/compensate`, {
    method: 'POST',
    body: { confirmation: provisioningConfirmation('compensate', id, step) },
  });
}

export async function autoAdvanceWebsiteProvisioning(operationId, { maxSteps = 30, signal, onStep } = {}) {
  const id = uuid(operationId, 'provisioning operation id');
  let currentOperation = null;
  const retriedSteps = new Set();
  for (let i = 0; i < maxSteps; i += 1) {
    if (signal?.aborted) break;
    let result = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) break;
      try {
        result = await panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/continue`, {
          method: 'POST',
          body: { confirmation: continueConfirmation(id) },
          signal,
        });
        break;
      } catch (err) {
        if (attempt === 2 || signal?.aborted) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    currentOperation = result?.operation ?? null;
    if (typeof onStep === 'function') onStep(result);

    if (result?.outcome === 'failed' && result?.stepId && !retriedSteps.has(result.stepId)) {
      retriedSteps.add(result.stepId);
      try {
        const retryResult = await retryWebsiteProvisioningStep(id, result.stepId);
        currentOperation = retryResult?.operation ?? currentOperation;
        if (typeof onStep === 'function') onStep(retryResult);
        if (retryResult?.outcome === 'progressed') {
          continue;
        }
      } catch {
        // Fall through to outcome check
      }
    }

    if (!result || ['ready', 'failed', 'blocked', 'interrupted'].includes(result.outcome)) {
      break;
    }
  }
  return currentOperation;
}

export const provisioningClientInternals = Object.freeze({
  uuid,
  stepId,
  continueConfirmation,
  retryConfirmation,
  compensationConfirmation,
});
