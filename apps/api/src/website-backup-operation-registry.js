import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createProcessStoreLock } from './process-store-lock.js';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'rolled_back']);
const OPERATION_KINDS = new Set(['backup', 'restore']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);

export class WebsiteBackupOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteBackupOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

export function websiteBackupOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    websiteId: operation.websiteId,
    serverId: operation.serverId,
    repositoryId: operation.repositoryId,
    kind: operation.kind,
    snapshotId: operation.snapshotId ?? null,
    preRestoreSnapshotId: operation.preRestoreSnapshotId ?? null,
    previewDigest: operation.previewDigest,
    status: operation.status,
    progress: operation.progress ? Object.freeze({ ...operation.progress }) : null,
    steps: Array.isArray(operation.steps)
      ? Object.freeze(operation.steps.map((step) => Object.freeze({ ...step })))
      : Object.freeze([]),
    result: operation.result ? Object.freeze({ ...operation.result }) : null,
    error: operation.error ? Object.freeze({ code: operation.error.code, message: operation.error.message }) : null,
    restartEvidence: operation.restartEvidence ? Object.freeze({ ...operation.restartEvidence }) : null,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt ?? null,
    finishedAt: operation.finishedAt ?? null,
    updatedAt: operation.updatedAt,
  });
}

function normalizeTimestamp(value, fallback = () => new Date().toISOString()) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback();
}

function defaultStepsForKind(kind, timestamp) {
  if (kind === 'backup') {
    return [
      { name: 'prepare', status: 'pending', updatedAt: timestamp },
      { name: 'snapshot', status: 'pending', updatedAt: timestamp },
      { name: 'cleanup', status: 'pending', updatedAt: timestamp },
    ];
  }
  return [
    { name: 'pre_restore', status: 'pending', updatedAt: timestamp },
    { name: 'restore', status: 'pending', updatedAt: timestamp },
    { name: 'health_check', status: 'pending', updatedAt: timestamp },
  ];
}

