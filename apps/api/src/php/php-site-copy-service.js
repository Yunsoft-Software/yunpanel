import { OPERATIONS } from '@yunpanel/protocol';
import { jobPublicView } from '../jobs/job-registry.js';
import { safeLocalOperationError } from '../runtime/local-execution-error.js';

const OPERATION = OPERATIONS.WEBSITE_PHP_COPY;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const requestKey = (id) => `php-copy:${id}`;
const confirm = (source, target, digest) => `php-copy:${source}:${target}:${digest}`;

export function createPhpSiteCopyService({ localServerId, transfer, jobRegistry, durableJobRegistry, authorizeActor }) {
  async function requireAccess(actor, ...sites) {
    if (actor?.role !== 'owner' || !UUID.test(actor.sessionId ?? '') || !UUID.test(actor.userId ?? '')) {
      throw fail('php_copy_forbidden', 'PHP sitesi kopyalamak için yönetici erişimi gerekir.', 403);
    }
    for (const websiteId of sites) {
      if (!UUID.test(websiteId ?? '')) throw fail('php_copy_request_invalid', 'Site kimliği geçersiz.', 400);
      if (await authorizeActor(actor, websiteId) !== true) {
        throw fail('php_copy_forbidden', 'Kaynak ve hedef siteye erişim gerekir.', 403);
      }
    }
  }

  async function plan(websiteId, targetWebsiteId, actor) {
    await requireAccess(actor, websiteId, targetWebsiteId);
    try { return await transfer.preview({ sourceWebsiteId: websiteId, targetWebsiteId }); }
    catch (error) {
      if (typeof error?.code !== 'string' || !error.code.startsWith('site_database_copy_')) throw error;
      const safe = safeLocalOperationError(error);
      throw fail(safe.code, safe.message);
    }
  }

  async function preview(websiteId, input, actor) {
    if (!exact(input, ['targetWebsiteId'])) throw fail('php_copy_request_invalid', 'Bir hedef site seçin.', 400);
    const { site, inventory, digest } = await plan(websiteId, input.targetWebsiteId, actor);
    return { targetWebsiteId: site.target.websiteId, files: 1, bytes: site.files[0].bytes, tables: inventory.sourceTables,
      previewDigest: digest, confirmation: confirm(websiteId, site.target.websiteId, digest) };
  }

  function matches(job, websiteId, actor) {
    return job?.serverId === localServerId && job.operation === OPERATION && job.resourceType === 'application'
      && job.payload?.websiteId === websiteId && job.payload.actorUserId === actor.userId && job.resourceId === job.payload.applicationId;
  }

  async function queue(websiteId, input, actor) {
    if (!exact(input, ['targetWebsiteId', 'requestId', 'previewDigest', 'confirmation'])
      || !UUID.test(input.requestId ?? '') || !SHA256.test(input.previewDigest ?? '')) {
      throw fail('php_copy_request_invalid', 'Kopyalama isteği geçersiz.', 400);
    }
    const { targetWebsiteId, requestId, previewDigest, confirmation } = input;
    await requireAccess(actor, websiteId, targetWebsiteId);
    const key = requestKey(requestId);
    const expected = confirm(websiteId, targetWebsiteId, previewDigest);
    const previous = await jobRegistry.getJobForIdempotencyKey(key);
    if (previous) {
      if (!matches(previous, websiteId, actor) || previous.payload.targetWebsiteId !== targetWebsiteId
        || previous.payload.previewDigest !== previewDigest || confirmation !== expected) {
        throw fail('php_copy_request_conflict', 'Bu istek kimliği farklı bir kopyaya ait.');
      }
      return { job: jobPublicView(previous) };
    }
    const { site, digest } = await plan(websiteId, targetWebsiteId, actor);
    if (digest !== previewDigest || confirmation !== expected) {
      throw fail('php_copy_preview_stale', 'Site değişti. Önizlemeyi yenileyin.');
    }
    await requireAccess(actor, websiteId, targetWebsiteId);
    const payload = { websiteId, targetWebsiteId, previewDigest, applicationId: site.source.applicationId,
      targetApplicationId: site.target.applicationId, actorSessionId: actor.sessionId, actorUserId: actor.userId, actorRole: actor.role };
    const authorization = { kind: 'panel', role: actor.role, scope: 'website', actorId: actor.userId,
      userId: actor.userId, websiteId, sessionId: actor.sessionId, serverId: localServerId };
    const job = await jobRegistry.enqueue({ serverId: localServerId, type: OPERATION, operation: OPERATION,
      payload, resourceType: 'application', resourceId: payload.applicationId, idempotencyKey: key, authorization });
    return { job: jobPublicView(job) };
  }

  async function getRequest(websiteId, requestId, actor) {
    if (!UUID.test(requestId ?? '')) throw fail('php_copy_request_invalid', 'İstek kimliği geçersiz.', 400);
    await requireAccess(actor, websiteId);
    const job = await jobRegistry.getJobForIdempotencyKey(requestKey(requestId));
    if (!matches(job, websiteId, actor)) throw fail('php_copy_request_not_found', 'Kopyalama isteği bulunamadı.', 404);
    await requireAccess(actor, job.payload.targetWebsiteId);
    return { job: jobPublicView(job) };
  }

  async function execute(payload, execution) {
    if (execution?.resourceType !== 'application' || execution.resourceId !== payload.applicationId || execution.serverId !== localServerId) {
      throw fail('php_copy_execution_scope_invalid', 'Kopyalama işi bu kaynakla eşleşmiyor.');
    }
    const actor = { role: payload.actorRole, userId: payload.actorUserId, sessionId: payload.actorSessionId };
    const current = await plan(payload.websiteId, payload.targetWebsiteId, actor);
    if (current.digest !== payload.previewDigest || current.site.source.applicationId !== payload.applicationId
      || current.site.target.applicationId !== payload.targetApplicationId) {
      throw fail('php_copy_preview_stale', 'Site değişti. Önizlemeyi yenileyin.');
    }
    return transfer.copy(current, { authorize: (websiteId) => authorizeActor(actor, websiteId) });
  }

  async function recoverStartup() {
    for (const entry of durableJobRegistry.recovery()?.jobs ?? []) {
      const job = await jobRegistry.getJob(entry.jobId);
      if (job?.operation !== OPERATION || job.serverId !== localServerId) continue;
      if (job.id !== entry.jobId || job.serverId !== entry.serverId || job.resourceType !== 'application'
        || job.resourceId !== job.payload?.applicationId || !UUID.test(job.payload.targetWebsiteId ?? '')) {
        throw fail('php_copy_recovery_identity_invalid', 'Kopyalama işinin kalıcı kaydı doğrulanamadı.');
      }
      const identity = { serverId: job.serverId, jobId: job.id };
      const next = await durableJobRegistry.beginReconciliation(identity);
      if (next.status === 'running' && next.pending === true) {
        const terminal = await durableJobRegistry.complete({ ...identity, status: 'failed', result: null,
          error: { code: 'php_copy_interrupted' } });
        if (terminal.status !== 'failed') throw fail('php_copy_recovery_identity_invalid', 'Kalıcı iş sonucu doğrulanamadı.');
      }
      await durableJobRegistry.acknowledgeReconciliation(identity);
    }
  }

  return Object.freeze({ preview, queue, getRequest, execute, recoverStartup });
}
