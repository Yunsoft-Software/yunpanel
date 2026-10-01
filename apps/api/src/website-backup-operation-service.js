import {
  WebsiteBackupOperationRegistryError,
  websiteBackupOperationPublicView,
} from './website-backup-operation-registry.js';
import { WebsiteBackupError } from './website-backup-service.js';
import { WebsiteRestoreError } from './website-restore-service.js';

export class WebsiteBackupOperationServiceError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'WebsiteBackupOperationServiceError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function isWebsiteBackupOperationError(error) {
  return error instanceof WebsiteBackupOperationServiceError
    || error instanceof WebsiteBackupOperationRegistryError
    || error instanceof WebsiteBackupError
    || error instanceof WebsiteRestoreError;
}

export function createWebsiteBackupOperationService({
  registry,
  websiteBackupService = null,
  websiteRestoreService = null,
  websiteRegistry = null,
  resticRepositoryRegistry = null,
  resticManager = null,
  receiptStore = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!registry || typeof registry.createOperation !== 'function'
    || typeof registry.getOperation !== 'function'
    || typeof registry.listOperations !== 'function'
    || typeof registry.updateOperation !== 'function') {
    throw new WebsiteBackupOperationServiceError(
      'website_backup_dependencies_invalid',
      'Website backup operation registry is required',
      503,
    );
  }

  async function queueBackup({
    websiteId,
    repositoryId,
    expectedPreviewDigest = null,
    confirmation = null,
    tags = [],
    actor = null,
  } = {}) {
    if (!websiteBackupService || typeof websiteBackupService.previewBackup !== 'function'
      || typeof websiteBackupService.executeBackup !== 'function') {
      throw new WebsiteBackupOperationServiceError(
        'website_backup_runtime_unavailable',
        'Website backup runtime service is unavailable',
        503,
      );
    }

    if (!expectedPreviewDigest || typeof expectedPreviewDigest !== 'string') {
      throw new WebsiteBackupOperationServiceError(
        'backup_preview_digest_required',
        'expectedPreviewDigest is required to execute a durable backup',
        400,
      );
    }
    if (!confirmation || typeof confirmation !== 'string') {
      throw new WebsiteBackupOperationServiceError(
        'backup_confirmation_required',
        'confirmation string is required to execute a durable backup',
        400,
      );
    }

    // Exact preview validation
    const preview = await websiteBackupService.previewBackup({ websiteId, repositoryId });

    if (expectedPreviewDigest !== preview.backupSetDigest) {
      throw new WebsiteBackupOperationServiceError(
        'backup_preview_stale',
        'Website configuration changed after preview was generated; refresh preview',
        409,
      );
    }

    if (confirmation !== preview.confirmation) {
      throw new WebsiteBackupOperationServiceError(
        'backup_confirmation_invalid',
        `Typed confirmation does not match: expected '${preview.confirmation}'`,
        409,
      );
    }

    // Enqueue operation
    const operation = await registry.createOperation({
      websiteId,
      repositoryId,
      kind: 'backup',
      previewDigest: preview.backupSetDigest,
      confirmation,
      tags,
    });

    // Dispatch background execution
    setImmediate(async () => {
      const startTime = now();
      try {
        await registry.updateOperation(operation.id, {
          status: 'running',
          startedAt: startTime,
          progress: { phase: 'running', percent: 25, message: 'Yedekleme başlatıldı' },
          steps: [
            { name: 'prepare', status: 'running', updatedAt: startTime },
            { name: 'snapshot', status: 'pending', updatedAt: startTime },
            { name: 'cleanup', status: 'pending', updatedAt: startTime },
          ],
        });

        const executionResult = await websiteBackupService.executeBackup({
          websiteId,
          repositoryId,
          expectedPreviewDigest: preview.backupSetDigest,
          confirmation: preview.confirmation,
          tags,
        });

        const finishTime = now();
        await registry.updateOperation(operation.id, {
          status: 'succeeded',
          snapshotId: executionResult.snapshot?.snapshotId ?? null,
          result: {
            status: 'succeeded',
            websiteId,
            repositoryId,
            snapshot: executionResult.snapshot,
            backupSetDigest: executionResult.backupSetDigest,
            createdAt: executionResult.createdAt ?? finishTime,
          },
          progress: { phase: 'succeeded', percent: 100, message: 'Yedekleme başarıyla tamamlandı' },
          steps: [
            { name: 'prepare', status: 'succeeded', updatedAt: finishTime },
            { name: 'snapshot', status: 'succeeded', snapshotId: executionResult.snapshot?.snapshotId, updatedAt: finishTime },
            { name: 'cleanup', status: 'succeeded', updatedAt: finishTime },
          ],
          finishedAt: finishTime,
        });
      } catch (error) {
        const errorTime = now();
        await registry.updateOperation(operation.id, {
          status: 'failed',
          error: {
            code: error.code || 'backup_execution_failed',
            message: error.message || 'Backup execution failed',
          },
          progress: { phase: 'failed', percent: 100, message: `Yedekleme başarısız: ${error.message}` },
          finishedAt: errorTime,
        }).catch(() => {});
      }
    });

    return operation;
  }

  async function queueRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest = null,
    confirmation = null,
    healthPath = '/health',
    timeoutSeconds = 30,
    actor = null,
  } = {}) {
    if (!websiteRestoreService || typeof websiteRestoreService.previewRestore !== 'function'
      || typeof websiteRestoreService.executeRestore !== 'function') {
      throw new WebsiteBackupOperationServiceError(
        'website_restore_runtime_unavailable',
        'Website restore runtime service is unavailable',
        503,
      );
    }

    if (!expectedPreviewDigest || typeof expectedPreviewDigest !== 'string') {
      throw new WebsiteBackupOperationServiceError(
        'restore_preview_digest_required',
        'expectedPreviewDigest is required to execute a durable restore',
        400,
      );
    }
    if (!confirmation || typeof confirmation !== 'string') {
      throw new WebsiteBackupOperationServiceError(
        'restore_confirmation_required',
        'confirmation string is required to execute a durable restore',
        400,
      );
    }

    // Exact preview validation
    const preview = await websiteRestoreService.previewRestore({
      websiteId,
      repositoryId,
      snapshotId,
      healthPath,
      timeoutSeconds,
    });

    if (expectedPreviewDigest !== preview.previewDigest) {
      throw new WebsiteBackupOperationServiceError(
        'restore_preview_stale',
        'Website or snapshot state changed; request a new preview',
        409,
      );
    }

    if (confirmation !== preview.confirmation) {
      throw new WebsiteBackupOperationServiceError(
        'restore_confirmation_invalid',
        `Typed confirmation does not match: expected '${preview.confirmation}'`,
        409,
      );
    }

    // Enqueue operation
    const operation = await registry.createOperation({
      websiteId,
      repositoryId,
      kind: 'restore',
      snapshotId: preview.snapshotId,
      previewDigest: preview.previewDigest,
      confirmation,
      healthPath: preview.healthSpec?.healthPath ?? healthPath,
      timeoutSeconds: preview.healthSpec?.timeoutSeconds ?? timeoutSeconds,
    });

    // Dispatch background execution
    setImmediate(async () => {
      const startTime = now();
      try {
        await registry.updateOperation(operation.id, {
          status: 'running',
          startedAt: startTime,
          progress: { phase: 'running', percent: 20, message: 'Geri yükleme öncesi anlık görüntü alınıyor' },
          steps: [
            { name: 'pre_restore', status: 'running', updatedAt: startTime },
            { name: 'restore', status: 'pending', updatedAt: startTime },
            { name: 'health_check', status: 'pending', updatedAt: startTime },
          ],
        });

        const executionResult = await websiteRestoreService.executeRestore({
          websiteId,
          repositoryId,
          snapshotId: preview.snapshotId,
          expectedPreviewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
          healthPath: preview.healthSpec?.healthPath,
          timeoutSeconds: preview.healthSpec?.timeoutSeconds,
        });

        const finishTime = now();

        if (executionResult.status === 'succeeded') {
          await registry.updateOperation(operation.id, {
            status: 'succeeded',
            preRestoreSnapshotId: executionResult.preRestoreSnapshotId ?? null,
            result: {
              status: 'succeeded',
              websiteId,
              snapshotId: executionResult.snapshotId,
              preRestoreSnapshotId: executionResult.preRestoreSnapshotId,
              healthCheck: executionResult.healthCheck,
              restoredAt: executionResult.restoredAt ?? finishTime,
            },
            progress: { phase: 'succeeded', percent: 100, message: 'Geri yükleme ve sağlık kontrolü başarıyla tamamlandı' },
            steps: [
              { name: 'pre_restore', status: 'succeeded', snapshotId: executionResult.preRestoreSnapshotId, updatedAt: finishTime },
              { name: 'restore', status: 'succeeded', updatedAt: finishTime },
              { name: 'health_check', status: 'succeeded', healthCheck: executionResult.healthCheck, updatedAt: finishTime },
            ],
            finishedAt: finishTime,
          });
        } else if (executionResult.status === 'rolled_back') {
          await registry.updateOperation(operation.id, {
            status: 'rolled_back',
            preRestoreSnapshotId: executionResult.preRestoreSnapshotId ?? null,
            result: {
              status: 'rolled_back',
              websiteId,
              snapshotId: executionResult.snapshotId,
              preRestoreSnapshotId: executionResult.preRestoreSnapshotId,
              rollbackReason: executionResult.rollbackReason ?? 'health_check_failed',
              healthCheck: executionResult.healthCheck,
              rolledBackAt: executionResult.rolledBackAt ?? finishTime,
            },
            progress: { phase: 'rolled_back', percent: 100, message: 'Sağlık kontrolü başarısız; geri alma (rollback) uygulandı' },
            steps: [
              { name: 'pre_restore', status: 'succeeded', snapshotId: executionResult.preRestoreSnapshotId, updatedAt: finishTime },
              { name: 'restore', status: 'succeeded', updatedAt: finishTime },
              { name: 'health_check', status: 'rolled_back', healthCheck: executionResult.healthCheck, updatedAt: finishTime },
            ],
            finishedAt: finishTime,
          });
        }
      } catch (error) {
        const errorTime = now();
        await registry.updateOperation(operation.id, {
          status: 'failed',
          error: {
            code: error.code || 'restore_execution_failed',
            message: error.message || 'Restore execution failed',
          },
          progress: { phase: 'failed', percent: 100, message: `Geri yükleme başarısız: ${error.message}` },
          finishedAt: errorTime,
        }).catch(() => {});
      }
    });

    return operation;
  }

  async function getOperation(operationId) {
    const op = await registry.getOperation(operationId);
    if (!op) {
      throw new WebsiteBackupOperationServiceError(
        'website_backup_operation_not_found',
        'Website backup operation was not found',
        404,
      );
    }
    return op;
  }

  async function listOperations(filter = {}) {
    return registry.listOperations(filter);
  }

  async function reconcile() {
    return registry.reconcileInterruptedOperations({
      resticManager,
      resticRepositoryRegistry,
      receiptStore,
      websiteRegistry,
    });
  }

  return Object.freeze({
    queueBackup,
    queueRestore,
    getOperation,
    listOperations,
    reconcile,
    registry,
  });
}
