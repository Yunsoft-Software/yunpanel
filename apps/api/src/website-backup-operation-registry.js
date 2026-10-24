import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createProcessStoreLock } from './process-store-lock.js';
import { assertWebsiteSnapshotContent, resolveWebsiteRestoreSelection } from './website-restore-selection.js';
import { websiteRestoreTransactionId } from './website-restore-service.js';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'rolled_back']);
const OPERATION_KINDS = new Set(['backup', 'restore', 'check', 'plan']);
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
    jobId: operation.jobId ?? null,
    kind: operation.kind,
    snapshotId: operation.snapshotId ?? null,
    preRestoreSnapshotId: operation.preRestoreSnapshotId ?? null,
    previewDigest: operation.previewDigest,
    status: operation.status,
    progress: operation.progress ? Object.freeze({ ...operation.progress }) : null,
    steps: Array.isArray(operation.steps)
      ? Object.freeze(operation.steps.map((step) => Object.freeze({ ...step })))
      : Object.freeze([]),
    selective: Boolean(operation.selective || (Array.isArray(operation.include) && operation.include.length > 0)),
    include: Array.isArray(operation.include)
      ? Object.freeze([...operation.include])
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
  if (kind === 'restore') {
    return [
      { name: 'pre_restore', status: 'pending', updatedAt: timestamp },
      { name: 'restore', status: 'pending', updatedAt: timestamp },
      { name: 'health_check', status: 'pending', updatedAt: timestamp },
    ];
  }
  if (kind === 'check') {
    return [
      { name: 'check_repository', status: 'pending', updatedAt: timestamp },
    ];
  }
  if (kind === 'plan') {
    return [
      { name: 'configure_plan', status: 'pending', updatedAt: timestamp },
    ];
  }
  return [];
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
          if (item && UUID_PATTERN.test(item.id ?? '') && UUID_PATTERN.test(item.websiteId ?? '') && UUID_PATTERN.test(item.repositoryId ?? '')
            && OPERATION_STATUSES.has(item.status) && OPERATION_KINDS.has(item.kind) && SHA256_PATTERN.test(item.previewDigest ?? '')
            && !operations.has(item.id.toLowerCase())) {
            operations.set(item.id.toLowerCase(), item);
          } else throw new WebsiteBackupOperationRegistryError('website_backup_operation_store_invalid', 'Website backup operation store contains an invalid record', 500);
        }
      } else throw new WebsiteBackupOperationRegistryError('website_backup_operation_store_invalid', 'Website backup operation store is invalid', 500);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new WebsiteBackupOperationRegistryError(
          'website_backup_operation_store_invalid',
          'Website backup operation store could not be read',
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
    previewDigest = null,
    confirmation = null,
    healthPath = '/health',
    timeoutSeconds = 30,
    tags = [],
    steps = null,
    include = [],
    selective = false,
    actor = null,
    options = {},
  }) {
    if (!websiteId || !UUID_PATTERN.test(websiteId)) {
      throw new WebsiteBackupOperationRegistryError('invalid_website_id', 'websiteId must be a valid UUID', 400);
    }
    if (!repositoryId || !UUID_PATTERN.test(repositoryId)) {
      throw new WebsiteBackupOperationRegistryError('invalid_repository_id', 'repositoryId must be a valid UUID', 400);
    }
    if (!OPERATION_KINDS.has(kind)) {
      throw new WebsiteBackupOperationRegistryError('invalid_operation_kind', `kind must be 'backup', 'restore', 'check', or 'plan'`, 400);
    }
    const effectiveDigest = previewDigest ?? (
      (kind === 'check' || kind === 'plan')
        ? '0'.repeat(64)
        : null
    );
    const effectiveConfirmation = confirmation ?? (
      (kind === 'check' || kind === 'plan')
        ? `${kind}:${websiteId.toLowerCase()}:${repositoryId.toLowerCase()}`
        : null
    );
    if (!effectiveDigest || !SHA256_PATTERN.test(effectiveDigest)) {
      throw new WebsiteBackupOperationRegistryError('invalid_preview_digest', 'previewDigest must be a 64-character SHA-256 hex string', 400);
    }
    if (!effectiveConfirmation || typeof effectiveConfirmation !== 'string') {
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
        previewDigest: effectiveDigest,
        confirmation: effectiveConfirmation,
        healthPath: typeof healthPath === 'string' ? healthPath : '/health',
        timeoutSeconds: Number.isSafeInteger(timeoutSeconds) ? timeoutSeconds : 30,
        tags: Array.isArray(tags) ? [...tags] : [],
        include: Array.isArray(include) ? [...include] : [],
        selective: Boolean(selective || (Array.isArray(include) && include.length > 0)),
        actor: actor ? structuredClone(actor) : null,
        options: structuredClone(options),
        jobId: null,
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

  // This view is only for the native worker; actor and execution inputs never go to HTTP.
  async function getExecutionOperation(id) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
    return withStore(() => {
      const operation = operations.get(id.toLowerCase());
      return operation ? structuredClone(operation) : null;
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
    resticManager = null, resticRepositoryRegistry = null, receiptStore = null,
    websiteRegistry = null, websiteBackupSetProvider = null, jobRegistry = null, siteMutationLock = null, databaseBackupAdapter = null, mailBackupAdapter = null, environmentBackupAdapter = null, dnsBackupAdapter = null, hostingBackupAdapter = null,
  } = {}) {
    const candidates = await listOperations();
    const reconciled = [];
    for (const publicOperation of candidates) {
      if (!ACTIVE_STATUSES.has(publicOperation.status)) continue;
      const op = await getExecutionOperation(publicOperation.id);
      const job = op.jobId && typeof jobRegistry?.getJob === 'function' ? await jobRegistry.getJob(op.jobId) : null;
      if (op.status === 'queued' && job?.status === 'queued') continue;
      if (op.jobId && (!job || job.resourceId !== op.id || job.resourceType !== 'backup'
        || job.serverId !== op.serverId || job.payload?.operationId !== op.id || job.payload?.websiteId !== op.websiteId)) {
        throw new WebsiteBackupOperationRegistryError('website_backup_recovery_identity_invalid', 'Durable backup job does not match its operation', 409);
      }
      const website = await websiteRegistry?.getWebsite(op.websiteId);
      if (!website || website.serverId !== op.serverId || typeof siteMutationLock?.withSiteLock !== 'function') {
        throw new WebsiteBackupOperationRegistryError('website_backup_recovery_scope_unavailable', 'Interrupted backup scope requires inspection', 503);
      }
      const patch = await siteMutationLock.withSiteLock({ websiteId: website.id, applicationId: website.applicationId ?? null }, async () => {
        const backupSet = await websiteBackupSetProvider?.getWebsiteBackupSet({ websiteId: website.id, serverId: website.serverId });
        if (!backupSet?.targetPaths?.length) throw new WebsiteBackupOperationRegistryError('website_backup_recovery_scope_unavailable', 'Verified website backup paths are unavailable', 503);
        const repository = await resticRepositoryRegistry?.getRepository(op.repositoryId);
        if (!repository || repository.serverId !== website.serverId) throw new WebsiteBackupOperationRegistryError('website_backup_recovery_identity_invalid', 'Backup repository scope changed', 409);
        const password = await resticRepositoryRegistry.revealPassword(op.repositoryId);
        if (op.kind === 'restore') {
          let transactionId = websiteRestoreTransactionId({ websiteId: op.websiteId,
            previewDigest: op.previewDigest, operationId: op.id });
          let receipt = await receiptStore?.read(transactionId);
          if (!receipt) {
            const legacyId = websiteRestoreTransactionId({ websiteId: op.websiteId, previewDigest: op.previewDigest });
            const legacy = await receiptStore?.read(legacyId);
            // Older operations have preview-based receipts. A receipt written
            // before this request belongs to an earlier restore and cannot
            // prove that the interrupted request changed any data.
            if (legacy && Number.isFinite(Date.parse(legacy.committedAt))
              && Date.parse(legacy.committedAt) >= Date.parse(op.createdAt)) {
              transactionId = legacyId;
              receipt = legacy;
            }
          }
          if (receipt) {
            if (receipt.websiteId !== op.websiteId || receipt.repositoryId !== op.repositoryId || receipt.previewDigest !== op.previewDigest || receipt.snapshotId !== op.snapshotId) {
              throw new WebsiteBackupOperationRegistryError('website_restore_recovery_receipt_mismatch', 'Restore journal does not match the interrupted operation', 409);
            }
            if (receipt.status === 'pre_restore_created') {
              const paths = receipt.rollbackPaths;
              if (!Array.isArray(paths) || !paths.length || paths.some((value) => !backupSet.targetPaths.some(root => value === root || value.startsWith(root + '/')))) {
                throw new WebsiteBackupOperationRegistryError('website_restore_recovery_scope_unverified', 'Legacy restore journal has no verified rollback scope', 409);
              }
              const snapshots = await resticManager.listSnapshots({ repository: repository.target, password, tags: [`website:${op.websiteId}`, 'pre-restore'] });
              if (!snapshots.some((snapshot) => snapshot.id === receipt.preRestoreSnapshotId && snapshot.tags?.includes(`tx:${transactionId}`))) {
                throw new WebsiteBackupOperationRegistryError('website_restore_recovery_snapshot_unverified', 'Rollback snapshot ownership could not be verified', 409);
              }
              const selected = target => target && paths.some(root => target === root || target.startsWith(root + '/') || root.startsWith(target + '/'));
              if (backupSet.databases?.some(db => selected(db.dumpHook?.stagedBackupDirectory)) && !databaseBackupAdapter) throw new WebsiteBackupOperationRegistryError('website_database_restore_unavailable', 'Database rollback engine is unavailable', 503);
              if ((backupSet.mail ?? []).some(mail => mail.managementMode === 'local' && [mail.storagePath, mail.stagedDataDirectory, mail.virtualMailDbSnapshot].some(selected)) && !mailBackupAdapter) throw new WebsiteBackupOperationRegistryError('website_mail_restore_unavailable', 'Mail rollback engine is unavailable', 503);
              if (selected(backupSet.env?.stagedMetadataPath) && !environmentBackupAdapter) throw new WebsiteBackupOperationRegistryError('website_environment_runtime_restore_unavailable', 'Environment rollback engine is unavailable', 503);
              if (environmentBackupAdapter) await environmentBackupAdapter.assertSupported(backupSet, paths);
              if (dnsBackupAdapter) await dnsBackupAdapter.assertSupported(backupSet, paths);
              if (hostingBackupAdapter) await hostingBackupAdapter.assertSupported(backupSet, paths);
              if ([...(!dnsBackupAdapter ? (backupSet.dns ?? []).map(dns => dns.stagedZonePath) : []), ...(!hostingBackupAdapter ? (backupSet.nginx ?? []).flatMap(nginx => [nginx.stagedConfigPath,nginx.stagedMetadataPath]) : [])].some(selected)) throw new WebsiteBackupOperationRegistryError('website_restore_resource_adapter_unavailable', 'Hosting rollback engine is unavailable', 503);
              await resticManager.restore({ repository: repository.target, password, snapshotId: receipt.preRestoreSnapshotId, targetDirectory: '/', include: [...paths] });
              if (databaseBackupAdapter) await databaseBackupAdapter.restore({ backupSet, include: paths, operationId: op.id, rollback: true });
              if (mailBackupAdapter) await mailBackupAdapter.restore({ backupSet, include: paths, operationId: op.id, rollback: true });
              if (environmentBackupAdapter) await environmentBackupAdapter.restore({ backupSet, include: paths, operationId: op.id, rollback: true });
              if (dnsBackupAdapter) await dnsBackupAdapter.restore({ backupSet, include: paths, operationId: op.id, rollback: true });
              if (hostingBackupAdapter) await hostingBackupAdapter.restore({ backupSet, include: paths, operationId: op.id, rollback: true });
              await receiptStore.write({ ...receipt, status: 'rolled_back', rollbackReason: 'interrupted_by_restart_rollback_recovered' });
              return { status: 'rolled_back', preRestoreSnapshotId: receipt.preRestoreSnapshotId,
                result: { status: 'rolled_back', websiteId: op.websiteId, snapshotId: op.snapshotId, preRestoreSnapshotId: receipt.preRestoreSnapshotId, rollbackReason: 'interrupted_by_restart_rollback_recovered' },
                restartEvidence: { status: 'recovered_via_rollback', reconciledAt: now() } };
            }
            if (['succeeded', 'rolled_back'].includes(receipt.status) && (receipt.status !== 'succeeded' || receipt.healthCheck?.satisfied === true)) {
              return { status: receipt.status, preRestoreSnapshotId: receipt.preRestoreSnapshotId,
                result: { status: receipt.status, websiteId: op.websiteId, snapshotId: op.snapshotId, preRestoreSnapshotId: receipt.preRestoreSnapshotId, healthCheck: receipt.healthCheck, rollbackReason: receipt.rollbackReason },
                restartEvidence: { status: 'reconciled_from_receipt', reconciledAt: now() } };
            }
          }
        } else if (op.kind === 'backup' && typeof resticManager?.listSnapshots === 'function') {
          const snapshots = await resticManager.listSnapshots({ repository: repository.target, password,
            tags: [`website:${op.websiteId}`, `operation:${op.id}`, `backup-set:${op.previewDigest}`] });
          const matching = snapshots.filter((snapshot) => [`website:${op.websiteId}`, `operation:${op.id}`, `backup-set:${op.previewDigest}`].every((tag) => snapshot.tags?.includes(tag)));
          if (matching.length > 1) throw new WebsiteBackupOperationRegistryError('website_backup_recovery_snapshot_ambiguous', 'Several snapshots claim the same operation', 409);
          if (matching.length === 1) {
            if (typeof resticManager.listSnapshotFiles !== 'function') throw new WebsiteBackupOperationRegistryError('website_backup_recovery_content_unavailable', 'Snapshot files could not be inspected', 503);
            const snapshot = matching[0];
            const nodes = await resticManager.listSnapshotFiles({ repository: repository.target, password, snapshotId: snapshot.id });
            assertWebsiteSnapshotContent(nodes, backupSet, resolveWebsiteRestoreSelection(backupSet, [], nodes));
            if (!nodes.some((node) => node.type === 'file' && backupSet.targetPaths.some((root) => node.path === root || node.path.startsWith(root + '/')))) {
              throw new WebsiteBackupOperationRegistryError('website_backup_recovery_content_unverified', 'Snapshot has no files for this website', 409);
            }
            if (op.options?.retentionPolicy && op.result?.retention?.status !== 'completed') return { status: 'failed', snapshotId: snapshot.id,
              result: { status: 'succeeded', websiteId: op.websiteId, snapshot: { snapshotId: snapshot.id } },
              error: { code: 'backup_retention_interrupted', message: 'Yedek doğrulandı; kesilen saklama işlemi ayrıca kontrol edilmeli' },
              restartEvidence: { status: 'snapshot_verified_retention_unresolved', snapshotId: snapshot.id, reconciledAt: now() } };
            return { status: 'succeeded', snapshotId: snapshot.id,
              result: { status: 'succeeded', websiteId: op.websiteId, snapshot: { snapshotId: snapshot.id }, backupSetDigest: op.previewDigest },
              restartEvidence: { status: 'reconciled_from_snapshot', snapshotId: snapshot.id, reconciledAt: now() } };
          }
        }
        return { status: 'failed', error: { code: 'interrupted_by_restart', message: 'Kesilen işlemin sonucu doğrulanamadı; işlem tekrar yürütülmedi' },
          restartEvidence: { status: 'failed_interrupted', reconciledAt: now() } };
      });
      const operation = await updateOperation(op.id, { ...patch, finishedAt: now(), progress: { phase: patch.status, percent: null, message: 'Kesinti sonrası kayıt ve depo denetlendi' } });
      reconciled.push(operation);
    }
    return reconciled;
  }

  return Object.freeze({
    createOperation,
    getOperation,
    getExecutionOperation,
    listOperations,
    updateOperation,
    reconcileInterruptedOperations,
    websiteBackupOperationPublicView,
  });
}
