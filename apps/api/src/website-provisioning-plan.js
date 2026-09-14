const STEP_STATES = new Set([
  'pending',
  'applying',
  'succeeded',
  'failed',
  'blocked',
  'compensating',
  'compensated',
]);

const COMPENSATION_STATES = new Set([
  'not_required',
  'pending',
  'applying',
  'succeeded',
  'failed',
]);

export class WebsiteProvisioningPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteProvisioningPlanError';
    this.code = code;
  }
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length < 1) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function nullableEvidence(value, field) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `${field} must be an object or null`);
  }
  return Object.freeze({ ...value });
}

function normalizedCompensation(value, stepId) {
  const compensation = value ?? { state: 'not_required' };
  if (!compensation || typeof compensation !== 'object' || Array.isArray(compensation)) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `Step ${stepId} compensation must be an object`);
  }
  const state = compensation.state ?? 'not_required';
  if (!COMPENSATION_STATES.has(state)) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `Step ${stepId} compensation state is invalid`);
  }
  return Object.freeze({
    state,
    evidence: nullableEvidence(compensation.evidence, `Step ${stepId} compensation evidence`),
    error: compensation.error == null ? null : nonEmptyString(compensation.error, `Step ${stepId} compensation error`),
  });
}

function normalizedStep(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `Step ${index + 1} must be an object`);
  }
  const id = nonEmptyString(value.id, `Step ${index + 1} id`);
  const state = value.state ?? 'pending';
  if (!STEP_STATES.has(state)) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `Step ${id} state is invalid`);
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `Step ${id} required must be boolean`);
  }
  if (value.intent !== undefined && (!value.intent || typeof value.intent !== 'object' || Array.isArray(value.intent))) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', `Step ${id} intent must be an object`);
  }
  return Object.freeze({
    id,
    kind: nonEmptyString(value.kind ?? id, `Step ${id} kind`),
    required: value.required !== false,
    state,
    intent: Object.freeze({ ...(value.intent ?? {}) }),
    evidence: nullableEvidence(value.evidence, `Step ${id} evidence`),
    error: value.error == null ? null : nonEmptyString(value.error, `Step ${id} error`),
    compensation: normalizedCompensation(value.compensation, id),
  });
}

function statusFromSteps(steps) {
  const required = steps.filter((step) => step.required);
  const ready = required.length > 0 && required.every((step) => step.state === 'succeeded');
  if (ready) return 'ready';
  if (required.some((step) => step.state === 'failed')) return 'failed';
  if (required.some((step) => step.state === 'compensating')) return 'compensating';
  if (required.some((step) => step.state === 'applying')) return 'applying';
  if (required.some((step) => step.state === 'blocked')) return 'blocked';
  if (steps.some((step) => step.state === 'succeeded' || step.state === 'compensated')) return 'partial';
  return 'pending';
}

export function createWebsiteProvisioningPlan({ operationId, websiteId, resources = {}, steps = [] } = {}) {
  const normalizedOperationId = nonEmptyString(operationId, 'operationId');
  const normalizedWebsiteId = nonEmptyString(websiteId, 'websiteId');
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', 'resources must be an object');
  }
  if (!Array.isArray(steps) || steps.length < 1) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', 'steps must contain at least one provisioning step');
  }
  const normalizedSteps = steps.map(normalizedStep);
  if (new Set(normalizedSteps.map((step) => step.id)).size !== normalizedSteps.length) {
    throw new WebsiteProvisioningPlanError('website_provisioning_plan_invalid', 'Provisioning step ids must be unique');
  }
  const status = statusFromSteps(normalizedSteps);
  const requiredSteps = normalizedSteps.filter((step) => step.required);
  const completedSteps = requiredSteps.filter((step) => step.state === 'succeeded');
  return Object.freeze({
    version: 1,
    operationId: normalizedOperationId,
    websiteId: normalizedWebsiteId,
    status,
    ready: status === 'ready',
    progress: Object.freeze({
      required: requiredSteps.length,
      completed: completedSteps.length,
      remaining: requiredSteps.length - completedSteps.length,
    }),
    resources: Object.freeze({ ...resources }),
    steps: Object.freeze(normalizedSteps),
  });
}

export const websiteProvisioningPlanInternals = Object.freeze({
  statusFromSteps,
});
