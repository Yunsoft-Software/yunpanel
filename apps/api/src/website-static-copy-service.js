import { OPERATIONS } from '@yunpanel/protocol';
import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';
import { jobPublicView } from './job-registry.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION = OPERATIONS.WEBSITE_STATIC_COPY;
const REQUEST_FIELDS = ['targetWebsiteId', 'requestId', 'previewDigest', 'confirmation'];
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const requestKey = (requestId) => `static-copy:${requestId}`;
const confirmationFor = ({ source, target, digest }) => `static-copy:${source.websiteId}:${target.websiteId}:${digest}`;
const activeDomain = (domain) => domain?.state === 'active' && Number.isSafeInteger(domain.appliedRevision)
  && domain.appliedRevision > 0 && domain.appliedRevision === domain.desiredRevision;

export function createWebsiteStaticCopyService({ localServerId, planner, transfer, jobRegistry, durableJobRegistry,
  authorizeActor, domainRegistry, healthInspector = createWebsiteHttpHealthInspector() } = {}) {
  async function requireAccess(actor, ...websiteIds) {
    if (actor?.role !== 'owner' || !UUID.test(actor.sessionId ?? '') || !UUID.test(actor.userId ?? '')) {
      throw fail('static_copy_forbidden', 'Statik site kopyalamak için yönetici erişimi gerekir.', 403);
    }
    for (const websiteId of websiteIds) {
      if (!UUID.test(websiteId ?? '')) throw fail('static_copy_request_invalid', 'Site kimliği geçersiz.', 400);
      if (await authorizeActor(actor, websiteId) !== true) {
        throw fail('static_copy_forbidden', 'Kaynak ve hedef siteye erişim gerekir.', 403);
      }
    }
  }

  async function publishedDomain(target) {
    const candidates = (await domainRegistry.listDomains()).filter((domain) => domain.serverId === localServerId
      && domain.websiteId === target.websiteId && !domain.parentDomainId && domain.targetType === 'static'
      && domain.target?.root === target.documentRoot);
    const [domain] = candidates;
    if (candidates.length !== 1 || !activeDomain(domain)) {
      throw fail('static_copy_target_domain_unverified', 'Hedef sitenin yayın adresi doğrulanamadı.');
    }
    return domain;
  }

  async function preview(websiteId, input, actor) {
    if (!exact(input, ['targetWebsiteId'])) throw fail('static_copy_request_invalid', 'Bir hedef site seçin.', 400);
    await requireAccess(actor, websiteId, input.targetWebsiteId);
    const plan = await planner.preview({ sourceWebsiteId: websiteId, targetWebsiteId: input.targetWebsiteId });
    await publishedDomain(plan.target);
    const files = plan.files.filter((entry) => entry.type === 'file');
    return { targetWebsiteId: plan.target.websiteId, files: files.length,
      bytes: files.reduce((size, file) => size + file.bytes, 0), previewDigest: plan.digest, confirmation: confirmationFor(plan) };
  }

  function matches(job, websiteId, actor) {
    return job?.serverId === localServerId && job.operation === OPERATION && job.resourceType === 'application'
      && job.payload?.websiteId === websiteId && job.payload.actorUserId === actor.userId
      && job.resourceId === job.payload.applicationId;
  }

  async function queue(websiteId, input, actor) {
    if (!exact(input, REQUEST_FIELDS) || !UUID.test(input.requestId ?? '') || !SHA256.test(input.previewDigest ?? '')) {
      throw fail('static_copy_request_invalid', 'Kopyalama isteği geçersiz.', 400);
    }
    await requireAccess(actor, websiteId, input.targetWebsiteId);
    const key = requestKey(input.requestId);
    const previous = await jobRegistry.getJobForIdempotencyKey(key);
    if (previous) {
      const expected = confirmationFor({ source: { websiteId }, target: { websiteId: input.targetWebsiteId }, digest: input.previewDigest });
      if (!matches(previous, websiteId, actor) || previous.payload.targetWebsiteId !== input.targetWebsiteId
        || previous.payload.previewDigest !== input.previewDigest || input.confirmation !== expected) {
        throw fail('static_copy_request_conflict', 'Bu istek kimliği farklı bir kopyaya ait.');
      }
      return { job: jobPublicView(previous) };
    }
    const plan = await planner.preview({ sourceWebsiteId: websiteId, targetWebsiteId: input.targetWebsiteId });
    if (plan.digest !== input.previewDigest || confirmationFor(plan) !== input.confirmation) {
      throw fail('static_copy_preview_stale', 'Site değişti. Önizlemeyi yenileyin.');
    }
    await publishedDomain(plan.target);
    await requireAccess(actor, plan.source.websiteId, plan.target.websiteId);
    const payload = { websiteId, applicationId: plan.source.applicationId, targetWebsiteId: plan.target.websiteId,
      targetApplicationId: plan.target.applicationId, actorSessionId: actor.sessionId, actorUserId: actor.userId,
      actorRole: actor.role, previewDigest: plan.digest };
    const authorization = { kind: 'panel', role: actor.role, scope: 'website', actorId: actor.userId, userId: actor.userId,
      websiteId, sessionId: actor.sessionId, serverId: localServerId };
    const job = await jobRegistry.enqueue({ serverId: localServerId, type: OPERATION, operation: OPERATION, payload,
      resourceType: 'application', resourceId: payload.applicationId, idempotencyKey: key, authorization });
    return { job: jobPublicView(job) };
  }

  async function getRequest(websiteId, requestId, actor) {
    if (!UUID.test(requestId ?? '')) throw fail('static_copy_request_invalid', 'İstek kimliği geçersiz.', 400);
    await requireAccess(actor, websiteId);
    const job = await jobRegistry.getJobForIdempotencyKey(requestKey(requestId));
    if (!matches(job, websiteId, actor)) throw fail('static_copy_request_not_found', 'Kopyalama isteği bulunamadı.', 404);
    await requireAccess(actor, job.payload.targetWebsiteId);
    return { job: jobPublicView(job) };
  }

  async function execute(payload, execution) {
    if (execution?.resourceType !== 'application' || execution.resourceId !== payload.applicationId || execution.serverId !== localServerId) {
      throw fail('static_copy_execution_scope_invalid', 'Kopyalama işi bu kaynakla eşleşmiyor.');
    }
    const actor = { role: payload.actorRole, userId: payload.actorUserId, sessionId: payload.actorSessionId };
    await requireAccess(actor, payload.websiteId, payload.targetWebsiteId);
    const plan = await planner.preview({ sourceWebsiteId: payload.websiteId, targetWebsiteId: payload.targetWebsiteId });
    if (plan.digest !== payload.previewDigest || plan.source.applicationId !== payload.applicationId
      || plan.target.applicationId !== payload.targetApplicationId) throw fail('static_copy_preview_stale', 'Site değişti. Önizlemeyi yenileyin.');
    const domain = await publishedDomain(plan.target);
    const result = await transfer.copy(plan, { authorize: (websiteId) => authorizeActor(actor, websiteId) });
    const current = await domainRegistry.getDomain(domain.id);
    if (!activeDomain(current) || current.websiteId !== domain.websiteId || current.primaryDomain !== domain.primaryDomain
      || current.desiredRevision !== domain.desiredRevision || current.appliedRevision !== domain.appliedRevision
      || (await healthInspector.inspect({ primaryDomain: domain.primaryDomain, healthPath: '/', timeoutSeconds: 30 }))?.satisfied !== true) {
      throw fail('static_copy_target_http_unverified', 'Dosyalar aktarıldı ancak hedef site doğrulanamadı.', 502);
    }
    await requireAccess(actor, payload.websiteId, payload.targetWebsiteId);
    return result;
  }

  async function recoverStartup() {
    for (const entry of durableJobRegistry.recovery()?.jobs ?? []) {
      const job = await jobRegistry.getJob(entry.jobId);
      if (job?.operation !== OPERATION || job.serverId !== localServerId) continue;
      if (job.id !== entry.jobId || job.serverId !== entry.serverId || job.resourceType !== 'application'
        || job.resourceId !== job.payload?.applicationId || !UUID.test(job.payload.targetWebsiteId ?? '')) {
        throw fail('static_copy_recovery_identity_invalid', 'Kopyalama işinin kalıcı kaydı doğrulanamadı.');
      }
      const identity = { serverId: job.serverId, jobId: job.id };
      const begun = await durableJobRegistry.beginReconciliation(identity);
      if (begun.status === 'running' && begun.pending === true) {
        const terminal = await durableJobRegistry.complete({ ...identity, status: 'failed', result: null,
          error: { code: 'static_copy_interrupted' } });
        if (terminal.status !== 'failed') throw fail('static_copy_recovery_identity_invalid', 'Kopyalama işinin kalıcı kaydı doğrulanamadı.');
      }
      await durableJobRegistry.acknowledgeReconciliation(identity);
    }
  }

  return Object.freeze({ preview, queue, getRequest, execute, recoverStartup });
}
