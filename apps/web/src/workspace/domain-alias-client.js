import { DomainAliasError, aliasList, aliasDiff, sameAliases, aliasDomainSnapshot, assertAliasDomain } from './domain-alias-model.js';
const SHA = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const unchanged = ['primaryDomain', 'httpsMode', 'httpsRedirect', 'canonicalRedirect', 'nginxSettings'];
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function invalid() { throw new DomainAliasError('alias_response_invalid', 'Sunucunun hedef veya işlem yanıtı doğrulanamadı.'); }

// Adapts existing Domain APIs/jobs. This is not a second persistent workflow,
// authorization boundary, cross-process lock or automatic retry mechanism.
export function createDomainAliasClient({ request, waitForJob, isCurrent, onProgress = () => {}, observe = () => {} }) {
  if (typeof request !== 'function' || typeof waitForJob !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Domain alias client dependencies are required');
  const plans = new WeakSet(); const used = new WeakSet(); let pending = false;
  function check() {
    if (!isCurrent()) throw new DomainAliasError('alias_context_changed', 'Site veya oturum değişti. Sonraki adımlar durduruldu; başlamış sunucu işlerini işlem geçmişinden kontrol edin.');
  }
  async function call(path, options) { check(); const value = await request(path, options); check(); return value; }
  async function exclusive(action) {
    check();
    if (pending) throw new DomainAliasError('alias_busy', 'Bu ekranda bir işlem zaten sürüyor.');
    pending = true;
    try { return await action(); } finally { pending = false; }
  }
  const route = (domain) => `/domains/${encodeURIComponent(domain.id)}`;
  async function current(base) { return assertAliasDomain(base, await call(route(base))); }
  function progress(phase, jobId = null) { check(); onProgress({ phase, jobId }); }
  function jobMatches(job, domain, id = null) {
    if (!job || !SAFE_ID.test(job.id ?? '') || (id !== null && job.id !== id)
      || job.serverId !== domain.serverId || job.resourceType !== 'domain' || job.resourceId !== domain.id
      || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status)) invalid();
    return job;
  }
  async function job(domain, action) {
    const queued = jobMatches(await call(`${route(domain)}/${action}`, { method: 'POST', body: {} }), domain);
    progress(action, queued.id); observe(queued);
    const finished = queued.status === 'succeeded' ? queued : await waitForJob(queued.id);
    check(); jobMatches(finished, domain, queued.id);
    if (finished.status !== 'succeeded') throw new DomainAliasError('alias_job_incomplete', 'Sunucu işlemi başarıyla tamamlanmadı. İşlem kaydını kontrol edin.');
    observe(finished);
  }
  function validatePreview(base, names, preview) {
    if (!preview || preview.version !== 1 || preview.domainId !== base.id
      || preview.currentRevision !== base.desiredRevision || preview.nextRevision !== base.desiredRevision + 1
      || !SHA.test(preview.previewDigest ?? '') || preview.confirmation !== `update-domain:${base.id}:${preview.previewDigest}`
      || !sameAliases(preview.next?.aliases, names)
      || unchanged.some((key) => !equal(preview.next?.[key], base[key]))
      || preview.impact?.hostnameChanged !== true || preview.impact?.policyChanged !== false
      || preview.impact?.settingsChanged !== false || preview.impact?.requiresStageAndActivation !== true
      || preview.impact?.certificate?.id !== base.certificateId
      || preview.impact?.certificate?.detached !== (base.certificateId !== null)) invalid();
  }
  return Object.freeze({
    preview(domain, values) {
      return exclusive(async () => {
        const base = aliasDomainSnapshot(domain); const names = aliasList(values, base.primaryDomain);
        if (sameAliases(base.aliases, names)) throw new DomainAliasError('alias_no_changes', 'Kaydedilecek bir değişiklik yok.');
        await current(base);
        const changes = { aliases: [...names] };
        const preview = await call(`${route(base)}/update-preview`, { method: 'POST', body: { changes } });
        validatePreview(base, names, preview);
        const plan = freeze({ base, changes, previewDigest: preview.previewDigest, confirmation: preview.confirmation,
          nextRevision: preview.nextRevision, certificateDetached: preview.impact.certificate.detached,
          ...aliasDiff(base.aliases, names) });
        plans.add(plan); return plan;
      });
    },
    save(plan) {
      return exclusive(async () => {
        if (!plans.has(plan) || used.has(plan)) throw new DomainAliasError('alias_preview_required', 'Yeni bir değişiklik önizlemesi gerekli.');
        await current(plan.base); check(); used.add(plan);
        try {
          progress('saving');
          const result = await call(route(plan.base), { method: 'PATCH', body: {
            changes: plan.changes, previewDigest: plan.previewDigest, confirmation: plan.confirmation,
          } });
          const expected = { ...plan.base, aliases: [...plan.changes.aliases], desiredRevision: plan.nextRevision,
            certificateId: plan.certificateDetached ? null : plan.base.certificateId };
          if (result?.previewDigest !== plan.previewDigest
            || result.impact?.certificate?.detached !== plan.certificateDetached) invalid();
          assertAliasDomain(expected, result.domain);
          const verified = await current(expected);
          progress('saved'); return { domain: verified, certificateDetached: plan.certificateDetached };
        } catch (error) {
          if (error?.code === 'alias_context_changed') throw error;
          throw new DomainAliasError('alias_save_unconfirmed', 'Kaydetme isteği gönderildi ancak sonucu doğrulanamadı. Tekrar göndermeden güncel kaydı yükleyin; taslağınız korunuyor.', true);
        }
      });
    },
    apply(domain) {
      return exclusive(async () => {
        const base = aliasDomainSnapshot(domain); let dispatched = false;
        try {
          let value = await current(base);
          if (value.appliedRevision === base.desiredRevision && value.state === 'active') return { domain: value, alreadyApplied: true };
          if (value.stagedRevision !== base.desiredRevision || !SHA.test(value.stagedChecksum ?? '')) {
            progress('stage'); dispatched = true; await job(base, 'stage'); value = await current(base);
          }
          if (value.stagedRevision !== base.desiredRevision || !SHA.test(value.stagedChecksum ?? '')) invalid();
          const checksum = value.stagedChecksum;
          progress('activate'); dispatched = true; await job(base, 'activate'); value = await current(base);
          if (value.appliedRevision !== base.desiredRevision || value.state !== 'active'
            || value.stagedRevision !== base.desiredRevision || value.stagedChecksum !== checksum) invalid();
          progress('applied'); return { domain: value, alreadyApplied: false };
        } catch (error) {
          if (!dispatched || error?.code === 'alias_context_changed') throw error;
          throw new DomainAliasError('alias_apply_unconfirmed', 'Kayıt korunuyor; yayına uygulama tamamlandığı doğrulanamadı. Son işlemi ve güncel kaydı kontrol edin. Otomatik tekrar yapılmadı.', true);
        }
      });
    },
  });
}
