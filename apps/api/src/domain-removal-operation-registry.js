import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const OPERATION_STATUSES = new Set(['pending', 'running', 'blocked', 'failed', 'removed']);
const STEP_STATUSES = new Set(['pending', 'running', 'blocked', 'failed', 'succeeded']);
const STEP_KINDS = new Set([
  'routing_suspend',
  'child_domain',
  'certificate',
  'mail_domain',
  'external_dns_zone',
  'website_binding',
  'authoritative_dns',
  'metadata_finalization',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,160}$/;
const SAFE_CODE = /^[a-z0-9_]{1,120}$/;

export class DomainRemovalOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRemovalOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  return new DomainRemovalOperationRegistryError(
    'domain_removal_operation_state_invalid',
    message,
    409,
  );
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw invalid('Domain removal operation timestamp is invalid');
  }
  return value;
}

function safeError(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || Object.keys(value).some((field) => !['code', 'message'].includes(field))
    || typeof value.code !== 'string' || !SAFE_CODE.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw invalid('Domain removal operation error evidence is invalid');
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function stepResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || Object.keys(value).some((field) => !['referenceId', 'evidenceDigest'].includes(field))
    || (value.referenceId !== null
      && (typeof value.referenceId !== 'string' || !SAFE_ID.test(value.referenceId)))
    || (value.evidenceDigest !== null
      && (typeof value.evidenceDigest !== 'string' || !SHA256_PATTERN.test(value.evidenceDigest)))) {
    throw invalid('Domain removal step result evidence is invalid');
  }
  return Object.freeze({
    referenceId: value.referenceId,
    evidenceDigest: value.evidenceDigest,
  });
}

