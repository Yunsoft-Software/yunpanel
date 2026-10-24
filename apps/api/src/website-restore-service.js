import { createHash } from 'node:crypto';
import { assertUuid } from '@yunpanel/shared';
import { createWebsiteRestoreReceiptStore } from '@yunpanel/host-runtime';
import { resolveWebsiteRestoreSelection, assertWebsiteSnapshotContent } from './website-restore-selection.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_STATUSES = new Set(['queued', 'running']);

export class WebsiteRestoreError extends Error {
  constructor(code, message, status = 400, details = null, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WebsiteRestoreError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

function normalizeUuid(value, label) {
  try {
    return assertUuid(value, label);
  } catch {
    throw new WebsiteRestoreError(`invalid_${label}`, `${label} is invalid`, 400);
  }
}

export function websiteRestoreTransactionId({ websiteId, previewDigest, operationId = null }) {
  const identity = operationId ? sha256({ operationId, previewDigest }) : previewDigest;
  return `restore:${websiteId}:${identity.slice(0, 32)}`;
}

function normalizeSnapshotId(value) {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 128
    || !/^[a-zA-Z0-9_-]+$/.test(value.trim())) {
    throw new WebsiteRestoreError('invalid_snapshot_id', 'Snapshot ID is invalid', 400);
  }
  return value.trim();
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function createWebsiteRestoreService({
  websiteRegistry,
  resticRepositoryRegistry,
  resticManager,
  websiteBackupSetProvider,
  healthInspector,
  localServerId = null,
  jobRegistry = null,
  receiptStore = null,
  websiteBackupService = null,
  databaseBackupAdapter = null,
  mailBackupAdapter = null,
  environmentBackupAdapter = null,
  dnsBackupAdapter = null,
  hostingBackupAdapter = null,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new WebsiteRestoreError('website_restore_dependencies_invalid', 'Website registry is required', 503);
  }
  if (!resticRepositoryRegistry || typeof resticRepositoryRegistry.getRepository !== 'function'
    || typeof resticRepositoryRegistry.revealPassword !== 'function') {
    throw new WebsiteRestoreError('website_restore_dependencies_invalid', 'Restic repository registry is required', 503);
  }
  if (!resticManager || typeof resticManager.listSnapshots !== 'function'
    || typeof resticManager.listSnapshotFiles !== 'function'
    || typeof resticManager.createSnapshot !== 'function'
    || typeof resticManager.restore !== 'function') {
    throw new WebsiteRestoreError('website_restore_dependencies_invalid', 'Restic manager is required', 503);
  }
  if (!websiteBackupSetProvider || typeof websiteBackupSetProvider.getWebsiteBackupSet !== 'function') {
    throw new WebsiteRestoreError('website_restore_dependencies_invalid', 'Website backup set provider is required', 503);
  }
  if (!healthInspector || typeof healthInspector.inspect !== 'function') {
    throw new WebsiteRestoreError('website_restore_dependencies_invalid', 'Website health inspector is required', 503);
  }

  const resolvedReceiptStore = receiptStore ?? createWebsiteRestoreReceiptStore();

  async function assertIdle(websiteId, serverId, executionJobId = null) {
    if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') return;
    let jobs;
    try {
      jobs = await jobRegistry.listJobs({ serverId });
    } catch {
      throw new WebsiteRestoreError('website_job_state_unavailable', 'Website job state could not be inspected', 503);
    }
    if (!Array.isArray(jobs)) {
      throw new WebsiteRestoreError('website_job_state_unavailable', 'Website job state is invalid', 503);
    }
    const hasConflict = jobs.some((job) =>
      job.id !== executionJobId && ACTIVE_STATUSES.has(job.status) && (
        (job.resourceType === 'website' && job.resourceId === websiteId)
        || job.payload?.websiteId === websiteId
      )
    );
    if (hasConflict) {
      throw new WebsiteRestoreError('website_job_conflict', 'Another operation is already queued or running for this website', 409);
    }
  }

  async function resolveTargetWebsite(websiteId) {
    const normalizedWebsiteId = normalizeUuid(websiteId, 'website_id');
    const website = await websiteRegistry.getWebsite(normalizedWebsiteId);
    if (!website) {
      throw new WebsiteRestoreError('website_not_found', 'Website not found', 404);
    }
    if (localServerId && website.serverId !== localServerId) {
      throw new WebsiteRestoreError('website_server_mismatch', 'Website belongs to a different server', 404);
    }
    return website;
  }

  async function resolveTargetRepository(repositoryId, serverId) {
    const normalizedRepoId = normalizeUuid(repositoryId, 'repository_id');
    const repository = await resticRepositoryRegistry.getRepository(normalizedRepoId);
    if (!repository) {
      throw new WebsiteRestoreError('repository_not_found', 'Restic repository not found', 404);
    }
    if (repository.serverId !== serverId) {
      throw new WebsiteRestoreError('repository_server_mismatch', 'Repository belongs to a different server', 404);
    }
    const password = await resticRepositoryRegistry.revealPassword(normalizedRepoId);
    return { repository, password };
  }

  async function resolveTargetSnapshot(repoPath, password, websiteId, snapshotId) {
    const normalizedSnapshotId = normalizeSnapshotId(snapshotId);
    const snapshots = await resticManager.listSnapshots({
      repository: repoPath,
      password,
      tags: [`website:${websiteId}`],
    });

    const targetSnapshot = snapshots.find((snap) =>
      snap.id === normalizedSnapshotId || snap.id.startsWith(normalizedSnapshotId)
    );

    if (!targetSnapshot) {
      throw new WebsiteRestoreError('snapshot_not_found', 'Snapshot not found for website in this repository', 404);
    }

    return targetSnapshot;
  }

  async function previewRestore({
    websiteId,
    repositoryId,
    snapshotId,
    healthPath = '/',
    timeoutSeconds = 30,
    include = [],
    executionJobId = null,
  } = {}) {
    const website = await resolveTargetWebsite(websiteId);
    await assertIdle(website.id, website.serverId, executionJobId);

    const { repository, password } = await resolveTargetRepository(repositoryId, website.serverId);
    const snapshot = await resolveTargetSnapshot(repository.target, password, website.id, snapshotId);

    const backupSet = await websiteBackupSetProvider.getWebsiteBackupSet({ websiteId: website.id, serverId: website.serverId });
    const primaryDomain = backupSet.website?.primaryDomain ?? website.primaryDomain;
    if (typeof primaryDomain !== 'string' || !primaryDomain.includes('.') || /[\s/:]/.test(primaryDomain)) throw new WebsiteRestoreError('website_restore_domain_unavailable', 'Geri yükleme için siteye bağlı alan adı doğrulanamadı', 409);
    const healthSpec = Object.freeze({ primaryDomain,
      healthPath: typeof healthPath === 'string' && healthPath.startsWith('/') ? healthPath : '/',
      timeoutSeconds: Number.isInteger(timeoutSeconds) && timeoutSeconds >= 5 && timeoutSeconds <= 120 ? timeoutSeconds : 30,
    });
    const nodes = await resticManager.listSnapshotFiles({ repository: repository.target, password, snapshotId: snapshot.id });
    let normalizedIncludes;
    try {
      normalizedIncludes = resolveWebsiteRestoreSelection(backupSet, include, nodes);
      assertWebsiteSnapshotContent(nodes, backupSet, normalizedIncludes);
    } catch (error) {
      throw new WebsiteRestoreError(error.code ?? 'website_restore_selection_invalid', error.message, 409);
    }
    const unappliedResources = [
      ...(!mailBackupAdapter ? (backupSet.mail ?? []).flatMap(mail => [mail.storagePath, mail.stagedDataDirectory, mail.virtualMailDbSnapshot]) : []),
      ...(!dnsBackupAdapter ? (backupSet.dns ?? []).map(dns => dns.stagedZonePath) : []),
      ...(!hostingBackupAdapter ? (backupSet.nginx ?? []).flatMap(nginx => [nginx.stagedConfigPath,nginx.stagedMetadataPath]) : []),
      ...(!environmentBackupAdapter ? [backupSet.env?.stagedMetadataPath] : []),
    ].filter(Boolean);
    if (unappliedResources.some(target => normalizedIncludes.some(root => target === root || target.startsWith(root + '/') || root.startsWith(target + '/')))) {
      throw new WebsiteRestoreError('website_restore_resource_adapter_unavailable', 'Posta, DNS ve barındırma ayarlarının geri yüklenmesi henüz doğrulanmadı. Dosyaları veya veritabanını ayrı seçin.', 503);
    }
    const selectsDatabase = (backupSet.databases ?? []).some((database) => normalizedIncludes.some((root) => {
      const directory = database.dumpHook?.stagedBackupDirectory ?? database.dumpHook?.stagedDumpPath;
      return directory && (directory === root || directory.startsWith(root + '/') || root.startsWith(directory + '/'));
    }));
    if (selectsDatabase && typeof databaseBackupAdapter?.restore !== 'function') throw new WebsiteRestoreError('website_database_restore_unavailable', 'Database restore adapter is unavailable', 503);
    if (environmentBackupAdapter) await environmentBackupAdapter.assertSupported(backupSet, normalizedIncludes);
    if (dnsBackupAdapter) await dnsBackupAdapter.assertSupported(backupSet, normalizedIncludes);
    if (hostingBackupAdapter) await hostingBackupAdapter.assertSupported(backupSet, normalizedIncludes);

    const previewPayload = {
      websiteId: website.id,
      websiteRevision: website.revision ?? 1,
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      snapshotTime: snapshot.time,
      snapshotTags: Object.freeze([...(snapshot.tags ?? [])].sort()),
      snapshotPaths: Object.freeze([...(snapshot.paths ?? [])].sort()),
      healthSpec,
      include: normalizedIncludes,
      selective: include.length > 0,
    };

    const previewDigest = sha256(previewPayload);
    const confirmation = `restore:${website.id}:${snapshot.id}:${previewDigest}`;

    return Object.freeze({
      ...previewPayload,
      include: normalizedIncludes,
      selective: include.length > 0,
      previewDigest,
      confirmation,
    });
  }

  async function executeRestore({
    websiteId, repositoryId, snapshotId, expectedPreviewDigest, confirmation,
    healthPath = '/', timeoutSeconds = 30, include = [], executionJobId = null, operationId = null,
  } = {}) {
    if (typeof expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(expectedPreviewDigest)) throw new WebsiteRestoreError('invalid_preview_digest', 'Expected preview digest is invalid', 400);
    const preview = await previewRestore({ websiteId, repositoryId, snapshotId, healthPath, timeoutSeconds, include, executionJobId });
    if (preview.previewDigest !== expectedPreviewDigest) throw new WebsiteRestoreError('restore_preview_stale', 'Website changed; refresh the preview', 409);
    if (confirmation !== preview.confirmation) throw new WebsiteRestoreError('restore_confirmation_invalid', 'Restore confirmation does not match the preview', 409);
    const website = await resolveTargetWebsite(websiteId);
    await assertIdle(website.id, website.serverId, executionJobId);
    // A newly authorized restore must run again even when its snapshot and
    // selection match a previous restore. Only a retry of the same durable
    // operation may reuse that operation's receipt.
    const requestIdentity = operationId ?? executionJobId;
    const transactionId = websiteRestoreTransactionId({ websiteId: website.id,
      previewDigest: preview.previewDigest, operationId: requestIdentity });
    // An unreadable journal is a stop condition, never permission to repeat a mutation.
    const existing = await resolvedReceiptStore.read(transactionId);
    if (existing) {
      if (existing.websiteId !== website.id || existing.repositoryId !== repositoryId || existing.previewDigest !== preview.previewDigest) throw new WebsiteRestoreError('restore_receipt_conflict', 'Restore journal does not match this operation', 409);
      if (['succeeded', 'rolled_back'].includes(existing.status)) return Object.freeze({
        status: existing.status, websiteId: website.id, snapshotId: existing.snapshotId, preRestoreSnapshotId: existing.preRestoreSnapshotId,
        healthCheck: existing.healthCheck, rollbackReason: existing.rollbackReason, restoredAt: existing.committedAt, idempotent: true,
      });
      throw new WebsiteRestoreError('restore_recovery_required', 'An interrupted restore must be recovered before another restore', 409);
    }
    const { repository, password } = await resolveTargetRepository(repositoryId, website.serverId);
    const backupSet = await websiteBackupSetProvider.getWebsiteBackupSet({ websiteId: website.id, serverId: website.serverId });
    const rollbackPaths = [...preview.include];
    if (!rollbackPaths.length || !preview.include?.length) throw new WebsiteRestoreError('website_restore_selection_empty', 'Verified website restore paths are required', 409);
    let preRestore;
    try {
      preRestore = websiteBackupService
      ? (await websiteBackupService.executeBackup({ websiteId: website.id, repositoryId, expectedPreviewDigest: backupSet.digest,
        tags: ['pre-restore', `restore-of:${preview.snapshotId}`, `tx:${transactionId}`], executionJobId, operationId: operationId ? `${operationId}:pre` : null })).snapshot
      : await resticManager.createSnapshot({ repository: repository.target, password, paths: rollbackPaths,
        tags: [...backupSet.tags, 'pre-restore', `restore-of:${preview.snapshotId}`, `tx:${transactionId}`], excludes: backupSet.excludePatterns });
    } catch {
      throw new WebsiteRestoreError('pre_restore_snapshot_failed', 'Pre-restore snapshot failed; no restore was attempted', 500);
    }
    if (!preRestore?.snapshotId) throw new WebsiteRestoreError('pre_restore_snapshot_failed', 'Pre-restore snapshot was not verified', 502);
    const journal = { transactionId, websiteId: website.id, websiteRevision: preview.websiteRevision, repositoryId: repository.id,
      snapshotId: preview.snapshotId, preRestoreSnapshotId: preRestore.snapshotId, previewDigest: preview.previewDigest, rollbackPaths };
    // This write must succeed before any restore changes a file.
    await resolvedReceiptStore.write({ ...journal, status: 'pre_restore_created' });
    async function rollback(reason, healthCheck = null, restoreError = null) {
      try {
        await resticManager.restore({ repository: repository.target, password, snapshotId: preRestore.snapshotId, targetDirectory: '/', include: rollbackPaths });
        if (databaseBackupAdapter) await databaseBackupAdapter.restore({ backupSet, include: rollbackPaths, operationId, rollback: true });
        if (mailBackupAdapter) await mailBackupAdapter.restore({ backupSet, include: rollbackPaths, operationId, rollback: true });
        if (environmentBackupAdapter) await environmentBackupAdapter.restore({ backupSet, include: rollbackPaths, operationId, rollback: true });
        if (dnsBackupAdapter) await dnsBackupAdapter.restore({ backupSet, include: rollbackPaths, operationId, rollback: true });
        if (hostingBackupAdapter) await hostingBackupAdapter.restore({ backupSet, include: rollbackPaths, operationId, rollback: true });
      } catch (rollbackError) {
        throw new WebsiteRestoreError('restore_rollback_failed', 'Restore failed and rollback requires recovery', 500,
          { preRestoreSnapshotId: preRestore.snapshotId }, new AggregateError([restoreError, rollbackError].filter(Boolean), 'Restore recovery requires inspection'));
      }
      await resolvedReceiptStore.write({ ...journal, status: 'rolled_back', rollbackReason: reason, healthCheck });
      return Object.freeze({ status: 'rolled_back', websiteId: website.id, snapshotId: preview.snapshotId,
        preRestoreSnapshotId: preRestore.snapshotId, rollbackReason: reason, healthCheck, rolledBackAt: new Date().toISOString() });
    }
    try {
      await resticManager.restore({ repository: repository.target, password, snapshotId: preview.snapshotId, targetDirectory: '/', include: [...preview.include] });
      if (databaseBackupAdapter) await databaseBackupAdapter.restore({ backupSet, include: preview.include, operationId });
      if (mailBackupAdapter) await mailBackupAdapter.restore({ backupSet, include: preview.include, operationId });
      if (environmentBackupAdapter) await environmentBackupAdapter.restore({ backupSet, include: preview.include, operationId });
      if (dnsBackupAdapter) await dnsBackupAdapter.restore({ backupSet, include: preview.include, operationId });
      if (hostingBackupAdapter) await hostingBackupAdapter.restore({ backupSet, include: preview.include, operationId });
    } catch (error) {
      return rollback('restore_execution_failed', null, error);
    }
    let healthCheck;
    try { healthCheck = await healthInspector.inspect(preview.healthSpec); }
    catch { healthCheck = { satisfied: false, statusCode: null, attempts: 1, error: 'Website health check could not complete' }; }
    if (healthCheck?.satisfied !== true) return rollback('health_check_failed', healthCheck);
    await resolvedReceiptStore.write({ ...journal, status: 'succeeded', healthCheck });
    return Object.freeze({ status: 'succeeded', websiteId: website.id, snapshotId: preview.snapshotId, preRestoreSnapshotId: preRestore.snapshotId,
      selective: preview.selective, include: [...preview.include], healthCheck, restoredAt: new Date().toISOString() });
  }

  return Object.freeze({
    previewRestore,
    executeRestore,
  });
}
