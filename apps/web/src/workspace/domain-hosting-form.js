import { DomainAliasError, aliasDomainFingerprint, aliasDomainSnapshot, refreshAliasPublication } from './domain-alias-model.js';
import { HOSTING_SETTING_FIELDS, hostingSettingsChanges, hostingDraftValues, hostingValuesEqual } from './domain-hosting-model.js';

// State only: no persistence, authorization, HTTP requests or publishing here.
export function createHostingForm(domain) {
  const base = aliasDomainSnapshot(domain);
  return { base, values: hostingDraftValues(base) };
}
export function hostingFormDirty(form) {
  return Boolean(form?.base) && !hostingValuesEqual(form.values, hostingDraftValues(form.base));
}
export function editHostingForm(form, field, value) {
  if (!form?.base || !HOSTING_SETTING_FIELDS.includes(field)
    || (field === 'nginxSettings' ? !value || typeof value !== 'object' || Array.isArray(value) : typeof value !== 'boolean')) {
    throw new DomainAliasError('hosting_draft_invalid', 'Barındırma ayarı doğrulanamadı.');
  }
  return { ...form, values: { ...form.values, [field]: structuredClone(value) } };
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
  const previous = form?.base ? hostingDraftValues(form.base) : null;
  for (const key of HOSTING_SETTING_FIELDS.filter(key => key !== 'nginxSettings')) {
    if (previous && !hostingValuesEqual(form.values[key], previous[key])) next.values[key] = form.values[key];
  }
  const optionalFiles = previous && ['php', 'static'].includes(next.base.targetType)
    ? ['indexFiles', 'errorPages'].filter(key => Object.hasOwn(form.values.nginxSettings, key)) : [];
  if (previous) for (const key of new Set([...Object.keys(next.values.nginxSettings), ...optionalFiles])) {
    if (!hostingValuesEqual(form.values.nginxSettings[key], previous.nginxSettings[key])) {
      next.values.nginxSettings[key] = structuredClone(form.values.nginxSettings[key]);
    }
  }
  return next;
}
export function hostingReviewMatches(form, plan) {
  try {
    const changes = hostingSettingsChanges(form.base, form.values);
    return aliasDomainFingerprint(form.base) === aliasDomainFingerprint(plan?.base)
      && Object.keys(changes).length === Object.keys(plan.changes).length
      && Object.keys(changes).every((key) => hostingValuesEqual(changes[key], plan.changes[key]));
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
