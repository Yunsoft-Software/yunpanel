import { panelRequest } from '../api.js';
import { sessionVersion, sessionTransitionPending } from '../session-client.js';
import { advanceProvisioning } from './provisioning-advance.js';

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

export function continueWebsiteProvisioning(operationId, { signal } = {}) {
  const id = uuid(operationId, 'provisioning operation id');
  return panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/continue`, {
    method: 'POST',
    body: { confirmation: provisioningConfirmation('continue', id) },
    ...(signal ? { signal } : {}),
  });
}

export function retryWebsiteProvisioningStep(operationId, provisioningStepId, { signal } = {}) {
  const id = uuid(operationId, 'provisioning operation id');
  const step = stepId(provisioningStepId);
  return panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/retry`, {
    method: 'POST',
    body: { confirmation: provisioningConfirmation('retry', id, step) },
    ...(signal ? { signal } : {}),
  });
}

export function compensateWebsiteProvisioningStep(operationId, provisioningStepId, { signal } = {}) {
  const id = uuid(operationId, 'provisioning operation id');
  const step = stepId(provisioningStepId);
  return panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/compensate`, {
    method: 'POST',
    body: { confirmation: provisioningConfirmation('compensate', id, step) },
    ...(signal ? { signal } : {}),
  });
}

export async function autoAdvanceWebsiteProvisioning(operationId, { maxSteps = 30, signal, onStep } = {}) {
  const id = uuid(operationId, 'provisioning operation id');
  const started = sessionVersion();
  return advanceProvisioning({
    isCurrent: () => started === sessionVersion() && !sessionTransitionPending(),
    operationId: id, maxSteps, signal, onStep,
    read: ({ signal: requestSignal }) => panelRequest(`/sites/provisioning/${encodeURIComponent(id)}`, { signal: requestSignal }),
    advance: ({ signal: requestSignal }) => panelRequest(`/sites/provisioning/${encodeURIComponent(id)}/continue`, {
      method: 'POST',
      body: { confirmation: continueConfirmation(id) },
      signal: requestSignal,
    }),
  });
}

export const provisioningClientInternals = Object.freeze({
  uuid,
  stepId,
  continueConfirmation,
  retryConfirmation,
  compensationConfirmation,
});
