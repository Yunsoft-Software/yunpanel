import { BackupExecutionOrchestratorError } from './backup-execution-orchestrator.js';
import { BackupExecutionPlanError } from './backup-execution-plan.js';
import { BackupOperationRegistryError } from './backup-operation-registry.js';
import { BackupPlanError } from './backup-plan.js';
import { BackupResourceProviderError } from './backup-resource-provider.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const PREVIEW_BODY_KEYS = new Set(['serverId', 'selectedResourceIdentities']);
const EXECUTION_BODY_KEYS = new Set([
  'serverId',
  'selectedResourceIdentities',
  'expectedPreviewDigest',
  'confirmation',
]);
const MAX_RESOURCES = 8192;

export class BackupHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupHttpError';
    this.code = code;
    this.status = status;
  }
}

function selectedResourceIdentities(value, { optional = true } = {}) {
  if ((value === undefined && optional) || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_RESOURCES
    || value.some((identity) => typeof identity !== 'string' || !RESOURCE_ID_PATTERN.test(identity))
    || new Set(value).size !== value.length) {
    throw new BackupHttpError(
      'backup_resource_selection_invalid',
      'selectedResourceIdentities must contain unique backup resource identities',
    );
  }
  return Object.freeze([...value]);
}

function previewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length < 1 || Object.keys(body).length > PREVIEW_BODY_KEYS.size
    || Object.keys(body).some((key) => !PREVIEW_BODY_KEYS.has(key))
    || typeof body.serverId !== 'string' || !UUID_PATTERN.test(body.serverId)) {
    throw new BackupHttpError(
      'backup_preview_input_invalid',
      'Backup preview requires serverId and optionally selectedResourceIdentities',
    );
  }
  return Object.freeze({
    serverId: body.serverId.toLowerCase(),
    selectedResourceIdentities: selectedResourceIdentities(body.selectedResourceIdentities),
  });
}

function executionBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length < 3 || Object.keys(body).length > EXECUTION_BODY_KEYS.size
    || Object.keys(body).some((key) => !EXECUTION_BODY_KEYS.has(key))
    || typeof body.serverId !== 'string' || !UUID_PATTERN.test(body.serverId)
    || typeof body.expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(body.expectedPreviewDigest)
    || typeof body.confirmation !== 'string' || body.confirmation.length > 256) {
    throw new BackupHttpError(
      'backup_execution_input_invalid',
      'Backup execution requires serverId, expectedPreviewDigest and typed confirmation',
    );
  }
  const serverId = body.serverId.toLowerCase();
  if (body.confirmation !== `backup:${serverId}:${body.expectedPreviewDigest}`) {
    throw new BackupHttpError('backup_execution_confirmation_invalid', 'Backup confirmation is invalid', 409);
  }
  return Object.freeze({
    serverId,
    selectedResourceIdentities: selectedResourceIdentities(body.selectedResourceIdentities),
    expectedPreviewDigest: body.expectedPreviewDigest,
    confirmation: body.confirmation,
  });
}

function operationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BackupHttpError('backup_operation_id_invalid', 'Backup operation id is invalid');
  }
  return value.toLowerCase();
}

function progress(steps) {
  const counts = { total: steps.length, pending: 0, dispatched: 0, succeeded: 0, failed: 0 };
  for (const step of steps) counts[step.status] += 1;
  return Object.freeze(counts);
}

function operationView(operation) {
  if (!operation || !operation.plan || !Array.isArray(operation.plan.steps) || !Array.isArray(operation.steps)
    || operation.plan.steps.length !== operation.steps.length) {
    throw new BackupHttpError('backup_operation_state_unavailable', 'Backup operation state is unavailable', 503);
  }
  const steps = operation.steps.map((state, index) => {
    const planned = operation.plan.steps[index];
    return Object.freeze({
      resourceIdentity: planned.resourceIdentity,
      resourceType: planned.resourceType,
      status: state.status,
      evidence: state.evidence ? Object.freeze({ ...state.evidence }) : null,
      error: state.error ? Object.freeze({ ...state.error }) : null,
      updatedAt: state.updatedAt,
    });
  });
  return Object.freeze({
    id: operation.id,
    serverId: operation.serverId,
    previewDigest: operation.previewDigest,
    status: operation.status,
    progress: progress(steps),
    steps: Object.freeze(steps),
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    error: operation.error ? Object.freeze({ ...operation.error }) : null,
  });
}

