import { createHash } from 'node:crypto';
import { assertUuid } from '@yunpanel/shared';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class WebsiteRestoreError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
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
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new WebsiteRestoreError('website_restore_dependencies_invalid', 'Website registry is required', 503);
  }
  if (!resticRepositoryRegistry || typeof resticRepositoryRegistry.getRepository !== 'function'
    || typeof resticRepositoryRegistry.revealPassword !== 'function') {
    throw new WebsiteRestoreError('website_restore_dependencies_invalid', 'Restic repository registry is required', 503);
  }
  if (!resticManager || typeof resticManager.listSnapshots !== 'function'
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
      repoPath,
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
    healthPath = '/health',
    timeoutSeconds = 30,
  } = {}) {
    const website = await resolveTargetWebsite(websiteId);
    const { repository, password } = await resolveTargetRepository(repositoryId, website.serverId);
    const snapshot = await resolveTargetSnapshot(repository.path, password, website.id, snapshotId);

    const healthSpec = Object.freeze({
      primaryDomain: website.primaryDomain,
      healthPath: typeof healthPath === 'string' && healthPath.startsWith('/') ? healthPath : '/health',
      timeoutSeconds: Number.isInteger(timeoutSeconds) && timeoutSeconds >= 5 && timeoutSeconds <= 120 ? timeoutSeconds : 30,
    });

    const previewPayload = {
      websiteId: website.id,
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      snapshotTime: snapshot.time,
      snapshotTags: Object.freeze([...(snapshot.tags ?? [])].sort()),
      snapshotPaths: Object.freeze([...(snapshot.paths ?? [])].sort()),
      healthSpec,
    };

    const previewDigest = sha256(previewPayload);
    const confirmation = `restore:${website.id}:${snapshot.id}:${previewDigest}`;

    return Object.freeze({
      ...previewPayload,
      previewDigest,
      confirmation,
    });
  }

  async function executeRestore({
    websiteId,
    repositoryId,
    snapshotId,
    expectedPreviewDigest,
    confirmation,
    healthPath = '/health',
    timeoutSeconds = 30,
  } = {}) {
    if (typeof expectedPreviewDigest !== 'string' || !SHA256_PATTERN.test(expectedPreviewDigest)) {
      throw new WebsiteRestoreError('invalid_preview_digest', 'Expected preview digest is invalid', 400);
    }
    if (typeof confirmation !== 'string' || !confirmation) {
      throw new WebsiteRestoreError('invalid_confirmation', 'Restore confirmation string is required', 400);
    }

    // Step 0: Get fresh preview and verify confirmation
    const preview = await previewRestore({
      websiteId,
      repositoryId,
      snapshotId,
      healthPath,
      timeoutSeconds,
    });

    if (preview.previewDigest !== expectedPreviewDigest) {
      throw new WebsiteRestoreError('restore_preview_stale', 'Website or snapshot state changed; request a new preview', 409);
    }
    if (preview.confirmation !== confirmation) {
      throw new WebsiteRestoreError('restore_confirmation_invalid', `Confirm restore with ${preview.confirmation}`, 409);
    }

    const website = await resolveTargetWebsite(websiteId);
    const { repository, password } = await resolveTargetRepository(repositoryId, website.serverId);

    // Step 1: Pre-restore snapshot
    let currentBackupSet;
    try {
      currentBackupSet = await websiteBackupSetProvider.getWebsiteBackupSet({ websiteId: website.id });
    } catch (error) {
      throw new WebsiteRestoreError('pre_restore_snapshot_failed', `Failed to compile current website backup set: ${error.message}`, 500);
    }

    let preRestoreSnapshotResult;
    try {
      preRestoreSnapshotResult = await resticManager.createSnapshot({
        repoPath: repository.path,
        password,
        targetPaths: currentBackupSet.targetPaths,
        tags: [...currentBackupSet.tags, 'pre-restore', `restore-of:${preview.snapshotId}`],
        excludePatterns: currentBackupSet.excludePatterns,
      });
    } catch (error) {
      throw new WebsiteRestoreError('pre_restore_snapshot_failed', `Pre-restore snapshot creation failed; restore aborted: ${error.message}`, 500);
    }

    const preRestoreSnapshotId = preRestoreSnapshotResult.snapshotId;

    // Step 2: Restore from target snapshot
    try {
      await resticManager.restore({
        repoPath: repository.path,
        password,
        snapshotId: preview.snapshotId,
        targetDirectory: '/',
      });
    } catch (restoreError) {
      // Automatic rollback on restore execution failure
      try {
        await resticManager.restore({
          repoPath: repository.path,
          password,
          snapshotId: preRestoreSnapshotId,
          targetDirectory: '/',
        });
      } catch {
        // Rollback attempt recorded
      }
      throw new WebsiteRestoreError(
        'restore_execution_failed',
        `Restore execution failed; rolled back to pre-restore snapshot: ${restoreError.message}`,
        500,
        { preRestoreSnapshotId },
      );
    }

    // Step 3: Health check
    let healthResult;
    try {
      healthResult = await healthInspector.inspect({
        primaryDomain: preview.healthSpec.primaryDomain,
        healthPath: preview.healthSpec.healthPath,
        timeoutSeconds: preview.healthSpec.timeoutSeconds,
      });
    } catch (inspectError) {
      healthResult = {
        satisfied: false,
        statusCode: null,
        attempts: 1,
        error: inspectError.message,
      };
    }

    // Step 4: Health Rollback if unhealthy
    if (!healthResult || healthResult.satisfied !== true) {
      try {
        await resticManager.restore({
          repoPath: repository.path,
          password,
          snapshotId: preRestoreSnapshotId,
          targetDirectory: '/',
        });
      } catch (rollbackError) {
        throw new WebsiteRestoreError(
          'restore_rollback_failed',
          `Health check failed and rollback to pre-restore snapshot also failed: ${rollbackError.message}`,
          500,
          { preRestoreSnapshotId, healthResult },
        );
      }

      return Object.freeze({
        status: 'rolled_back',
        websiteId: website.id,
        snapshotId: preview.snapshotId,
        preRestoreSnapshotId,
        rollbackReason: 'health_check_failed',
        healthCheck: Object.freeze({
          satisfied: false,
          statusCode: healthResult?.statusCode ?? null,
          attempts: healthResult?.attempts ?? 1,
          error: healthResult?.error ?? 'Website health check failed after restore',
        }),
        rolledBackAt: new Date().toISOString(),
      });
    }

    return Object.freeze({
      status: 'succeeded',
      websiteId: website.id,
      snapshotId: preview.snapshotId,
      preRestoreSnapshotId,
      healthCheck: Object.freeze({
        satisfied: true,
        statusCode: healthResult.statusCode,
        attempts: healthResult.attempts,
      }),
      restoredAt: new Date().toISOString(),
    });
  }

  return Object.freeze({
    previewRestore,
    executeRestore,
  });
}
