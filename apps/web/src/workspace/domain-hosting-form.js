import { DomainAliasError, aliasDomainFingerprint, aliasDomainSnapshot, refreshAliasPublication } from './domain-alias-model.js';
import { HOSTING_SETTING_FIELDS, hostingSettingsChanges } from './domain-hosting-model.js';

// State only: no persistence, authorization, HTTP requests or publishing here.
export function createHostingForm(domain) {
  const base = aliasDomainSnapshot(domain);
  return { base, values: Object.fromEntries(HOSTING_SETTING_FIELDS.map((key) => [key, base[key]])) };
}
export function hostingFormDirty(form) {
  return Boolean(form?.base) && HOSTING_SETTING_FIELDS.some((key) => form.values[key] !== form.base[key]);
}
export function editHostingForm(form, field, value) {
  if (!form?.base || !HOSTING_SETTING_FIELDS.includes(field) || typeof value !== 'boolean') {
    throw new DomainAliasError('hosting_draft_invalid', 'Yalnız yönlendirme tercihlerini değiştirebilirsiniz.');
  }
  return { ...form, values: { ...form.values, [field]: value } };
}
function sameIdentity(left, right) {
  return ['id', 'serverId', 'websiteId', 'parentDomainId'].every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}
export function hostingFormStale(form, domain) {
  if (!form?.base) return true;
  try {
    const incoming = aliasDomainSnapshot(domain);
    if (!sameIdentity(form.base, incoming)) return true;
    // A collection refresh started before our verified save must not roll it back.
    return incoming.desiredRevision >= form.base.desiredRevision
      && aliasDomainFingerprint(incoming) !== aliasDomainFingerprint(form.base);
  } catch { return true; }
}
export function refreshHostingForm(form, domain) {
  if (!form?.base) return form;
  const base = refreshAliasPublication(form.base, domain);
  return base === form.base ? form : { ...form, base };
}
export function reloadHostingForm(form, domain, expected) {
  const next = createHostingForm(domain);
  if (!sameIdentity(next.base, expected) || (form?.base && !sameIdentity(form.base, next.base))) {
    throw new DomainAliasError('hosting_target_changed', 'Site bağlantısı değişti. Barındırma ekranını güncel site kaydından yeniden açın.', true);
  }
  if (next.base.desiredRevision < (expected?.desiredRevision ?? 0)) {
    throw new DomainAliasError('hosting_reload_stale', 'Yüklenen kayıt ekrandaki güncel sürümden eski. Taslağınız korunuyor.', true);
  }
  if (form?.base && (next.base.desiredRevision < form.base.desiredRevision
    || (next.base.desiredRevision === form.base.desiredRevision
      && aliasDomainFingerprint(next.base) !== aliasDomainFingerprint(form.base)))) {
    throw new DomainAliasError('hosting_reload_stale', 'Güncel kayıt doğrulanamadı; daha eski veya tutarsız sürüm taslağın üzerine alınmadı.', true);
  }
  // Preserve only the user's changed fields. Untouched settings follow the new
  // record, so reloading must not silently revert another operator's changes.
  for (const key of HOSTING_SETTING_FIELDS) {
    if (form?.base && form.values[key] !== form.base[key]) next.values[key] = form.values[key];
  }
  return next;
}
export function hostingReviewMatches(form, plan) {
  try {
    const changes = hostingSettingsChanges(form.base, form.values);
    return aliasDomainFingerprint(form.base) === aliasDomainFingerprint(plan?.base)
      && Object.keys(changes).length === Object.keys(plan.changes).length
      && Object.keys(changes).every((key) => changes[key] === plan.changes[key]);
  } catch { return false; }
}
export function hostingWriteBlock({ form, domain, canManage, domainsStatus, jobsStatus, resourceBusy, reloadRequired }) {
  if (!canManage) return 'Bu hesap barındırma ayarlarını değiştiremez.';
  if (!form?.base) return 'Alan adı kaydı doğrulanamadı. Güncel kaydı yükleyin.';
  if (domainsStatus !== 'ready' || jobsStatus !== 'ready') return 'Alan adı ve işlem bilgileri güncel olmadan kaydedilemez.';
  if (form.base.state === 'suspended' || domain?.state === 'suspended') return 'Askıdaki alan adının ayarları değiştirilemez.';
  if (reloadRequired || hostingFormStale(form, domain)) return 'Güncel kaydı yükleyip değişiklikleri yeniden inceleyin. Taslağınız korunur.';
  if (resourceBusy) return 'Bu alan adı için çalışan işlem var. İşlem tamamlandıktan sonra yeniden inceleyin.';
  return null;
}
