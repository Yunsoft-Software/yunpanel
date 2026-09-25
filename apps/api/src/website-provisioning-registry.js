import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findBlockingLaterCompensationStep } from './website-provisioning-compensation-order.js';
import { createProcessStoreLock } from './process-store-lock.js';
import {
  createWebsiteProvisioningPlan,
  WebsiteProvisioningPlanError,
} from './website-provisioning-plan.js';

const STORE_VERSION = 1;
const TERMINAL_STATES = new Set(['abandoned']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function privateActor(value, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 128
    || typeof value.userId !== 'string' || value.userId.length < 1 || value.userId.length > 128
    || !['owner', 'site_manager'].includes(value.role)) {
    throw new WebsiteProvisioningRegistryError(
      'website_provisioning_actor_invalid',
      'Website provisioning actor evidence is invalid',
      400,
    );
  }
  return Object.freeze({
    sessionId: value.sessionId,
    userId: value.userId,
    role: value.role,
  });
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
  const abandoned = operation.terminalState === 'abandoned';
  return Object.freeze({
    ...plan,
    ...(abandoned ? { status: 'abandoned', ready: false } : {}),
    terminalState: operation.terminalState ?? null,
    abandonedAt: operation.abandonedAt ?? null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

function normalizeStoredOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Website provisioning registry state');
  const allowed = new Set([
    'operationId', 'websiteId', 'resources', 'steps',
    'actor', 'terminalState', 'abandonedAt', 'createdAt', 'updatedAt',
  ]);
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
  const terminalState = value.terminalState ?? null;
  if (terminalState !== null && !TERMINAL_STATES.has(terminalState)) {
    throw new Error('invalid Website provisioning registry state');
  }
  const abandonedAt = value.abandonedAt ?? null;
  if ((terminalState === 'abandoned') !== (abandonedAt !== null)) {
    throw new Error('invalid Website provisioning registry state');
  }
  return {
    operationId: plan.operationId,
    websiteId: plan.websiteId,
    resources: { ...plan.resources },
    steps: plan.steps.map(mutableStep),
    actor: privateActor(value.actor, { optional: true }),
    terminalState,
    abandonedAt: abandonedAt === null ? null : timestamp(abandonedAt),
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

export function createWebsiteProvisioningRegistry({
  filePath = null,
  now = () => Date.now(),
  storeLockFactory = createProcessStoreLock,
} = {}) {
  if (typeof now !== 'function') {
    throw new WebsiteProvisioningRegistryError('website_provisioning_dependencies_invalid', 'Website provisioning registry dependencies are invalid', 503);
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = filePath === null;
  let writeChain = Promise.resolve();
  const storeLock = filePath ? storeLockFactory({ filePath: path.resolve(filePath) }) : null;
  if (filePath && (!storeLock || typeof storeLock.withLock !== 'function')) {
    throw new WebsiteProvisioningRegistryError(
      'website_provisioning_store_lock_invalid',
      'Website provisioning store lock is invalid',
      503,
    );
  }

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

  async function reload() {
    if (!filePath) { initialized = true; return true; }
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)) throw new Error('invalid Website provisioning registry state');
      const operations = parsed.operations.map(normalizeStoredOperation);
      if (new Set(operations.map((operation) => operation.operationId)).size !== operations.length) {
        throw new Error('duplicate Website provisioning operation');
      }
      state = { version: STORE_VERSION, operations };
      initialized = true;
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      state = { version: STORE_VERSION, operations: [] };
      initialized = true;
      return false;
    }
  }

  async function init() {
    if (initialized) return;
    const initialize = async () => {
      const found = await reload();
      if (!found) await persist();
    };
    if (storeLock) await storeLock.withLock(initialize);
    else await initialize();
  }

  async function withStoreMutation(action) {
    await ensureInitialized();
    if (!storeLock) return action();
    return storeLock.withLock(async () => {
      await reload();
      try { return await action(); }
      catch (error) {
        await reload().catch(() => {});
        throw error;
      }
    });
  }

  async function withStoreRead(action) {
    await ensureInitialized();
    if (!storeLock) return action();
    return storeLock.withLock(async () => {
      await reload();
      return action();
    });
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
  function requireActive(operation) {
    if (operation.terminalState === 'abandoned') {
      throw new WebsiteProvisioningRegistryError(
        'website_provisioning_abandoned',
        'Provisioning operation is abandoned and cannot mutate resources',
        409,
      );
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
      actor: null,
      terminalState: null,
      abandonedAt: null,
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

  async function getActor(operationId) {
    await ensureInitialized();
    const operation = state.operations.find((candidate) => candidate.operationId === operationId);
    return operation ? privateActor(operation.actor, { optional: true }) : null;
  }

  async function refreshActor({ operationId, actor } = {}) {
    await ensureInitialized();
    const operation = requireActive(requireOperation(operationId));
    operation.actor = privateActor(actor);
    await persist();
    return privateActor(operation.actor);
  }

  async function getLatestForWebsite(websiteId) {
    await ensureInitialized();
    const operation = state.operations
      .filter((candidate) => candidate.websiteId === websiteId)
      .sort((left, right) => {
        const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
        if (byUpdatedAt !== 0) return byUpdatedAt;
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt;
        return right.operationId.localeCompare(left.operationId);
      })[0] ?? null;
    return operation ? publicOperation(operation) : null;
  }

  async function listForWebsite(websiteId) {
    await ensureInitialized();
    if (typeof websiteId !== 'string' || !websiteId) {
      throw new WebsiteProvisioningRegistryError(
        'website_provisioning_website_id_invalid',
        'Website id is required',
        400,
      );
    }
    return Object.freeze(state.operations
      .filter((candidate) => candidate.websiteId === websiteId)
      .sort((left, right) => {
        const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
        if (byUpdatedAt !== 0) return byUpdatedAt;
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt;
        return right.operationId.localeCompare(left.operationId);
      })
      .map(publicOperation));
  }

  async function listForDnsZone({ serverId, webDomainId, zoneName } = {}) {
    await ensureInitialized();
    for (const [field, value] of Object.entries({ serverId, webDomainId, zoneName })) {
      if (typeof value !== 'string' || value.length < 1 || value.length > 253
        || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new WebsiteProvisioningRegistryError(
          'website_provisioning_dns_zone_scope_invalid',
          `${field} is invalid`,
          400,
        );
      }
    }
    return Object.freeze(state.operations
      .filter((operation) => operation.steps.some((step) => (
        step.kind === 'dns_zone'
        && step.intent?.serverId === serverId
        && step.intent?.webDomainId === webDomainId
        && step.intent?.zoneName === zoneName
      )))
      .sort((left, right) => {
        const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
        if (byUpdatedAt !== 0) return byUpdatedAt;
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt;
        return right.operationId.localeCompare(left.operationId);
      })
      .map(publicOperation));
  }

  async function beginStep({ operationId, stepId } = {}) {
    await ensureInitialized();
    const operation = requireActive(requireOperation(operationId));
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
    const operation = requireActive(requireOperation(operationId));
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
    const operation = requireActive(requireOperation(operationId));
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
    const operation = requireActive(requireOperation(operationId));
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

  async function retryStep({ operationId, stepId } = {}) {
    await ensureInitialized();
    const operation = requireActive(requireOperation(operationId));
    const step = requireStep(operation, stepId);
    if (step.state !== 'failed'
      || !['pending', 'not_required'].includes(step.compensation.state)) {
      throw new WebsiteProvisioningRegistryError(
        'website_provisioning_retry_invalid',
        'Only a failed provisioning step without active compensation can be retried',
      );
    }
    step.state = 'pending';
    step.error = null;
    step.evidence = null;
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function beginCompensation({ operationId, stepId } = {}) {
    await ensureInitialized();
    const operation = requireActive(requireOperation(operationId));
    const step = requireStep(operation, stepId);
    if (step.compensation.state === 'applying') return publicOperation(operation);
    if (!['succeeded', 'failed'].includes(step.state)
      || !['pending', 'failed'].includes(step.compensation.state)) {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Provisioning compensation cannot begin from current state');
    }
    if (findBlockingLaterCompensationStep(operation, stepId)) {
      throw new WebsiteProvisioningRegistryError(
        'website_provisioning_compensation_order_invalid',
        'Later provisioning steps must be compensated before this step',
      );
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
    const operation = requireActive(requireOperation(operationId));
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
    const operation = requireActive(requireOperation(operationId));
    const step = requireStep(operation, stepId);
    if (step.state !== 'compensating' || step.compensation.state !== 'applying') {
      throw new WebsiteProvisioningRegistryError('website_provisioning_transition_invalid', 'Only an applying compensation can fail');
    }
    step.compensation.state = 'failed';
    step.compensation.error = failureCode(error, 'compensation error');
    step.state = step.error === null ? 'succeeded' : 'failed';
    operation.updatedAt = nowIso();
    await persist();
    return publicOperation(operation);
  }

  async function abandonUncreated({
    operationId,
    websiteId,
    applicationId = null,
    websiteAbsent,
    applicationAbsent,
  } = {}) {
    await ensureInitialized();
    if (typeof operationId !== 'string' || !UUID_PATTERN.test(operationId)
      || typeof websiteId !== 'string' || !UUID_PATTERN.test(websiteId)
      || (applicationId !== null && (typeof applicationId !== 'string' || !UUID_PATTERN.test(applicationId)))
      || websiteAbsent !== true
      || applicationAbsent !== (applicationId !== null)) {
      throw new WebsiteProvisioningRegistryError(
        'website_provisioning_abandon_evidence_invalid',
        'Verified uncreated Website evidence is required before abandoning provisioning',
        409,
      );
    }
    const operation = requireOperation(operationId);
    if (operation.websiteId !== websiteId) {
      throw new WebsiteProvisioningRegistryError(
        'website_provisioning_abandon_identity_conflict',
        'Provisioning recovery identity does not match the journal',
        409,
      );
    }
    if (applicationId !== null) {
      if (operation.resources?.application?.id !== applicationId
        || operation.resources?.website?.applicationId !== applicationId) {
        throw new WebsiteProvisioningRegistryError(
          'website_provisioning_abandon_identity_conflict',
          'Provisioning Application identity does not match recovery evidence',
          409,
        );
      }
    }
    if (operation.terminalState === 'abandoned') return publicOperation(operation);

    const unsafe = operation.steps.find((step) => (
      step.state !== 'pending'
      && !(step.state === 'compensated' && step.compensation?.state === 'succeeded')
    ));
    if (unsafe) {
      throw new WebsiteProvisioningRegistryError(
        'website_provisioning_abandon_requires_compensation',
        'Provisioning journal still contains active, failed, blocked, or uncompensated work',
        409,
      );
    }

    const time = nowIso();
    operation.terminalState = 'abandoned';
    operation.abandonedAt = time;
    operation.updatedAt = time;
    await persist();
    return publicOperation(operation);
  }

  async function listInterrupted() {
    await ensureInitialized();
    return Object.freeze(state.operations
      .filter((operation) => operation.terminalState !== 'abandoned'
        && operation.steps.some((step) => step.state === 'applying' || step.state === 'compensating'))
      .map(publicOperation));
  }

  async function listAuthorizationSensitive() {
    await ensureInitialized();
    return Object.freeze(state.operations
      .filter((operation) => operation.terminalState !== 'abandoned'
        && operation.steps.some((step) => (
          ['applying', 'failed', 'blocked', 'compensating'].includes(step.state)
          || ['applying', 'failed'].includes(step.compensation?.state)
        )))
      .map(publicOperation));
  }

  return Object.freeze({
    init,
    create: (...args) => withStoreMutation(() => create(...args)),
    get: (...args) => withStoreRead(() => get(...args)),
    getActor: (...args) => withStoreRead(() => getActor(...args)),
    refreshActor: (...args) => withStoreMutation(() => refreshActor(...args)),
    getLatestForWebsite: (...args) => withStoreRead(() => getLatestForWebsite(...args)),
    listForWebsite: (...args) => withStoreRead(() => listForWebsite(...args)),
    listForDnsZone: (...args) => withStoreRead(() => listForDnsZone(...args)),
    beginStep: (...args) => withStoreMutation(() => beginStep(...args)),
    completeStep: (...args) => withStoreMutation(() => completeStep(...args)),
    blockStep: (...args) => withStoreMutation(() => blockStep(...args)),
    failStep: (...args) => withStoreMutation(() => failStep(...args)),
    retryStep: (...args) => withStoreMutation(() => retryStep(...args)),
    beginCompensation: (...args) => withStoreMutation(() => beginCompensation(...args)),
    completeCompensation: (...args) => withStoreMutation(() => completeCompensation(...args)),
    failCompensation: (...args) => withStoreMutation(() => failCompensation(...args)),
    abandonUncreated: (...args) => withStoreMutation(() => abandonUncreated(...args)),
    listInterrupted: (...args) => withStoreRead(() => listInterrupted(...args)),
    listAuthorizationSensitive: (...args) => withStoreRead(() => listAuthorizationSensitive(...args)),
  });
}
