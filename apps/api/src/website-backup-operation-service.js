import { OPERATIONS } from '@yunpanel/protocol';
import { WebsiteBackupOperationRegistryError } from './website-backup-operation-registry.js';
import { WebsiteBackupError } from './website-backup-service.js';
import { WebsiteRestoreError } from './website-restore-service.js';
import { compileBackupSchedule } from './backup-schedule-time.js';
import { normalizeWebsiteBackupScheduleAuthorization } from './website-backup-schedule-authorization.js';

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
    || error instanceof WebsiteBackupError || error instanceof WebsiteRestoreError;
}

const ACTIVE = new Set(['queued', 'running']);
const MESSAGES = { backup: 'Site yedekleniyor', restore: 'Site geri yükleniyor', check: 'Depo denetleniyor', plan: 'Saklama kuralları kaydediliyor' };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function createWebsiteBackupOperationService({
  registry, websiteBackupService = null, websiteRestoreService = null, websiteRegistry = null,
  resticRepositoryRegistry = null, resticManager = null, receiptStore = null,
  durableJobRegistry = null, jobRegistry = null, backupOperationRegistry = null,
  authorizeActor = null, siteMutationLock = null,
  websiteBackupSetProvider = null,
  databaseBackupAdapter = null,
  mailBackupAdapter = null,
  environmentBackupAdapter = null,
  dnsBackupAdapter = null,
  hostingBackupAdapter = null,
  backupScheduleRegistry = null, authorizeScheduledActor = null, getAutomationUser = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!registry || !['createOperation', 'getOperation', 'getExecutionOperation', 'listOperations', 'updateOperation'].every((method) => typeof registry[method] === 'function')) {
    throw new WebsiteBackupOperationServiceError('website_backup_dependencies_invalid', 'Website backup operation registry is required', 503);
  }

  function assertRuntime() {
    if (typeof jobRegistry?.enqueue !== 'function' || typeof websiteRegistry?.getWebsite !== 'function'
      || typeof authorizeActor !== 'function' || typeof siteMutationLock?.withSiteLock !== 'function') {
      throw new WebsiteBackupOperationServiceError('website_backup_runtime_unavailable', 'Kalıcı yedekleme kuyruğu kullanılamıyor', 503);
    }
  }

  async function target(websiteId, repositoryId) {
    const website = await websiteRegistry.getWebsite(websiteId);
    const repository = await resticRepositoryRegistry?.getRepository(repositoryId);
    if (!website || !repository || website.serverId !== repository.serverId) {
      throw new WebsiteBackupOperationServiceError('website_backup_target_invalid', 'Site ve yedekleme deposu eşleşmiyor', 404);
    }
    return website;
  }

  async function liveActor(actor, websiteId) {
    if (actor?.kind === 'website_backup_schedule') {
      const grant = normalizeWebsiteBackupScheduleAuthorization(Object.fromEntries(['kind', 'scheduleId', 'scheduleRevision', 'websiteId', 'serverId', 'userId', 'actorId', 'role'].map(key => [key, actor[key]])));
      if (grant.websiteId !== websiteId || typeof authorizeScheduledActor !== 'function' || await authorizeScheduledActor(grant) !== true) throw new WebsiteBackupOperationServiceError('website_backup_schedule_actor_forbidden', 'Otomatik yedekleme izni veya hedefi değişti', 403);
      return { ...grant, sessionId: null };
    }
    if (!actor || ![actor.sessionId, actor.userId].every((id) => typeof id === 'string' && UUID.test(id))) {
      throw new WebsiteBackupOperationServiceError('website_backup_actor_forbidden', 'Yedekleme için aktif panel oturumu gerekiyor', 403);
    }
    const current = await authorizeActor(actor, websiteId);
    if (!current || ['sessionId', 'userId', 'role'].some((key) => current[key] !== actor[key])) {
      throw new WebsiteBackupOperationServiceError('website_backup_actor_forbidden', 'Site erişimi değişti; işlem durduruldu', 403);
    }
    return { sessionId: current.sessionId, userId: current.userId, role: current.role };
  }

  async function update(id, patch) {
    const operation = await registry.updateOperation(id, patch);
    if (typeof backupOperationRegistry?.updateWebsiteOperation === 'function') await backupOperationRegistry.updateWebsiteOperation(id, patch);
    return operation;
  }

  async function enqueue(input, actor) {
    assertRuntime();
    const website = await target(input.websiteId, input.repositoryId);
    const identity = { websiteId: website.id, applicationId: website.applicationId ?? null };
    return siteMutationLock.withSiteLock(identity, async () => {
      const current = await target(website.id, input.repositoryId);
      if (current.applicationId !== website.applicationId || current.revision !== website.revision) {
        throw new WebsiteBackupOperationServiceError('website_backup_target_stale', 'Site değişti; önizlemeyi yenileyin', 409);
      }
      const owner = await liveActor(actor, website.id);
      const active = (await registry.listOperations({ websiteId: website.id })).find((operation) => ACTIVE.has(operation.status));
      if (active) {
        const stored = await registry.getExecutionOperation(active.id);
        if (stored.kind === input.kind && stored.repositoryId === input.repositoryId && stored.previewDigest === (input.previewDigest ?? '0'.repeat(64))
          && stored.actor?.sessionId === owner.sessionId && stored.actor?.userId === owner.userId && stored.jobId
          && JSON.stringify(stored.include) === JSON.stringify(input.include ?? [])
          && JSON.stringify(stored.tags) === JSON.stringify(input.tags ?? []) && JSON.stringify(stored.options) === JSON.stringify(input.options ?? {})) return active;
        throw new WebsiteBackupOperationServiceError('website_backup_operation_conflict', 'Bu sitede devam eden bir yedekleme işlemi var', 409);
      }
      const operation = await registry.createOperation({ ...input, serverId: website.serverId, actor: owner });
      let attemptedEnqueue = false, queuedJob = null;
      try {
        if (typeof backupOperationRegistry?.recordWebsiteOperation === 'function') await backupOperationRegistry.recordWebsiteOperation(operation);
        attemptedEnqueue = true;
        const job = queuedJob = await jobRegistry.enqueue({ serverId: website.serverId,
          type: OPERATIONS.WEBSITE_BACKUP_ACTION, operation: OPERATIONS.WEBSITE_BACKUP_ACTION,
          resourceType: 'backup', resourceId: operation.id,
          payload: { operationId: operation.id, websiteId: website.id, actorSessionId: owner.sessionId, actorUserId: owner.userId, actorRole: owner.role,
            ...(owner.kind === 'website_backup_schedule' ? { actorScheduleId: owner.scheduleId, actorScheduleRevision: owner.scheduleRevision } : {}) },
          authorization: owner.kind === 'website_backup_schedule'
            ? normalizeWebsiteBackupScheduleAuthorization(Object.fromEntries(['kind', 'scheduleId', 'scheduleRevision', 'websiteId', 'serverId', 'userId', 'actorId', 'role'].map(key => [key, owner[key]])))
            : { kind: 'panel', actorId: owner.userId, userId: owner.userId, sessionId: owner.sessionId, role: owner.role, websiteId: website.id },
          idempotencyKey: `website.backup:${operation.id}`,
        });
        return await update(operation.id, { jobId: job.id });
      } catch (error) {
        // An audit/link write can fail after the native queue committed. Never
        // turn that committed job into a terminal failed operation or enqueue it again.
        if (attemptedEnqueue && !queuedJob && typeof jobRegistry.getJobForIdempotencyKey === 'function') {
          try { queuedJob = await jobRegistry.getJobForIdempotencyKey(`website.backup:${operation.id}`); }
          catch { throw new WebsiteBackupOperationServiceError('website_backup_queue_unconfirmed', 'İşlem kaydı doğrulanamadı. Yeni işlem başlatmadan kayıtları yenileyin', 503); }
        }
        if (queuedJob) {
          if (queuedJob.resourceId !== operation.id || queuedJob.payload?.websiteId !== website.id) throw new WebsiteBackupOperationServiceError('website_backup_execution_invalid', 'Kuyruk kaydı hedefle eşleşmiyor', 409);
          try { return await update(operation.id, { jobId: queuedJob.id }); }
          catch { throw new WebsiteBackupOperationServiceError('website_backup_queue_unconfirmed', 'İşlem kuyruğa alındı; kayıt bağlantısı yeniden kontrol edilmeli', 503); }
        }
        await update(operation.id, { status: 'failed', error: { code: 'website_backup_queue_failed', message: 'İşlem kalıcı kuyruğa kaydedilemedi' }, finishedAt: now() });
        throw error;
      }
    });
  }

  function verifyPreview(input, preview, kind) {
    const digest = kind === 'backup' ? preview.backupSetDigest : preview.previewDigest;
    if (!input.expectedPreviewDigest || input.expectedPreviewDigest !== digest) {
      throw new WebsiteBackupOperationServiceError(`${kind}_preview_stale`, 'Site değişti; önizlemeyi yenileyin', 409);
    }
    if (!input.confirmation || input.confirmation !== preview.confirmation) {
      throw new WebsiteBackupOperationServiceError(`${kind}_confirmation_invalid`, 'İşlem onayı önizlemeyle eşleşmiyor', 409);
    }
    return digest;
  }

  async function existingRequest(input, kind) {
    assertRuntime();
    await liveActor(input.actor, input.websiteId);
    const active = (await registry.listOperations({ websiteId: input.websiteId })).find(operation => ACTIVE.has(operation.status));
    if (!active) return null;
    const stored = await registry.getExecutionOperation(active.id);
    if (stored.kind === kind && stored.repositoryId === input.repositoryId && stored.previewDigest === input.expectedPreviewDigest
      && stored.confirmation === input.confirmation && stored.actor?.sessionId === input.actor.sessionId
      && stored.actor?.userId === input.actor.userId && stored.jobId
      && (kind !== 'restore' || (stored.snapshotId === input.snapshotId && JSON.stringify(stored.include) === JSON.stringify(input.include ?? [])))
      && (kind !== 'backup' || JSON.stringify(stored.tags) === JSON.stringify(input.tags ?? []))) return active;
    return null;
  }

  async function queueBackup(input = {}) {
    if (typeof websiteBackupService?.previewBackup !== 'function') throw new WebsiteBackupOperationServiceError('website_backup_runtime_unavailable', 'Yedekleme motoru kullanılamıyor', 503);
    if (input.actor && input.expectedPreviewDigest && input.confirmation) {
      const previous = await existingRequest(input, 'backup'); if (previous) return previous;
    }
    const preview = await websiteBackupService.previewBackup(input);
    const digest = verifyPreview(input, preview, 'backup');
    if (!Array.isArray(input.tags ?? []) || (input.tags ?? []).some((tag) => typeof tag !== 'string' || /^(website|server|domain|runtime|operation|backup-set):/i.test(tag))) {
      throw new WebsiteBackupOperationServiceError('backup_tag_reserved', 'Yedek sahiplik etiketleri değiştirilemez');
    }
    return enqueue({ websiteId: input.websiteId, repositoryId: input.repositoryId, kind: 'backup', previewDigest: digest, confirmation: input.confirmation, tags: input.tags ?? [] }, input.actor);
  }

  async function queueRestore(input = {}) {
    if (typeof websiteRestoreService?.previewRestore !== 'function') throw new WebsiteBackupOperationServiceError('website_restore_runtime_unavailable', 'Geri yükleme motoru kullanılamıyor', 503);
    if (input.actor && input.expectedPreviewDigest && input.confirmation) {
      const previous = await existingRequest(input, 'restore'); if (previous) return previous;
    }
    const preview = await websiteRestoreService.previewRestore(input);
    const digest = verifyPreview(input, preview, 'restore');
    return enqueue({ websiteId: input.websiteId, repositoryId: input.repositoryId, kind: 'restore', snapshotId: preview.snapshotId,
      previewDigest: digest, confirmation: input.confirmation, healthPath: preview.healthSpec.healthPath,
      timeoutSeconds: preview.healthSpec.timeoutSeconds, include: input.include ?? [], selective: Boolean(preview.selective) }, input.actor);
  }

  async function queueCheck(input = {}) {
    return enqueue({ websiteId: input.websiteId, repositoryId: input.repositoryId, kind: 'check', options: { readDataSubset: input.readDataSubset ?? null } }, input.actor);
  }

  async function queuePlan(input = {}) {
    let schedule = null;
    if (input.schedule != null) {
      if (!backupScheduleRegistry || !getAutomationUser) throw new WebsiteBackupOperationServiceError('website_backup_schedule_unavailable', 'Otomatik zamanlama motoru henüz hazır değil', 503);
      const normalized = compileBackupSchedule(typeof input.schedule === 'string' ? input.schedule : input.schedule.expression,
        typeof input.schedule === 'string' ? 'Europe/Istanbul' : input.schedule.timeZone);
      const enabled = typeof input.schedule === 'string' ? true : input.schedule.enabled ?? true;
      if (typeof enabled !== 'boolean') throw new WebsiteBackupOperationServiceError('website_backup_plan_invalid', 'Zamanlama tercihi geçersiz');
      schedule = { expression: normalized.expression, timeZone: normalized.timeZone, enabled };
    }
    if (!input.retentionPolicy || typeof input.retentionPolicy !== 'object' || Array.isArray(input.retentionPolicy)) throw new WebsiteBackupOperationServiceError('website_backup_plan_invalid', 'Saklama kuralları gerekiyor');
    return enqueue({ websiteId: input.websiteId, repositoryId: input.repositoryId, kind: 'plan', options: { retentionPolicy: input.retentionPolicy, ...(schedule ? { schedule } : {}) } }, input.actor);
  }

  async function queueScheduled(schedule, operationId) {
    const grant = { kind: 'website_backup_schedule', scheduleId: schedule.id, scheduleRevision: schedule.revision, websiteId: schedule.websiteId,
      serverId: schedule.serverId, userId: schedule.creatorId, actorId: schedule.creatorId, role: schedule.creatorRole };
    await liveActor(grant, schedule.websiteId);
    const existing = await registry.getExecutionOperation(operationId);
    if (existing) {
      if (existing.websiteId !== schedule.websiteId || existing.repositoryId !== schedule.repositoryId || existing.actor?.scheduleId !== schedule.id
        || existing.actor.scheduleRevision !== schedule.revision) throw new WebsiteBackupOperationServiceError('backup_schedule_operation_conflict', 'Zamanlama işi farklı bir kayıtla çakışıyor', 409);
      if (!existing.jobId) {
        const committed = typeof jobRegistry.getJobForIdempotencyKey === 'function' ? await jobRegistry.getJobForIdempotencyKey(`website.backup:${operationId}`) : null;
        if (!committed || committed.payload?.operationId !== operationId || committed.payload.websiteId !== schedule.websiteId) throw new WebsiteBackupOperationServiceError('backup_schedule_enqueue_recovery_required', 'Kesilen zamanlama kuyruğu denetlenmeden tekrar yürütülemez', 503);
        await update(operationId, { jobId: committed.id });
      }
      return registry.getOperation(operationId);
    }
    const preview = await websiteBackupService.previewBackup({ websiteId: schedule.websiteId, repositoryId: schedule.repositoryId });
    return enqueue({ id: operationId, websiteId: schedule.websiteId, repositoryId: schedule.repositoryId, kind: 'backup',
      previewDigest: preview.backupSetDigest, confirmation: preview.confirmation, tags: ['scheduled-backup'] }, grant);
  }

  function resultFor(operation) {
    return { version: 1, operationId: operation.id, websiteId: operation.websiteId, repositoryId: operation.repositoryId,
      kind: operation.kind, status: operation.status, snapshotId: operation.snapshotId ?? null, preRestoreSnapshotId: operation.preRestoreSnapshotId ?? null,
      verified: true, sideEffects: operation.kind !== 'check' };
  }

  async function execute(payload, context) {
    assertRuntime();
    if (!payload || typeof payload !== 'object') throw new WebsiteBackupOperationServiceError('website_backup_execution_invalid', 'Yedekleme işi geçersiz', 409);
    const operation = await registry.getExecutionOperation(payload.operationId);
    if (!operation || operation.websiteId !== payload.websiteId || operation.serverId !== context?.serverId
      || context.resourceType !== 'backup' || context.resourceId !== operation.id
      || (operation.jobId && operation.jobId !== context.jobId)
      || !operation.actor || operation.actor.sessionId !== payload.actorSessionId || operation.actor.userId !== payload.actorUserId || operation.actor.role !== payload.actorRole) {
      throw new WebsiteBackupOperationServiceError('website_backup_execution_invalid', 'Yedekleme işi kayıtla eşleşmiyor', 409);
    }
    if (operation.actor.kind === 'website_backup_schedule' && (operation.actor.scheduleId !== payload.actorScheduleId || operation.actor.scheduleRevision !== payload.actorScheduleRevision)) throw new WebsiteBackupOperationServiceError('website_backup_execution_invalid', 'Zamanlama işi izin kaydıyla eşleşmiyor', 409);
    const website = await target(operation.websiteId, operation.repositoryId);
    return siteMutationLock.withSiteLock({ websiteId: website.id, applicationId: website.applicationId ?? null }, async () => {
      await liveActor(operation.actor, website.id);
      if (['succeeded', 'rolled_back'].includes(operation.status)) return resultFor(operation);
      if (!ACTIVE.has(operation.status)) throw new WebsiteBackupOperationServiceError('website_backup_execution_terminal', 'Bu işlem tamamlandı; tekrar yürütülemez', 409);
      const startedAt = now();
      await update(operation.id, { status: 'running', jobId: context.jobId, startedAt,
        progress: { phase: 'running', percent: null, message: MESSAGES[operation.kind] },
        steps: operation.steps.map((step, index) => ({ ...step, status: index === 0 ? 'running' : 'pending', updatedAt: startedAt })) });
      try {
        const common = { websiteId: operation.websiteId, repositoryId: operation.repositoryId, expectedPreviewDigest: operation.previewDigest,
          confirmation: operation.confirmation, executionJobId: context.jobId, operationId: operation.id };
        let result;
        if (operation.kind === 'backup') {
          const plan = await backupScheduleRegistry?.getByWebsite?.(website.id);
          const retentionPolicy = plan?.repositoryId === operation.repositoryId ? plan.retentionPolicy : null;
          if (retentionPolicy) await update(operation.id, { options: { ...operation.options, retentionPolicy } });
          result = await websiteBackupService.executeBackup({ ...common, tags: operation.tags });
          if (result?.status !== 'succeeded' || !result.snapshot?.snapshotId) throw new WebsiteBackupOperationServiceError('backup_execution_unverified', 'Yedek dosyası doğrulanamadı', 502);
          if (retentionPolicy) {
            await update(operation.id, { snapshotId: result.snapshot.snapshotId, result,
              progress: { phase: 'retention', percent: null, message: 'Sitenin eski yedekleri saklama kuralına göre kontrol ediliyor' } });
            await liveActor(operation.actor, website.id);
            if (typeof resticRepositoryRegistry.applyRetention !== 'function') throw new WebsiteBackupOperationServiceError('backup_retention_unavailable', 'Yedek alındı ancak saklama kuralı uygulanamadı', 503);
            result = { ...result, retention: await resticRepositoryRegistry.applyRetention(operation.repositoryId, {
              policy: retentionPolicy, tags: [`website:${website.id}`], prune: false }) };
            await update(operation.id, { result: { ...result, retention: { ...result.retention, status: 'completed' } } });
          }
        } else if (operation.kind === 'restore') {
          result = await websiteRestoreService.executeRestore({ ...common, snapshotId: operation.snapshotId, include: operation.include,
            healthPath: operation.healthPath, timeoutSeconds: operation.timeoutSeconds });
          if (!['succeeded', 'rolled_back'].includes(result?.status) || !result.preRestoreSnapshotId
            || (result.status === 'succeeded' && result.healthCheck?.satisfied !== true)) throw new WebsiteBackupOperationServiceError('restore_execution_unverified', 'Geri yükleme doğrulanamadı', 502);
        } else if (operation.kind === 'check') {
          if (typeof resticRepositoryRegistry.checkResticRepository !== 'function') throw new WebsiteBackupOperationServiceError('website_backup_runtime_unavailable', 'Depo kontrol motoru kullanılamıyor', 503);
          await resticRepositoryRegistry.checkResticRepository(operation.repositoryId, operation.options);
          result = { status: 'succeeded', checkedAt: now() };
        } else {
          if (backupScheduleRegistry && getAutomationUser) {
            const user = await getAutomationUser(operation.actor.userId);
            if (!user || user.role !== operation.actor.role || user.role !== 'owner') throw new WebsiteBackupOperationServiceError('website_backup_schedule_actor_forbidden', 'Yedekleme planının sahibinin erişimi değişti', 403);
            const existing = await backupScheduleRegistry.getByWebsite(website.id);
            const saved = await backupScheduleRegistry.save({ websiteId: operation.websiteId, serverId: operation.serverId, repositoryId: operation.repositoryId,
              creatorId: user.id, creatorRole: user.role, creatorRevision: user.revision, creatorPasswordChangedAt: user.passwordChangedAt,
              expression: existing?.expression ?? '0 2 * * *', timeZone: existing?.timeZone ?? 'Europe/Istanbul', enabled: existing?.enabled ?? false,
              ...operation.options.schedule, retentionPolicy: operation.options.retentionPolicy });
            result = { status: 'succeeded', retentionPolicy: saved.retentionPolicy, configuredAt: now(),
              schedule: { expression: saved.expression, timeZone: saved.timeZone, nextRunAt: saved.enabled ? saved.nextRunAt : null, enabled: saved.enabled } };
          } else {
          if (typeof resticRepositoryRegistry.updateRepository !== 'function') throw new WebsiteBackupOperationServiceError('website_backup_runtime_unavailable', 'Saklama kuralları kaydedilemiyor', 503);
          const changed = await resticRepositoryRegistry.updateRepository(operation.repositoryId, operation.options);
          if (JSON.stringify(changed.retentionPolicy) !== JSON.stringify(operation.options.retentionPolicy)) throw new WebsiteBackupOperationServiceError('website_backup_plan_unverified', 'Saklama kuralları doğrulanamadı', 502);
          result = { status: 'succeeded', retentionPolicy: changed.retentionPolicy, configuredAt: now() };
          if (operation.options.schedule) {
            const user = await getAutomationUser(operation.actor.userId);
            if (!user || user.role !== operation.actor.role || user.role !== 'owner') throw new WebsiteBackupOperationServiceError('website_backup_schedule_actor_forbidden', 'Zamanlama sahibinin erişimi değişti', 403);
            const saved = await backupScheduleRegistry.save({ websiteId: operation.websiteId, serverId: operation.serverId, repositoryId: operation.repositoryId,
              creatorId: user.id, creatorRole: user.role, creatorRevision: user.revision, creatorPasswordChangedAt: user.passwordChangedAt,
              ...operation.options.schedule });
            result.schedule = { expression: saved.expression, timeZone: saved.timeZone, nextRunAt: saved.nextRunAt, enabled: saved.enabled };
          }
          }
        }
        await liveActor(operation.actor, website.id);
        const finishedAt = now();
        const completed = await update(operation.id, { status: result.status, snapshotId: result.snapshot?.snapshotId ?? operation.snapshotId,
          preRestoreSnapshotId: result.preRestoreSnapshotId ?? null, result, finishedAt,
          progress: { phase: result.status, percent: null, message: result.status === 'rolled_back' ? 'Sağlık kontrolü başarısız; önceki durum geri alındı' : 'İşlem doğrulanarak tamamlandı' },
          steps: operation.steps.map((step) => ({ ...step, status: result.status === 'rolled_back' && step.name === 'health_check' ? 'rolled_back' : 'succeeded', updatedAt: finishedAt })) });
        return resultFor(completed);
      } catch (error) {
        await update(operation.id, { status: 'failed', error: { code: /^[a-z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'website_backup_execution_failed',
          message: 'İşlem tamamlanamadı; kayıtlı hata ve geri alma durumunu kontrol edin' }, finishedAt: now(), progress: { phase: 'failed', percent: null, message: 'İşlem tamamlanamadı' } });
        throw error;
      }
    });
  }

  async function getOperation(id) {
    const operation = await registry.getOperation(id);
    if (!operation) throw new WebsiteBackupOperationServiceError('website_backup_operation_not_found', 'Yedekleme işlemi bulunamadı', 404);
    // A job cancelled before execution must not leave the UI queued indefinitely.
    if (ACTIVE.has(operation.status) && operation.jobId && typeof jobRegistry?.getJob === 'function') {
      const job = await jobRegistry.getJob(operation.jobId);
      if (['failed', 'cancelled'].includes(job?.status)) return update(id, { status: 'failed', error: { code: job.error?.code ?? 'website_backup_job_cancelled', message: 'Yedekleme işi durduruldu' }, finishedAt: job.finishedAt ?? now() });
    }
    return operation;
  }

  async function reconcile({ receiptStore: override = null } = {}) {
    const operations = await registry.reconcileInterruptedOperations({ resticManager, resticRepositoryRegistry, receiptStore: override ?? receiptStore,
      websiteRegistry, websiteBackupSetProvider, jobRegistry, siteMutationLock, databaseBackupAdapter, mailBackupAdapter, environmentBackupAdapter, dnsBackupAdapter, hostingBackupAdapter });
    for (const operation of operations) {
      if (typeof backupOperationRegistry?.recordWebsiteOperation === 'function') await backupOperationRegistry.recordWebsiteOperation(operation);
    }
    return operations;
  }

  async function recoverStartup() {
    assertRuntime();
    const operations = await reconcile();
    for (const operation of operations) {
      if (!operation.jobId) continue;
      const job = await jobRegistry.getJob(operation.jobId);
      if (job?.status !== 'running') continue;
      if (job.operation !== OPERATIONS.WEBSITE_BACKUP_ACTION || job.payload?.operationId !== operation.id
        || job.payload?.websiteId !== operation.websiteId || job.serverId !== operation.serverId) throw new WebsiteBackupOperationServiceError('website_backup_recovery_identity_invalid', 'Recovery job does not match the operation', 409);
      await jobRegistry.beginReconciliation({ serverId: job.serverId, jobId: job.id });
      await jobRegistry.complete({ serverId: job.serverId, jobId: job.id, status: operation.status === 'failed' ? 'failed' : 'succeeded',
        result: operation.status === 'failed' ? null : resultFor(operation), error: operation.status === 'failed' ? operation.error : null });
      await jobRegistry.acknowledgeReconciliation({ serverId: job.serverId, jobId: job.id });
    }
    return operations;
  }

  return Object.freeze({ queueBackup, queueRestore, queueCheck, queuePlan, queueScheduled, execute, getOperation,
    listOperations: (filter) => registry.listOperations(filter), reconcile, recoverStartup, resultFor,
    registry, durableJobRegistry, jobRegistry, backupOperationRegistry });
}
