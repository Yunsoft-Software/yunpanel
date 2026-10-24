import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertUuid } from '@yunpanel/shared';
import { WebsiteBackupSetError } from './website-backup-set.js';

const execFileAsync = promisify(execFile);
const ACTIVE_STATUSES = new Set(['queued', 'running']);

export class WebsiteBackupError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'WebsiteBackupError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function isWebsiteBackupError(error) {
  return error instanceof WebsiteBackupError || error instanceof WebsiteBackupSetError;
}

function normalizeUuid(value, label) {
  try {
    return assertUuid(value, label);
  } catch {
    throw new WebsiteBackupError(`invalid_${label}`, `${label} is invalid`, 400);
  }
}

export function createWebsiteBackupService({
  websiteRegistry,
  resticRepositoryRegistry,
  resticManager,
  websiteBackupSetProvider,
  localServerId = null,
  jobRegistry = null,
  databaseBackupAdapter = null,
  mailBackupAdapter = null,
  environmentBackupAdapter = null,
  dnsBackupAdapter = null,
  hostingBackupAdapter = null,
  runCommand = async (cmd, args) => execFileAsync(cmd, args),
  mkdirFn = mkdir,
  writeFileFn = writeFile,
  readFileFn = readFile,
  rmFn = rm,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new WebsiteBackupError('website_backup_dependencies_invalid', 'Website registry is required', 503);
  }
  if (!resticRepositoryRegistry || typeof resticRepositoryRegistry.getRepository !== 'function'
    || typeof resticRepositoryRegistry.revealPassword !== 'function') {
    throw new WebsiteBackupError('website_backup_dependencies_invalid', 'Restic repository registry is required', 503);
  }
  if (!resticManager || typeof resticManager.createSnapshot !== 'function') {
    throw new WebsiteBackupError('website_backup_dependencies_invalid', 'Restic manager is required', 503);
  }
  if (!websiteBackupSetProvider || typeof websiteBackupSetProvider.getWebsiteBackupSet !== 'function') {
    throw new WebsiteBackupError('website_backup_dependencies_invalid', 'Website backup set provider is required', 503);
  }

  async function assertIdle(websiteId, serverId, executionJobId = null) {
    if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') return;
    let jobs;
    try {
      jobs = await jobRegistry.listJobs({ serverId });
    } catch {
      throw new WebsiteBackupError('website_job_state_unavailable', 'Website job state could not be inspected', 503);
    }
    if (!Array.isArray(jobs)) {
      throw new WebsiteBackupError('website_job_state_unavailable', 'Website job state is invalid', 503);
    }
    const hasConflict = jobs.some((job) =>
      job.id !== executionJobId && ACTIVE_STATUSES.has(job.status) && (
        (job.resourceType === 'website' && job.resourceId === websiteId)
        || job.payload?.websiteId === websiteId
      )
    );
    if (hasConflict) {
      throw new WebsiteBackupError('website_job_conflict', 'Another operation is already queued or running for this website', 409);
    }
  }

  async function resolveTargetWebsite(websiteId) {
    const normalizedWebsiteId = normalizeUuid(websiteId, 'website_id');
    const website = await websiteRegistry.getWebsite(normalizedWebsiteId);
    if (!website) {
      throw new WebsiteBackupError('website_not_found', 'Website not found', 404);
    }
    if (localServerId && website.serverId !== localServerId) {
      throw new WebsiteBackupError('website_server_mismatch', 'Website belongs to a different server', 404);
    }
    return website;
  }

  async function resolveTargetRepository(repositoryId, serverId) {
    const normalizedRepoId = normalizeUuid(repositoryId, 'repository_id');
    const repository = await resticRepositoryRegistry.getRepository(normalizedRepoId);
    if (!repository) {
      throw new WebsiteBackupError('repository_not_found', 'Restic repository not found', 404);
    }
    if (repository.serverId !== serverId) {
      throw new WebsiteBackupError('repository_server_mismatch', 'Repository belongs to a different server', 404);
    }
    const password = await resticRepositoryRegistry.revealPassword(normalizedRepoId);
    return { repository, password };
  }

  async function previewBackup({ websiteId, repositoryId, executionJobId = null } = {}) {
    const website = await resolveTargetWebsite(websiteId);
    await assertIdle(website.id, website.serverId, executionJobId);
    const { repository } = await resolveTargetRepository(repositoryId, website.serverId);

    const backupSet = await websiteBackupSetProvider.getWebsiteBackupSet({
      websiteId: website.id,
      serverId: website.serverId,
    });

    const confirmation = `backup:${website.id}:${repository.id}:${backupSet.digest}`;

    return Object.freeze({
      websiteId: website.id,
      websiteName: website.name,
      primaryDomain: backupSet.website?.primaryDomain ?? null,
      repositoryId: repository.id,
      repositoryName: repository.name,
      backupSetDigest: backupSet.digest,
      targetPaths: backupSet.targetPaths,
      excludePatterns: backupSet.excludePatterns,
      tags: backupSet.tags,
      databases: Object.freeze(backupSet.databases.map((db) => db.databaseName)),
      composeHooksEnabled: backupSet.composeHooks?.enabled ?? false,
      confirmation,
    });
  }

  async function executeBackup({
    websiteId,
    repositoryId,
    expectedPreviewDigest = null,
    confirmation = null,
    tags = [],
    executionJobId = null,
    operationId = null,
  } = {}) {
    const website = await resolveTargetWebsite(websiteId);
    await assertIdle(website.id, website.serverId, executionJobId);
    const { repository, password } = await resolveTargetRepository(repositoryId, website.serverId);

    const backupSet = await websiteBackupSetProvider.getWebsiteBackupSet({
      websiteId: website.id,
      serverId: website.serverId,
    });

    if (expectedPreviewDigest && expectedPreviewDigest !== backupSet.digest) {
      throw new WebsiteBackupError(
        'backup_preview_stale',
        'Website configuration changed after preview was generated',
        409,
      );
    }

    if (confirmation && confirmation !== `backup:${website.id}:${repository.id}:${backupSet.digest}`) {
      throw new WebsiteBackupError(
        'backup_confirmation_invalid',
        'Backup confirmation does not match the current backup set digest',
        409,
      );
    }

    const userTags = Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0) : [];
    if (userTags.some((tag) => /^(website|server|domain|runtime|operation|backup-set):/i.test(tag))) throw new WebsiteBackupError('backup_tag_reserved', 'Backup ownership tags cannot be supplied by the caller', 400);
    if (operationId != null && !/^[a-f0-9-]{36}(?::pre)?$/.test(operationId)) throw new WebsiteBackupError('backup_operation_invalid', 'Backup operation identity is invalid', 400);
    const combinedTags = [...new Set([...backupSet.tags, ...userTags,
      ...(operationId ? [`operation:${operationId}`, `backup-set:${backupSet.digest}`] : [])])].sort();

    let stagedCreated = false;
    let composePaused = false;

    try {
      // 1. Pre-hooks: staging directory
      if (backupSet.stagedRoot) {
        // A crashed previous dump must never be reused as today's database backup.
        await rmFn(backupSet.stagedRoot, { recursive: true, force: true });
        await mkdirFn(backupSet.stagedRoot, { recursive: true, mode: 0o700 });
        stagedCreated = true;
      }

      // 2. Pre-hooks: Database vendor dump
      if (Array.isArray(backupSet.databases)) {
        for (const db of backupSet.databases) {
          if (db.dumpHook?.stagedBackupDirectory) {
            if (!databaseBackupAdapter) throw new WebsiteBackupError('backup_database_adapter_unavailable', 'Native database backup adapter is unavailable', 503);
            await databaseBackupAdapter.backup(backupSet, db);
            continue;
          }
          if (db.dumpHook?.program && db.dumpHook?.stagedDumpPath) {
            await mkdirFn(path.dirname(db.dumpHook.stagedDumpPath), { recursive: true, mode: 0o700 });
            try {
              const res = await runCommand(db.dumpHook.program, [...db.dumpHook.args]);
              const dumpContent = res?.stdout ?? res ?? '';
              await writeFileFn(db.dumpHook.stagedDumpPath, dumpContent, { mode: 0o600 });
            } catch (err) {
              throw new WebsiteBackupError(
                'backup_database_dump_failed',
                `Database dump failed for database '${db.databaseName}': ${err.message}`,
                500,
              );
            }
          }
        }
      }

      for (const mail of backupSet.mail ?? []) {
        if (mail.managementMode !== 'local') continue;
        if (!mailBackupAdapter) throw new WebsiteBackupError('backup_mail_adapter_unavailable', 'Native mail backup adapter is unavailable', 503);
        await mailBackupAdapter.capture(backupSet, mail);
      }

      // 3. Pre-hooks: Environment metadata
      if (backupSet.env?.stagedMetadataPath) {
        if (!environmentBackupAdapter) throw new WebsiteBackupError('backup_environment_adapter_unavailable', 'Ortam değişkenleri yedeği hazırlanamıyor', 503);
        await environmentBackupAdapter.capture(backupSet);
      }

      // 4. Pre-hooks: Nginx vhost configs
      if (Array.isArray(backupSet.nginx)) {
        for (const n of backupSet.nginx) {
          if (n.stagedConfigPath && n.configPath) {
            if (hostingBackupAdapter) { await hostingBackupAdapter.capture(backupSet, n); continue; }
            await mkdirFn(path.dirname(n.stagedConfigPath), { recursive: true, mode: 0o700 });
            try {
              const cfg = await readFileFn(n.configPath, 'utf8');
              if (typeof cfg !== 'string' || !cfg.trim()) throw new Error('backup_nginx_config_empty');
              await writeFileFn(n.stagedConfigPath, cfg, { mode: 0o640 });
            } catch {
              throw new WebsiteBackupError('backup_nginx_config_unavailable', 'Site Nginx yapılandırması yedeklenemedi; yedek tamamlandı sayılmadı', 503);
            }
          }
        }
      }

      // 5. Pre-hooks: DNS zone snapshots
      if (Array.isArray(backupSet.dns)) {
        for (const d of backupSet.dns) {
          if (d.stagedZonePath) {
            if (dnsBackupAdapter) { await dnsBackupAdapter.capture(backupSet, d); continue; }
            await mkdirFn(path.dirname(d.stagedZonePath), { recursive: true, mode: 0o700 });
            await writeFileFn(d.stagedZonePath, JSON.stringify({ version: 1, kind: 'external-reference', captured: false,
              reference: d, reason: 'authoritative_backup_adapter_unavailable' }, null, 2), { mode: 0o600 });
          }
        }
      }

      // 6. Pre-hooks: Compose pause (quiesce)
      if (backupSet.composeHooks?.enabled && backupSet.composeHooks.preHook) {
        try {
          await runCommand(backupSet.composeHooks.preHook.command, [...backupSet.composeHooks.preHook.args]);
          composePaused = true;
        } catch (err) {
          throw new WebsiteBackupError(
            'backup_compose_quiesce_failed',
            `Docker Compose pause failed: ${err.message}`,
            500,
          );
        }
      }

      // 7. Execute restic snapshot
      const snapshotReceipt = await resticManager.createSnapshot({
        repository: repository.target,
        password,
        paths: backupSet.targetPaths,
        excludes: backupSet.excludePatterns,
        tags: combinedTags,
      });
      if ((backupSet.mail ?? []).some(mail => mail.managementMode === 'local')) {
        if (typeof resticManager.listSnapshotFiles !== 'function' || typeof mailBackupAdapter?.verifySnapshot !== 'function') {
          throw new WebsiteBackupError('backup_mail_snapshot_verification_unavailable', 'Posta snapshot içeriği doğrulanamadı', 503);
        }
        const nodes = await resticManager.listSnapshotFiles({ repository: repository.target, password, snapshotId: snapshotReceipt.snapshotId });
        await mailBackupAdapter.verifySnapshot(backupSet, nodes);
      }

      return Object.freeze({
        status: 'succeeded',
        websiteId: website.id,
        repositoryId: repository.id,
        snapshot: snapshotReceipt,
        backupSetDigest: backupSet.digest,
        createdAt: new Date().toISOString(),
      });
    } finally {
      // Post-hooks: Compose unpause
      if (composePaused && backupSet.composeHooks?.postHook) {
        try {
          await runCommand(backupSet.composeHooks.postHook.command, [...backupSet.composeHooks.postHook.args]);
        } catch {
          // ignore unpause error on cleanup
        }
      }

      // Post-hooks: Clean up staged directory
      if (stagedCreated && backupSet.stagedRoot) {
        try {
          await rmFn(backupSet.stagedRoot, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  return Object.freeze({
    previewBackup,
    executeBackup,
  });
}