export function createWebsiteBackupOperationRegistry({
  filePath = null,
  now = () => new Date().toISOString(),
  storeLockFactory = createProcessStoreLock,
} = {}) {
  let operations = new Map();
  let initialized = false;
  const storeLock = filePath
    ? storeLockFactory({ filePath: path.resolve(filePath) })
    : null;

  async function loadUnlocked() {
    if (!filePath) {
      initialized = true;
      return;
    }
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.operations)) {
        operations = new Map();
        for (const item of parsed.operations) {
          if (item && typeof item.id === 'string' && UUID_PATTERN.test(item.id)) {
            operations.set(item.id.toLowerCase(), item);
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new WebsiteBackupOperationRegistryError(
          'website_backup_operation_store_invalid',
          `Failed to load website backup operation store: ${error.message}`,
          500,
        );
      }
      operations = new Map();
    }
    initialized = true;
  }

  async function saveUnlocked() {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({
      version: 1,
      operations: Array.from(operations.values()),
    }, null, 2);
    await writeFile(tmpPath, payload, { mode: 0o600 });
    await rename(tmpPath, filePath);
  }

  async function withStore(action) {
    if (storeLock) {
      return storeLock.withLock(async () => {
        await loadUnlocked();
        const result = await action();
        await saveUnlocked();
        return result;
      });
    }
    if (!initialized) await loadUnlocked();
    const result = await action();
    await saveUnlocked();
    return result;
  }

  async function createOperation({
    id = null,
    websiteId,
    serverId = null,
    repositoryId,
    kind,
    snapshotId = null,
    preRestoreSnapshotId = null,
    previewDigest,
    confirmation,
    healthPath = '/health',
    timeoutSeconds = 30,
    tags = [],
    steps = null,
  }) {
    if (!websiteId || !UUID_PATTERN.test(websiteId)) {
      throw new WebsiteBackupOperationRegistryError('invalid_website_id', 'websiteId must be a valid UUID', 400);
    }
    if (!repositoryId || !UUID_PATTERN.test(repositoryId)) {
      throw new WebsiteBackupOperationRegistryError('invalid_repository_id', 'repositoryId must be a valid UUID', 400);
    }
    if (!OPERATION_KINDS.has(kind)) {
      throw new WebsiteBackupOperationRegistryError('invalid_operation_kind', `kind must be 'backup' or 'restore'`, 400);
    }
    if (!previewDigest || !SHA256_PATTERN.test(previewDigest)) {
      throw new WebsiteBackupOperationRegistryError('invalid_preview_digest', 'previewDigest must be a 64-character SHA-256 hex string', 400);
    }
    if (!confirmation || typeof confirmation !== 'string') {
      throw new WebsiteBackupOperationRegistryError('invalid_confirmation', 'confirmation string is required', 400);
    }

    const normalizedWebsiteId = websiteId.toLowerCase();
    const normalizedRepoId = repositoryId.toLowerCase();
    const normalizedServerId = serverId ? serverId.toLowerCase() : null;
    const opId = (id && UUID_PATTERN.test(id) ? id : randomUUID()).toLowerCase();
    const currentTime = now();

    return withStore(() => {
      // Assert no other operation is active for this website
      for (const existing of operations.values()) {
        if (existing.websiteId === normalizedWebsiteId && ACTIVE_STATUSES.has(existing.status)) {
          throw new WebsiteBackupOperationRegistryError(
            'website_backup_operation_conflict',
            'Another backup or restore operation is already queued or running for this website',
            409,
          );
        }
      }

      const operationRecord = {
        id: opId,
        websiteId: normalizedWebsiteId,
        serverId: normalizedServerId,
        repositoryId: normalizedRepoId,
        kind,
        snapshotId: snapshotId ? String(snapshotId) : null,
        preRestoreSnapshotId: preRestoreSnapshotId ? String(preRestoreSnapshotId) : null,
        previewDigest,
        confirmation,
        healthPath: typeof healthPath === 'string' ? healthPath : '/health',
        timeoutSeconds: Number.isSafeInteger(timeoutSeconds) ? timeoutSeconds : 30,
        tags: Array.isArray(tags) ? [...tags] : [],
        status: 'queued',
        progress: { phase: 'queued', percent: 0, message: 'İşlem kuyruğa alındı' },
        steps: Array.isArray(steps) && steps.length > 0 ? steps : defaultStepsForKind(kind, currentTime),
        result: null,
        error: null,
        restartEvidence: null,
        createdAt: currentTime,
        startedAt: null,
        finishedAt: null,
        updatedAt: currentTime,
      };

      operations.set(opId, operationRecord);
      return websiteBackupOperationPublicView(operationRecord);
    });
  }

  async function getOperation(id) {
    if (!id || typeof id !== 'string') return null;
    const normalizedId = id.toLowerCase();
    return withStore(() => {
      const op = operations.get(normalizedId);
      return op ? websiteBackupOperationPublicView(op) : null;
    });
  }

  async function listOperations({ websiteId = null, serverId = null, status = null, kind = null } = {}) {
    return withStore(() => {
      let list = Array.from(operations.values());
      if (websiteId) {
        const norm = websiteId.toLowerCase();
        list = list.filter((op) => op.websiteId === norm);
      }
      if (serverId) {
        const norm = serverId.toLowerCase();
        list = list.filter((op) => op.serverId === norm);
      }
      if (status) {
        list = list.filter((op) => op.status === status);
      }
      if (kind) {
        list = list.filter((op) => op.kind === kind);
      }
      list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return list.map(websiteBackupOperationPublicView);
    });
  }

  async function updateOperation(id, patch) {
    if (!id || typeof id !== 'string') {
      throw new WebsiteBackupOperationRegistryError('invalid_operation_id', 'Operation id is invalid', 400);
    }
    const normalizedId = id.toLowerCase();
    return withStore(() => {
      const op = operations.get(normalizedId);
      if (!op) {
        throw new WebsiteBackupOperationRegistryError('website_backup_operation_not_found', 'Operation not found', 404);
      }
      const currentTime = now();
      const updated = {
        ...op,
        ...patch,
        updatedAt: currentTime,
      };
      if (patch.status && OPERATION_STATUSES.has(patch.status)) {
        updated.status = patch.status;
      }
      operations.set(normalizedId, updated);
      return websiteBackupOperationPublicView(updated);
    });
  }

  async function reconcileInterruptedOperations({
    resticManager = null,
    resticRepositoryRegistry = null,
    receiptStore = null,
  } = {}) {
    return withStore(async () => {
      const reconciled = [];
      const currentTime = now();

      for (const [id, op] of operations.entries()) {
        if (!ACTIVE_STATUSES.has(op.status)) continue;

        if (op.kind === 'restore') {
          const transactionId = `restore:${op.websiteId}:${op.previewDigest.slice(0, 32)}`;
          let receipt = null;
          if (receiptStore && typeof receiptStore.read === 'function') {
            try {
              receipt = await receiptStore.read(transactionId);
            } catch {
              // ignore receipt read error
            }
          }

          if (receipt) {
            if (receipt.status === 'succeeded') {
              op.status = 'succeeded';
              op.snapshotId = op.snapshotId ?? receipt.snapshotId;
              op.preRestoreSnapshotId = receipt.preRestoreSnapshotId;
              op.result = {
                status: 'succeeded',
                websiteId: op.websiteId,
                snapshotId: op.snapshotId,
                preRestoreSnapshotId: receipt.preRestoreSnapshotId,
                healthCheck: receipt.healthCheck ?? { satisfied: true },
                restoredAt: receipt.committedAt ?? currentTime,
              };
              op.restartEvidence = {
                status: 'reconciled_from_receipt',
                receiptStatus: 'succeeded',
                reconciledAt: currentTime,
              };
              op.finishedAt = op.finishedAt ?? currentTime;
              op.updatedAt = currentTime;
              reconciled.push(websiteBackupOperationPublicView(op));
              continue;
            }

            if (receipt.status === 'rolled_back') {
              op.status = 'rolled_back';
              op.snapshotId = op.snapshotId ?? receipt.snapshotId;
              op.preRestoreSnapshotId = receipt.preRestoreSnapshotId;
              op.result = {
                status: 'rolled_back',
                websiteId: op.websiteId,
                snapshotId: op.snapshotId,
                preRestoreSnapshotId: receipt.preRestoreSnapshotId,
                rollbackReason: receipt.rollbackReason ?? 'crash_reconciled',
                healthCheck: receipt.healthCheck ?? null,
                rolledBackAt: receipt.committedAt ?? currentTime,
              };
              op.restartEvidence = {
                status: 'reconciled_from_receipt',
                receiptStatus: 'rolled_back',
                rollbackReason: receipt.rollbackReason,
                reconciledAt: currentTime,
              };
              op.finishedAt = op.finishedAt ?? currentTime;
              op.updatedAt = currentTime;
              reconciled.push(websiteBackupOperationPublicView(op));
              continue;
            }

            if (receipt.status === 'pre_restore_created') {
              // Process crashed while restore or health check was running!
              // Perform recovery rollback to preRestoreSnapshotId
              let rollbackSucceeded = false;
              let rollbackError = null;
              if (resticRepositoryRegistry && resticManager
                && typeof resticRepositoryRegistry.getRepository === 'function'
                && typeof resticRepositoryRegistry.revealPassword === 'function'
                && typeof resticManager.restore === 'function') {
                try {
                  const repo = await resticRepositoryRegistry.getRepository(op.repositoryId);
                  const password = await resticRepositoryRegistry.revealPassword(op.repositoryId);
                  if (repo?.target && password) {
                    await resticManager.restore({
                      repository: repo.target,
                      password,
                      snapshotId: receipt.preRestoreSnapshotId,
                      targetDirectory: '/',
                    });
                    rollbackSucceeded = true;
                  }
                } catch (err) {
                  rollbackError = err.message;
                }
              }

              if (rollbackSucceeded) {
                if (receiptStore && typeof receiptStore.write === 'function') {
                  try {
                    await receiptStore.write({
                      ...receipt,
                      status: 'rolled_back',
                      rollbackReason: 'interrupted_by_restart_rollback_recovered',
                    });
                  } catch {}
                }
                op.status = 'rolled_back';
                op.preRestoreSnapshotId = receipt.preRestoreSnapshotId;
                op.result = {
                  status: 'rolled_back',
                  websiteId: op.websiteId,
                  snapshotId: op.snapshotId,
                  preRestoreSnapshotId: receipt.preRestoreSnapshotId,
                  rollbackReason: 'interrupted_by_restart_rollback_recovered',
                  rolledBackAt: currentTime,
                };
                op.restartEvidence = {
                  status: 'recovered_via_rollback',
                  preRestoreSnapshotId: receipt.preRestoreSnapshotId,
                  reconciledAt: currentTime,
                };
              } else {
                op.status = 'failed';
                op.preRestoreSnapshotId = receipt.preRestoreSnapshotId;
                op.error = {
                  code: 'interrupted_by_restart_rollback_failed',
                  message: `Restore was interrupted by crash and automatic rollback failed: ${rollbackError ?? 'repository unavailable'}`,
                };
                op.restartEvidence = {
                  status: 'rollback_failed',
                  preRestoreSnapshotId: receipt.preRestoreSnapshotId,
                  error: rollbackError,
                  reconciledAt: currentTime,
                };
              }
              op.finishedAt = op.finishedAt ?? currentTime;
              op.updatedAt = currentTime;
              reconciled.push(websiteBackupOperationPublicView(op));
              continue;
            }
          }

          // No receipt found: crashed before pre-restore snapshot was recorded
          op.status = 'failed';
          op.error = {
            code: 'interrupted_by_restart',
            message: 'Restore operation was interrupted before pre-restore snapshot was recorded',
          };
          op.restartEvidence = {
            status: 'failed_unstarted',
            reconciledAt: currentTime,
          };
          op.finishedAt = op.finishedAt ?? currentTime;
          op.updatedAt = currentTime;
          reconciled.push(websiteBackupOperationPublicView(op));
          continue;
        }

        if (op.kind === 'backup') {
          let snapshotFound = null;
          if (resticRepositoryRegistry && resticManager
            && typeof resticRepositoryRegistry.getRepository === 'function'
            && typeof resticRepositoryRegistry.revealPassword === 'function'
            && typeof resticManager.listSnapshots === 'function') {
            try {
              const repo = await resticRepositoryRegistry.getRepository(op.repositoryId);
              const password = await resticRepositoryRegistry.revealPassword(op.repositoryId);
              if (repo?.target && password) {
                const snapshots = await resticManager.listSnapshots({
                  repository: repo.target,
                  password,
                  tags: [`website:${op.websiteId}`],
                });
                if (Array.isArray(snapshots) && snapshots.length > 0) {
                  // Find snapshot created after operation's startedAt (or createdAt)
                  const opStartMs = Date.parse(op.startedAt ?? op.createdAt);
                  const matched = snapshots.find((snap) => {
                    const snapMs = Date.parse(snap.time);
                    return Number.isFinite(snapMs) && Math.abs(snapMs - opStartMs) <= 300_000;
                  });
                  if (matched) snapshotFound = matched;
                }
              }
            } catch {
              // ignore check error
            }
          }

          if (snapshotFound) {
            op.status = 'succeeded';
            op.snapshotId = snapshotFound.id;
            op.result = {
              status: 'succeeded',
              websiteId: op.websiteId,
              snapshot: { snapshotId: snapshotFound.id },
            };
            op.restartEvidence = {
              status: 'reconciled_from_snapshot',
              snapshotId: snapshotFound.id,
              reconciledAt: currentTime,
            };
          } else {
            op.status = 'failed';
            op.error = {
              code: 'interrupted_by_restart',
              message: 'Backup operation was interrupted by system restart',
            };
            op.restartEvidence = {
              status: 'failed_interrupted',
              reconciledAt: currentTime,
            };
          }
          op.finishedAt = op.finishedAt ?? currentTime;
          op.updatedAt = currentTime;
          reconciled.push(websiteBackupOperationPublicView(op));
        }
      }

      return reconciled;
    });
  }

  return Object.freeze({
    createOperation,
    getOperation,
    listOperations,
    updateOperation,
    reconcileInterruptedOperations,
    websiteBackupOperationPublicView,
  });
}
