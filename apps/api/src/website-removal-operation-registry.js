import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION_STATUSES = new Set(['pending', 'running', 'blocked', 'failed', 'removed']);
const STEP_STATUSES = new Set(['pending', 'running', 'succeeded', 'blocked', 'failed']);
const STEP_KINDS = new Set([
  'domain_removal',
  'cron_cleanup',
  'sftp_key_cleanup',
  'database_binding_cleanup',
  'runtime_cleanup',
  'file_cleanup',
  'unix_identity_cleanup',
  'metadata_finalization',
  'application_cleanup',
]);

export class WebsiteRemovalOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteRemovalOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new WebsiteRemovalOperationRegistryError(
      'invalid_identifier',
      `${field} must be a safe non-empty identifier`,
      400,
    );
  }
  return value;
}

export function websiteRemovalOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    websiteId: operation.websiteId,
    serverId: operation.serverId,
    applicationId: operation.applicationId,
    applicationRevision: operation.applicationRevision ?? null,
    websiteRevision: operation.websiteRevision,
    status: operation.status,
    previewDigest: operation.previewDigest,
    startConfirmation: operation.startConfirmation,
    plan: operation.plan,
    steps: Object.freeze(operation.steps.map((step) => Object.freeze({
      id: step.id,
      kind: step.kind,
      resourceId: step.resourceId,
      status: step.status,
      result: step.result,
      error: step.error,
      createdAt: step.createdAt,
      updatedAt: step.updatedAt,
    }))),
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createWebsiteRemovalOperationRegistry({
  filePath = null,
  now = () => new Date().toISOString(),
} = {}) {
  let operations = new Map();
  let initialized = false;

  async function persist() {
    if (!filePath) return;
    const data = JSON.stringify(Array.from(operations.values()), null, 2);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data, 'utf8');
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const raw = await readFile(filePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          operations = new Map(list.map((op) => [op.id, op]));
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    initialized = true;
  }

  function requireInit() {
    if (!initialized) {
      throw new WebsiteRemovalOperationRegistryError(
        'website_removal_registry_uninitialized',
        'Website removal registry must be initialized',
        500,
      );
    }
  }

  function createSteps(preview, createdAt) {
    const steps = [];
    const add = (kind, resourceId) => {
      steps.push({
        id: `${String(steps.length + 1).padStart(3, '0')}:${kind}:${resourceId}`,
        kind,
        resourceId,
        status: 'pending',
        result: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      });
    };

    // 1. Reverse-order step 1: Connected Domain removals
    for (const domainId of preview.plan.domainIds) {
      add('domain_removal', domainId);
    }

    // 2. Cron cleanup
    if (preview.plan.additional.crons?.ids?.length > 0) {
      add('cron_cleanup', preview.website.id);
    }

    // 3. SFTP key cleanup
    if (preview.plan.additional.sftpKeys?.ids?.length > 0) {
      add('sftp_key_cleanup', preview.website.id);
    }

    // 4. Database binding cleanup
    if (preview.plan.additional.databases?.ids?.length > 0) {
      add('database_binding_cleanup', preview.website.id);
    }

    // 5. Runtime binding cleanup
    if (preview.plan.additional.runtimeBindings?.ids?.length > 0) {
      add('runtime_cleanup', preview.website.applicationId ?? preview.website.id);
    }

    // 6. File cleanup (data, apps directory)
    add('file_cleanup', preview.website.applicationId ?? preview.website.id);

    // 7. Unix identity cleanup
    if (preview.website.systemUser) {
      add('unix_identity_cleanup', preview.website.systemUser);
    }

    // 8. Website metadata removal. This must happen before Application metadata:
    // a crash after Application deletion would otherwise leave a persisted Website
    // referencing a missing Application and could block registry startup.
    add('metadata_finalization', preview.website.id);

    // 9. Application environment/secrets and metadata cleanup after Website is absent.
    if (preview.website.applicationId) {
      add('application_cleanup', preview.website.applicationId);
    }

    return steps;
  }

  async function create(preview) {
    requireInit();
    if (!preview || preview.operation !== 'website_remove' || !preview.readyToStart) {
      throw new WebsiteRemovalOperationRegistryError(
        'website_removal_operation_not_ready',
        'Website removal preview is not ready to start',
        409,
      );
    }

    // Check if an active operation already exists for this website
    for (const existing of operations.values()) {
      if (existing.websiteId === preview.website.id && existing.status !== 'removed' && existing.status !== 'failed') {
        throw new WebsiteRemovalOperationRegistryError(
          'website_removal_operation_in_progress',
          'A removal operation is already in progress for this Website',
          409,
        );
      }
    }

    const timestamp = now();
    const id = `ws-rem-${randomUUID()}`;
    const steps = createSteps(preview, timestamp);

    const operation = {
      id,
      websiteId: preview.website.id,
      serverId: preview.website.serverId,
      applicationId: preview.website.applicationId,
      applicationRevision: preview.plan.applicationRevision ?? null,
      websiteRevision: preview.website.desiredRevision,
      status: 'pending',
      previewDigest: preview.previewDigest,
      startConfirmation: preview.confirmation,
      plan: preview.plan,
      steps,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    operations.set(id, operation);
    await persist();
    return websiteRemovalOperationPublicView(operation);
  }

  async function get(operationId) {
    requireInit();
    safeId(operationId, 'operationId');
    const op = operations.get(operationId);
    if (!op) return null;
    return websiteRemovalOperationPublicView(op);
  }

  async function list() {
    requireInit();
    return Array.from(operations.values()).map(websiteRemovalOperationPublicView);
  }

  async function listForWebsite(websiteId) {
    requireInit();
    safeId(websiteId, 'websiteId');
    return Array.from(operations.values())
      .filter((op) => op.websiteId === websiteId)
      .map(websiteRemovalOperationPublicView);
  }

  async function updateStep(operationId, stepId, updater) {
    requireInit();
    safeId(operationId, 'operationId');
    safeId(stepId, 'stepId');
    const op = operations.get(operationId);
    if (!op) {
      throw new WebsiteRemovalOperationRegistryError('operation_not_found', 'Operation not found', 404);
    }
    const step = op.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new WebsiteRemovalOperationRegistryError('step_not_found', 'Step not found', 404);
    }

    updater(op, step);
    op.updatedAt = now();
    step.updatedAt = op.updatedAt;

    // Determine overall operation status
    if (op.steps.some((s) => s.status === 'failed')) {
      op.status = 'failed';
    } else if (op.steps.some((s) => s.status === 'blocked')) {
      op.status = 'blocked';
    } else if (op.steps.every((s) => s.status === 'succeeded')) {
      op.status = 'removed';
    } else if (op.steps.some((s) => s.status === 'running')) {
      op.status = 'running';
    }

    await persist();
    return websiteRemovalOperationPublicView(op);
  }

  async function markStepRunning(operationId, stepId) {
    return updateStep(operationId, stepId, (op, step) => {
      if (step.status === 'succeeded') {
        throw new WebsiteRemovalOperationRegistryError('step_already_succeeded', 'Step has already succeeded', 409);
      }
      step.status = 'running';
      op.status = 'running';
    });
  }

  async function succeedStep(operationId, stepId, result = {}) {
    return updateStep(operationId, stepId, (op, step) => {
      step.status = 'succeeded';
      step.result = result;
      step.error = null;
    });
  }

  async function blockStep(operationId, stepId, error) {
    return updateStep(operationId, stepId, (op, step) => {
      step.status = 'blocked';
      step.error = error;
      op.status = 'blocked';
      op.error = error;
    });
  }

  async function failStep(operationId, stepId, error) {
    return updateStep(operationId, stepId, (op, step) => {
      step.status = 'failed';
      step.error = error;
      op.status = 'failed';
      op.error = error;
    });
  }

  return Object.freeze({
    init,
    create,
    get,
    list,
    listForWebsite,
    markStepRunning,
    succeedStep,
    blockStep,
    failStep,
  });
}