function persistedStep(value) {
  const fields = new Set([
    'id', 'kind', 'resourceId', 'status', 'result', 'error', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !STEP_KINDS.has(value.kind)
    || !STEP_STATUSES.has(value.status)) {
    throw invalid('Domain removal step state is invalid');
  }
  const result = stepResult(value.result);
  const error = safeError(value.error);
  if ((value.status === 'succeeded') !== (result !== null)
    || (!['blocked', 'failed'].includes(value.status) && error !== null)
    || (['blocked', 'failed'].includes(value.status) && error === null)) {
    throw invalid('Domain removal step evidence does not match lifecycle state');
  }
  return Object.freeze({
    id: safeId(value.id, 'stepId'),
    kind: value.kind,
    resourceId: safeId(value.resourceId, 'stepResourceId'),
    status: value.status,
    result,
    error,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function normalizedPlan(value) {
  const fields = new Set([
    'childDomainIds', 'websiteId', 'applicationId', 'managedComposeProjectId',
    'certificateIds', 'dnsZoneIds', 'mailDomainIds', 'activeJobIds',
    'additional', 'authoritativeDns',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) {
    throw invalid('Domain removal operation plan is invalid');
  }
  const ids = (items, field, { preserveOrder = false } = {}) => {
    if (!Array.isArray(items) || items.length > 500) throw invalid(`${field} plan is invalid`);
    const normalized = items.map((item) => safeId(item, field));
    if (new Set(normalized).size !== normalized.length) throw invalid(`${field} plan has duplicates`);
    if (!preserveOrder) normalized.sort();
    return Object.freeze(normalized);
  };
  const optionalId = (item, field) => item === null || item === undefined
    ? null
    : safeId(item, field);
  const normalizedAdditional = (additional) => {
    const additionalFields = new Set(['mailboxes', 'backups', 'crons', 'dockerWorkloads']);
    if (!additional || typeof additional !== 'object' || Array.isArray(additional)
      || Object.keys(additional).length !== additionalFields.size
      || Object.keys(additional).some((field) => !additionalFields.has(field))) {
      throw invalid('Domain removal additional dependency plan is invalid');
    }
    const bucket = (entry, field) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).length !== 2
        || Object.keys(entry).some((key) => !['status', 'ids'].includes(key))
        || !['available', 'unavailable'].includes(entry.status)) {
        throw invalid(`${field} dependency plan is invalid`);
      }
      return Object.freeze({ status: entry.status, ids: ids(entry.ids, `${field}Id`) });
    };
    return Object.freeze({
      mailboxes: bucket(additional.mailboxes, 'mailbox'),
      backups: bucket(additional.backups, 'backup'),
      crons: bucket(additional.crons, 'cron'),
      dockerWorkloads: bucket(additional.dockerWorkloads, 'docker'),
    });
  };
  let authoritativeDns = null;
  if (value.authoritativeDns !== null && value.authoritativeDns !== undefined) {
    const dnsFields = new Set(['state', 'previewDigest', 'zoneSnapshotDigest', 'blockers']);
    const dns = value.authoritativeDns;
    if (!dns || typeof dns !== 'object' || Array.isArray(dns)
      || Object.keys(dns).length !== dnsFields.size
      || Object.keys(dns).some((field) => !dnsFields.has(field))
      || !['ready', 'blocked', 'not_applicable'].includes(dns.state)
      || !Array.isArray(dns.blockers) || dns.blockers.length > 32
      || dns.blockers.some((code) => typeof code !== 'string' || !SAFE_CODE.test(code))) {
      throw invalid('Authoritative DNS removal plan is invalid');
    }
    const blockers = [...dns.blockers].sort();
    if (new Set(blockers).size !== blockers.length) {
      throw invalid('Authoritative DNS removal plan has duplicate blockers');
    }
    authoritativeDns = Object.freeze({
      state: dns.state,
      previewDigest: safeDigest(dns.previewDigest, 'authoritativeDnsPreviewDigest'),
      zoneSnapshotDigest: dns.zoneSnapshotDigest === null
        ? null
        : safeDigest(dns.zoneSnapshotDigest, 'authoritativeDnsZoneSnapshotDigest'),
      blockers: Object.freeze(blockers),
    });
  }
  return Object.freeze({
    childDomainIds: ids(value.childDomainIds, 'childDomainId', { preserveOrder: true }),
    websiteId: optionalId(value.websiteId, 'websiteId'),
    applicationId: optionalId(value.applicationId, 'applicationId'),
    managedComposeProjectId: optionalId(value.managedComposeProjectId, 'managedComposeProjectId'),
    certificateIds: ids(value.certificateIds, 'certificateId'),
    dnsZoneIds: ids(value.dnsZoneIds, 'dnsZoneId'),
    mailDomainIds: ids(value.mailDomainIds, 'mailDomainId'),
    activeJobIds: ids(value.activeJobIds, 'activeJobId'),
    additional: normalizedAdditional(value.additional),
    authoritativeDns,
  });
}
function buildSteps(preview, createdAt) {
  const plan = normalizedPlan(preview.plan);
  const steps = [];
  const add = (kind, resourceId) => {
    steps.push(persistedStep({
      id: `${String(steps.length + 1).padStart(3, '0')}:${kind}:${resourceId}`,
      kind,
      resourceId,
      status: 'pending',
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
    }));
  };
  add('routing_suspend', preview.domain.id);
  for (const id of plan.childDomainIds) add('child_domain', id);
  for (const id of plan.certificateIds) add('certificate', id);
  for (const id of plan.mailDomainIds) add('mail_domain', id);
  for (const id of plan.dnsZoneIds) add('external_dns_zone', id);
  if (plan.websiteId !== null) add('website_binding', plan.websiteId);
  if (plan.authoritativeDns?.zoneSnapshotDigest !== null) add('authoritative_dns', preview.domain.id);
  add('metadata_finalization', preview.domain.id);
  return Object.freeze({ plan, steps: Object.freeze(steps) });
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'domainId', 'serverId', 'primaryDomain', 'domainRevision', 'checksum',
    'sourceSuspensionOperationId', 'impactPreviewDigest', 'impactConfirmation',
    'previewDigest', 'startConfirmation', 'plan', 'status', 'steps', 'error',
    'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !OPERATION_STATUSES.has(value.status)
    || typeof value.primaryDomain !== 'string' || value.primaryDomain.length < 1
    || value.primaryDomain.length > 253 || /[\u0000-\u001f\u007f]/.test(value.primaryDomain)
    || !Number.isSafeInteger(value.domainRevision) || value.domainRevision < 1
    || (value.sourceSuspensionOperationId !== null
      && (typeof value.sourceSuspensionOperationId !== 'string'
        || !SAFE_ID.test(value.sourceSuspensionOperationId)))
    || typeof value.impactConfirmation !== 'string' || value.impactConfirmation.length < 1
    || value.impactConfirmation.length > 1000
    || typeof value.startConfirmation !== 'string' || value.startConfirmation.length < 1
    || value.startConfirmation.length > 1000
    || !Array.isArray(value.steps) || value.steps.length < 2 || value.steps.length > 2000) {
    throw invalid('Domain removal operation state is invalid');
  }
  const operation = Object.freeze({
    id: safeId(value.id, 'operationId'),
    domainId: safeId(value.domainId, 'domainId'),
    serverId: safeId(value.serverId, 'serverId'),
    primaryDomain: value.primaryDomain,
    domainRevision: value.domainRevision,
    checksum: safeDigest(value.checksum, 'checksum'),
    sourceSuspensionOperationId: value.sourceSuspensionOperationId,
    impactPreviewDigest: safeDigest(value.impactPreviewDigest, 'impactPreviewDigest'),
    impactConfirmation: value.impactConfirmation,
    previewDigest: safeDigest(value.previewDigest, 'previewDigest'),
    startConfirmation: value.startConfirmation,
    plan: normalizedPlan(value.plan),
    status: value.status,
    steps: Object.freeze(value.steps.map(persistedStep)),
    error: safeError(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (new Set(operation.steps.map((step) => step.id)).size !== operation.steps.length) {
    throw invalid('Domain removal step IDs are not unique');
  }
  const unfinished = operation.steps.filter((step) => step.status !== 'succeeded');
  if (operation.status === 'removed' && unfinished.length > 0) {
    throw invalid('Removed Domain operation has unfinished steps');
  }
  if (operation.status === 'pending'
    && operation.steps.some((step) => step.status !== 'pending')) {
    throw invalid('Pending Domain removal operation contains started steps');
  }
  if ((operation.status === 'failed') !== (operation.error !== null)) {
    throw invalid('Domain removal operation error does not match lifecycle state');
  }
  if (operation.status === 'blocked' && !operation.steps.some((step) => step.status === 'blocked')) {
    throw invalid('Blocked Domain removal operation has no blocked step');
  }
  return operation;
}

function operationFromPreview(preview, now, idFactory) {
  if (!preview || preview.version !== 1 || preview.operation !== 'domain_remove'
    || preview.readyToStart !== true || !Array.isArray(preview.hardBlockers)
    || preview.hardBlockers.length !== 0
    || !preview.domain || typeof preview.domain !== 'object' || Array.isArray(preview.domain)
    || typeof preview.domain.primaryDomain !== 'string'
    || !Number.isSafeInteger(preview.domain.desiredRevision) || preview.domain.desiredRevision < 1
    || typeof preview.confirmation !== 'string' || !preview.confirmation) {
    throw new DomainRemovalOperationRegistryError(
      'domain_removal_operation_preview_invalid',
      'Domain removal preview cannot be journaled',
      409,
    );
  }
  const createdAtMs = now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new DomainRemovalOperationRegistryError(
      'domain_removal_operation_clock_invalid',
      'Domain removal operation registry clock is invalid',
      503,
    );
  }
  const createdAt = new Date(createdAtMs).toISOString();
  const { plan, steps } = buildSteps(preview, createdAt);
  return persistedOperation({
    id: idFactory(),
    domainId: preview.domain.id,
    serverId: preview.domain.serverId,
    primaryDomain: preview.domain.primaryDomain,
    domainRevision: preview.domain.desiredRevision,
    checksum: preview.domain.checksum,
    sourceSuspensionOperationId: preview.domain.suspensionOperationId ?? null,
    impactPreviewDigest: preview.impact.previewDigest,
    impactConfirmation: preview.impact.confirmation,
    previewDigest: preview.previewDigest,
    startConfirmation: preview.confirmation,
    plan,
    status: 'pending',
    steps,
    error: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function domainRemovalOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    domainId: operation.domainId,
    serverId: operation.serverId,
    primaryDomain: operation.primaryDomain,
    domainRevision: operation.domainRevision,
    checksum: operation.checksum,
    sourceSuspensionOperationId: operation.sourceSuspensionOperationId,
    impactPreviewDigest: operation.impactPreviewDigest,
    previewDigest: operation.previewDigest,
    status: operation.status,
    plan: operation.plan,
    steps: operation.steps,
    error: operation.error,
    recovery: Object.freeze({
      required: operation.steps.some((step) => step.status === 'running'),
      automaticMutationReplayBlocked: operation.steps.some((step) => step.status === 'running'),
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createDomainRemovalOperationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new DomainRemovalOperationRegistryError(
      'domain_removal_operation_dependencies_invalid',
      'Domain removal operation registry dependencies are invalid',
      503,
    );
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = filePath === null;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const content = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    });
    await writeChain;
  }

  async function init() {
    if (initialized) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)
        || Object.keys(parsed).length !== 2
        || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
        throw invalid('Domain removal operation store is invalid');
      }
      const operations = parsed.operations.map(persistedOperation);
      if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
        throw invalid('Domain removal operation IDs are not unique');
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

  async function create(preview) {
    await ensureInitialized();
    const duplicate = state.operations.find((operation) => (
      operation.domainId === preview?.domain?.id
      && operation.domainRevision === preview?.domain?.desiredRevision
      && operation.previewDigest === preview?.previewDigest
      && operation.status !== 'removed'
    ));
    if (duplicate) return duplicate;
    const operation = operationFromPreview(preview, now, idFactory);
    state.operations.push(operation);
    await persist();
    return operation;
  }

  async function get(operationId) {
    await ensureInitialized();
    const id = safeId(operationId, 'operationId');
    return state.operations.find((operation) => operation.id === id) ?? null;
  }

  async function listForDomain(domainId) {
    await ensureInitialized();
    const id = safeId(domainId, 'domainId');
    return Object.freeze(state.operations
      .filter((operation) => operation.domainId === id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  async function listInterrupted() {
    await ensureInitialized();
    return Object.freeze(state.operations.filter((operation) => (
      operation.steps.some((step) => step.status === 'running')
    )));
  }

  async function mutate(operation, update) {
    const index = state.operations.findIndex((candidate) => candidate.id === operation.id);
    if (index < 0) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    const currentMs = now();
    if (!Number.isSafeInteger(currentMs) || currentMs < 0) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_clock_invalid',
        'Domain removal operation registry clock is invalid',
        503,
      );
    }
    const updatedAt = new Date(Math.max(currentMs, Date.parse(operation.updatedAt) + 1)).toISOString();
    const next = persistedOperation({ ...operation, ...update, updatedAt });
    state.operations[index] = next;
    await persist();
    return next;
  }

  function requireOperation(operation) {
    if (!operation) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    return operation;
  }

  function firstIncomplete(operation) {
    return operation.steps.find((step) => step.status !== 'succeeded') ?? null;
  }

  async function markStepRunning(operationId, stepId) {
    const operation = requireOperation(await get(operationId));
    if (operation.status === 'removed') {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_not_runnable',
        'Domain removal operation cannot run from its current state',
        409,
      );
    }
    const expected = firstIncomplete(operation);
    if (!expected || expected.id !== stepId) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_out_of_order',
        'Domain removal steps must execute in journaled order',
        409,
      );
    }
    if (expected.status === 'running') return operation;
    if (!['pending', 'blocked', 'failed'].includes(expected.status)) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_runnable',
        'Domain removal step cannot run from its current state',
        409,
      );
    }
    const changedAt = new Date(Math.max(now(), Date.parse(expected.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((step) => step.id === stepId
      ? persistedStep({ ...step, status: 'running', result: null, error: null, updatedAt: changedAt })
      : step);
    return mutate(operation, { status: 'running', steps, error: null });
  }

  async function succeedStep(operationId, stepId, result = {}) {
    const operation = requireOperation(await get(operationId));
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_found',
        'Domain removal step was not found',
        404,
      );
    }
    const normalizedResult = stepResult({
      referenceId: result.referenceId ?? null,
      evidenceDigest: result.evidenceDigest ?? null,
    });
    if (step.status === 'succeeded') {
      if (JSON.stringify(step.result) !== JSON.stringify(normalizedResult)) {
        throw new DomainRemovalOperationRegistryError(
          'domain_removal_step_result_conflict',
          'Domain removal step already completed with different evidence',
          409,
        );
      }
      return operation;
    }
    if (step.status !== 'running') {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_running',
        'Domain removal step is not running',
        409,
      );
    }
    const changedAt = new Date(Math.max(now(), Date.parse(step.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((candidate) => candidate.id === stepId
      ? persistedStep({
        ...candidate,
        status: 'succeeded',
        result: normalizedResult,
        error: null,
        updatedAt: changedAt,
      })
      : candidate);
    const removed = steps.every((candidate) => candidate.status === 'succeeded');
    return mutate(operation, {
      status: removed ? 'removed' : 'running',
      steps,
      error: null,
    });
  }

  async function blockStep(operationId, stepId, error) {
    const operation = requireOperation(await get(operationId));
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_found',
        'Domain removal step was not found',
        404,
      );
    }
    if (!['pending', 'running', 'blocked'].includes(step.status)) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_blockable',
        'Domain removal step cannot be blocked from its current state',
        409,
      );
    }
    const changedAt = new Date(Math.max(now(), Date.parse(step.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((candidate) => candidate.id === stepId
      ? persistedStep({
        ...candidate,
        status: 'blocked',
        result: null,
        error: safeError(error),
        updatedAt: changedAt,
      })
      : candidate);
    return mutate(operation, { status: 'blocked', steps, error: null });
  }

  async function failStep(operationId, stepId, error) {
    const operation = requireOperation(await get(operationId));
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_found',
        'Domain removal step was not found',
        404,
      );
    }
    if (!['pending', 'running', 'blocked', 'failed'].includes(step.status)) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_mutable',
        'Domain removal step cannot fail from its current state',
        409,
      );
    }
    const failure = safeError(error);
    const changedAt = new Date(Math.max(now(), Date.parse(step.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((candidate) => candidate.id === stepId
      ? persistedStep({
        ...candidate,
        status: 'failed',
        result: null,
        error: failure,
        updatedAt: changedAt,
      })
      : candidate);
    return mutate(operation, { status: 'failed', steps, error: failure });
  }

  return Object.freeze({
    init,
    create,
    get,
    listForDomain,
    listInterrupted,
    markStepRunning,
    succeedStep,
    blockStep,
    failStep,
  });
}

export const domainRemovalOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  operationStatuses: Object.freeze([...OPERATION_STATUSES]),
  stepStatuses: Object.freeze([...STEP_STATUSES]),
  stepKinds: Object.freeze([...STEP_KINDS]),
  safeError,
  stepResult,
  persistedStep,
  normalizedPlan,
  buildSteps,
  persistedOperation,
  operationFromPreview,
});