function childJobView(job) {
  if (!job) return null;
  return Object.freeze({
    id: job.id,
    status: job.status,
    operation: job.operation,
    resourceType: job.resourceType,
    resourceId: job.resourceId,
  });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function requireBackupOwner(request, response, next) {
  return requirePanelRouteAccess(request, response, () => {
    if (request.auth?.user?.role !== 'owner') {
      return response.status(403).json({ error: { code: 'forbidden', message: 'Owner access is required.' } });
    }
    return next();
  });
}

export function mountBackupRoutes(app, {
  backupResourceProvider = null,
  backupResourceProviderForRequest = null,
  backupOperationRegistry = null,
  backupOrchestratorForRequest = null,
} = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');
  const staticProviderValid = backupResourceProvider && typeof backupResourceProvider.preview === 'function';
  if (!staticProviderValid && typeof backupResourceProviderForRequest !== 'function') {
    throw new Error('Backup resource provider is required');
  }

  async function providerFor(request) {
    const provider = staticProviderValid
      ? backupResourceProvider
      : await backupResourceProviderForRequest(request);
    if (!provider || typeof provider.preview !== 'function') {
      throw new BackupHttpError('backup_preview_unavailable', 'Backup preview provider is unavailable', 503);
    }
    return provider;
  }

  app.post('/api/backups/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = previewBody(request.body);
    const preview = await (await providerFor(request)).preview(input);
    return response.json({ data: preview });
  }));

  const executionEnabled = backupOperationRegistry
    && typeof backupOperationRegistry.getOperation === 'function'
    && typeof backupOperationRegistry.listOperations === 'function'
    && typeof backupOrchestratorForRequest === 'function';
  if (!executionEnabled) return;

  async function orchestratorFor(request) {
    const orchestrator = await backupOrchestratorForRequest(request, await providerFor(request));
    if (!orchestrator || typeof orchestrator.create !== 'function' || typeof orchestrator.advance !== 'function') {
      throw new BackupHttpError('backup_execution_unavailable', 'Backup execution runtime is unavailable', 503);
    }
    return orchestrator;
  }

  app.post('/api/backups', requireBackupOwner, asyncRoute(async (request, response) => {
    const input = executionBody(request.body);
    const orchestrator = await orchestratorFor(request);
    const created = await orchestrator.create(input);
    const advanced = await orchestrator.advance(created.id);
    return response.status(202).json({
      data: operationView(advanced.operation),
      execution: Object.freeze({
        waiting: advanced.waiting,
        childJob: childJobView(advanced.childJob),
      }),
    });
  }));

  app.post('/api/backups/:operationId/advance', requireBackupOwner, asyncRoute(async (request, response) => {
    const id = operationId(request.params.operationId);
    const advanced = await (await orchestratorFor(request)).advance(id);
    return response.json({
      data: operationView(advanced.operation),
      execution: Object.freeze({
        waiting: advanced.waiting,
        childJob: childJobView(advanced.childJob),
      }),
    });
  }));

  app.get('/api/backups', requireBackupOwner, asyncRoute(async (_request, response) => {
    const operations = await backupOperationRegistry.listOperations();
    return response.json({ data: operations.map(operationView) });
  }));

  app.get('/api/backups/:operationId', requireBackupOwner, asyncRoute(async (request, response, next) => {
    if (!UUID_PATTERN.test(request.params.operationId)) return next('route');
    const operation = await backupOperationRegistry.getOperation(operationId(request.params.operationId));
    if (!operation) throw new BackupHttpError('backup_operation_not_found', 'Backup operation was not found', 404);
    return response.json({ data: operationView(operation) });
  }));
}

export function isBackupHttpError(error) {
  return error instanceof BackupHttpError
    || error instanceof BackupExecutionOrchestratorError
    || error instanceof BackupExecutionPlanError
    || error instanceof BackupOperationRegistryError
    || error instanceof BackupResourceProviderError
    || error instanceof BackupPlanError;
}

export const backupHttpInternals = Object.freeze({
  previewBody,
  executionBody,
  operationId,
  operationView,
  childJobView,
});
