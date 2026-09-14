import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createWebsiteProvisioningPlan,
  WebsiteProvisioningPlanError,
} from './website-provisioning-plan.js';

const STORE_VERSION = 1;

export class WebsiteProvisioningRegistryError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteProvisioningRegistryError';
    this.code = code;
    this.status = status;
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid Website provisioning registry state');
  return value;
}

function mutableStep(step) {
  return {
    id: step.id,
    kind: step.kind,
    required: step.required,
    state: step.state,
    intent: { ...step.intent },
    evidence: step.evidence ? { ...step.evidence } : null,
    error: step.error,
    compensation: {
      state: step.compensation.state,
      evidence: step.compensation.evidence ? { ...step.compensation.evidence } : null,
      error: step.compensation.error,
    },
  };
}

function publicOperation(operation) {
  const plan = createWebsiteProvisioningPlan({
    operationId: operation.operationId,
    websiteId: operation.websiteId,
    resources: operation.resources,
    steps: operation.steps,
  });
  return Object.freeze({
    ...plan,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

function normalizeStoredOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Website provisioning registry state');
  const allowed = new Set(['operationId', 'websiteId', 'resources', 'steps', 'createdAt', 'updatedAt']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('invalid Website provisioning registry state');
  let plan;
  try {
    plan = createWebsiteProvisioningPlan({
      operationId: value.operationId,
      websiteId: value.websiteId,
      resources: value.resources,
      steps: value.steps,
    });
  } catch (error) {
    if (error instanceof WebsiteProvisioningPlanError) throw new Error('invalid Website provisioning registry state');
    throw error;
  }
  return {
    operationId: plan.operationId,
    websiteId: plan.websiteId,
    resources: { ...plan.resources },
    steps: plan.steps.map(mutableStep),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function immutableStepDefinition(step) {
  return {
    id: step.id,
    kind: step.kind,
    required: step.required,
    intent: step.intent,
  };
}

function samePlan(left, right) {
  return JSON.stringify({
    operationId: left.operationId,
    websiteId: left.websiteId,
    resources: left.resources,
    steps: left.steps.map(immutableStepDefinition),
  }) === JSON.stringify({
    operationId: right.operationId,
    websiteId: right.websiteId,
    resources: right.resources,
    steps: right.steps.map(immutableStepDefinition),
  });
}

function requiredEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length < 1) {
    throw new WebsiteProvisioningRegistryError(
      'website_provisioning_evidence_required',
      'Successful provisioning steps require explicit evidence',
      400,
    );
  }
  return { ...value };
}

function failureCode(value, field = 'error') {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 160) {
    throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', `${field} must be a bounded non-empty string`, 400);
  }
  return value.trim();
}

export function createWebsiteProvisioningRegistry({ filePath = null, now = () => Date.now() } = {}) {
  if (typeof now !== 'function') {
    throw new WebsiteProvisioningRegistryError('website_provisioning_dependencies_invalid', 'Website provisioning registry dependencies are invalid', 503);
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = filePath === null;
  let writeChain = Promise.resolve();

  function nowIso() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WebsiteProvisioningRegistryError('website_provisioning_clock_invalid', 'Website provisioning registry clock is invalid', 503);
    }
    return new Date(value).toISOString();
  }

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)) throw new Error('invalid Website provisioning registry state');
      const operations = parsed.operations.map(normalizeStoredOperation);
      if (new Set(operations.map((operation) => operation.operationId)).size !== operations.length) {
        throw new Error('duplicate Website provisioning operation');
      }
      state = { version: STORE_VERSION, operations };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await persist();
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function requireOperation(operationId) {
    const operation = state.operations.find((candidate) => candidate.operationId === operationId);
    if (!operation) {
      throw new WebsiteProvisioningRegistryError('website_provisioning_not_found', 'Website provisioning operation was not found', 404);
    }
    return operation;
  }

  function requireStep(operation, stepId) {
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new WebsiteProvisioningRegistryError('website_provisioning_step_not_found', 'Website provisioning step was not found', 404);
    return step;
  }

  async function create(planInput) {
    await ensureInitialized();
    let plan;
    try { plan = createWebsiteProvisioningPlan(planInput); }
    catch (error) {
      if (error instanceof WebsiteProvisioningPlanError) {
        throw new WebsiteProvisioningRegistryError(error.code, error.message, 400);
      }
      throw error;
    }
    const existing = state.operations.find((operation) => operation.operationId === plan.operationId) ?? null;
    const candidate = {
      operationId: plan.operationId,
      websiteId: plan.websiteId,
      resources: { ...plan.resources },
      steps: plan.steps.map(mutableStep),
    };
    if (existing) {
      if (!samePlan(existing, candidate)) {
        throw new WebsiteProvisioningRegistryError('website_provisioning_conflict', 'Provisioning operation identity conflicts with persisted state');
      }
      return publicOperation(existing);
    }
    const time = nowIso();
    const operation = { ...candidate, createdAt: time, updatedAt: time };
    state.operations.push(operation);
    await persist();
    return publicOperation(operation);
  }

  async function get(operationId) {
    await ensureInitialized();
    const operation = state.operations.find((candidate) => candidate.operationId === operationId);
    return operation ? publicOperation(operation) : null;
  }

  async function beginStep({ operationId, stepId } = {}) {
    await ensureInitialized();
    const operation = requireOperation(operationId);
    const step = requireStep(operation, stepId);
    if (step.state === 'applying') return publicOperation(operation);
    if (step.state !== 'pending' && step.state !== 'blocked') {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Provisioning step cannot begin from current state');
    }
    step.state = 'applying';
    step.error = null;
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function completeStep({ operationId, stepId, evidence } = {}) {
    await ensureInitialized();
    const operation = requireOperation(operationId);
    const step = requireStep(operation, stepId);
    if (step.state === 'succeeded') return publicOperation(operation);
    if (step.state !== 'applying') {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Only an applying provisioning step can complete');
    }
    step.evidence = requiredEvidence(evidence);
    step.state = 'succeeded';
    step.error = null;
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function blockStep({ operationId, stepId, error, evidence = null } = {}) {
    await ensureInitialized();
    const operation = requireOperation(operationId);
    const step = requireStep(operation, stepId);
    if (step.state !== 'applying') {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Only an applying provisioning step can block');
    }
    step.state = 'blocked';
    step.error = failureCode(error);
    step.evidence = evidence == null ? null : requiredEvidence(evidence);
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function failStep({ operationId, stepId, error, evidence = null } = {}) {
    await ensureInitialized();
    const operation = requireOperation(operationId);
    const step = requireStep(operation, stepId);
    if (step.state !== 'applying') {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Only an applying provisioning step can fail');
    }
    step.state = 'failed';
    step.error = failureCode(error);
    step.evidence = evidence == null ? null : requiredEvidence(evidence);
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function beginCompensation({ operationId, stepId } = {}) {
    await ensureInitialized();
    const operation = requireOperation(operationId);
    const step = requireStep(operation, stepId);
    if (step.compensation.state === 'applying') return publicOperation(operation);
    if (!['succeeded', 'failed'].includes(step.state)
      || !['pending', 'failed'].includes(step.compensation.state)) {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Provisioning compensation cannot begin from current state');
    }
    step.state = 'compensating';
    step.compensation.state = 'applying';
    step.compensation.error = null;
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function completeCompensation({ operationId, stepId, evidence } = {}) {
    await ensureInitialized();
    const operation = requireOperation(operationId);
    const step = requireStep(operation, stepId);
    if (step.state === 'compensated' && step.compensation.state === 'succeeded') return publicOperation(operation);
    if (step.state !== 'compensating' || step.compensation.state !== 'applying') {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Only an applying compensation can complete');
    }
    step.compensation.evidence = requiredEvidence(evidence);
    step.compensation.state = 'succeeded';
    step.compensation.error = null;
    step.state = 'compensated';
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function failCompensation({ operationId, stepId, error } = {}) {
    await ensureInitialized();
    const operation = requireOperation(operationId);
    const step = requireStep(operation, stepId);
    if (step.state !== 'compensating' || step.compensation.state !== 'applying') {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Only an applying compensation can fail');
    }
    step.compensation.state = 'failed';
    step.compensation.error = failureCode(error, 'compensation error');
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function listInterrupted() {
    await ensureInitialized();
    return Object.freeze(state.operations
      .filter((operation) => operation.steps.some((step) => step.state === 'applying' || step.state === 'compensating'))
      .map(publicOperation));
  }

  return Object.freeze({
    init,
    create,
    get,
    beginStep,
    completeStep,
    blockStep,
    failStep,
    beginCompensation,
    completeCompensation,
    failCompensation,
    listInterrupted,
  });
}
