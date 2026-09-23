import { DomainAliasError, aliasDomainSnapshot, sameAliases } from './domain-alias-model.js';

// Deliberately narrow: no hostname, certificate, target, Website or Nginx edits.
export const HOSTING_SETTING_FIELDS = Object.freeze(['httpsRedirect', 'canonicalRedirect']);
const SHA256 = /^[a-f0-9]{64}$/;
const LABELS = Object.freeze({ httpsRedirect: 'HTTP → HTTPS', canonicalRedirect: 'Ek adları ana alan adına yönlendir' });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function fail(code, message, needsReload = false) { throw new DomainAliasError(code, message, needsReload); }
function baseRecord(domain) {
  const base = aliasDomainSnapshot(domain);
  if (base.state === 'suspended') fail('domain_suspended_update_blocked', 'Askıdaki alan adı değiştirilemez.');
  if (base.httpsMode === 'off' && base.httpsRedirect) fail('hosting_target_invalid', 'Kayıtlı HTTPS tercihi tutarsız. Güncel kaydı yükleyin.', true);
  if (base.desiredRevision >= Number.MAX_SAFE_INTEGER) fail('hosting_target_invalid', 'Alan adı revizyonu doğrulanamadı.', true);
  return base;
}
export function hostingSettingsFromDomain(domain) {
  const base = baseRecord(domain);
  return Object.freeze(Object.fromEntries(HOSTING_SETTING_FIELDS.map((key) => [key, base[key]])));
}
export function hostingSettingsChanges(domain, draft) {
  const base = baseRecord(domain);
  if (!object(draft) || Object.keys(draft).length !== HOSTING_SETTING_FIELDS.length
    || Object.keys(draft).some((key) => !HOSTING_SETTING_FIELDS.includes(key))
    || HOSTING_SETTING_FIELDS.some((key) => !Object.hasOwn(draft, key) || typeof draft[key] !== 'boolean')) {
    fail('hosting_draft_invalid', 'Yalnız iki yönlendirme tercihini açıp kapatabilirsiniz.');
  }
  if (draft.httpsRedirect && base.httpsMode !== 'managed') {
    fail('invalid_redirect_policy', 'HTTP → HTTPS yönlendirmesinden önce SSL/TLS ekranında HTTPS yapılandırın.');
  }
  const changes = Object.fromEntries(HOSTING_SETTING_FIELDS.filter((key) => draft[key] !== base[key]).map((key) => [key, draft[key]]));
  if (!Object.keys(changes).length) fail('hosting_no_changes', 'Kaydedilecek bir değişiklik yok.');
  return Object.freeze(changes);
}
export function hostingSettingsDiff(domain, draft) {
  const changes = hostingSettingsChanges(domain, draft);
  return Object.freeze(Object.keys(changes).map((key) => Object.freeze({
    key, label: LABELS[key], before: domain[key], after: changes[key],
  })));
}
export function hostingSettingsWarnings(domain, draft) {
  hostingSettingsChanges(domain, draft);
  return domain.httpsMode === 'managed' && draft.httpsRedirect && !domain.certificateId
    ? Object.freeze(['SSL sertifikası bağlı değil. Kaydetme veya yayın işi HTTPS erişiminin hazır olduğunu göstermez.'])
    : Object.freeze([]);
}
export function validateHostingSettingsPreview(domain, draft, preview) {
  const base = baseRecord(domain);
  const changes = hostingSettingsChanges(base, draft);
  const expected = { ...base, ...changes };
  if (!object(preview) || preview.version !== 1 || preview.domainId !== base.id
    || preview.currentRevision !== base.desiredRevision || preview.nextRevision !== base.desiredRevision + 1
    || typeof preview.previewDigest !== 'string' || !SHA256.test(preview.previewDigest)
    || preview.confirmation !== `update-domain:${base.id}:${preview.previewDigest}`
    || !object(preview.next) || preview.next.primaryDomain !== base.primaryDomain
    || !sameAliases(preview.next.aliases, base.aliases) || preview.next.httpsMode !== base.httpsMode
    || HOSTING_SETTING_FIELDS.some((key) => preview.next[key] !== expected[key])
    || JSON.stringify(stable(preview.next.nginxSettings)) !== JSON.stringify(stable(base.nginxSettings))
    || preview.impact?.hostnameChanged !== false || preview.impact?.policyChanged !== true
    || preview.impact?.settingsChanged !== false || preview.impact?.requiresStageAndActivation !== true
    || preview.impact?.certificate?.id !== base.certificateId || preview.impact?.certificate?.detached !== false) {
    fail('hosting_response_invalid', 'Sunucunun önizlemesi seçilen site ve yönlendirme tercihleriyle eşleşmiyor.');
  }
  return Object.freeze({ changes, nextRevision: preview.nextRevision,
    previewDigest: preview.previewDigest, confirmation: preview.confirmation });
}
