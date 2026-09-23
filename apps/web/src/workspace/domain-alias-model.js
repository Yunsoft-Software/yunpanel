const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FIELDS = ['id', 'serverId', 'websiteId', 'parentDomainId', 'primaryDomain', 'aliases', 'desiredRevision', 'targetType', 'target', 'httpsMode', 'httpsRedirect', 'canonicalRedirect', 'nginxSettings', 'certificateId'];
export const MAX_DOMAIN_ALIASES = 20;
export class DomainAliasError extends Error {
  constructor(code, message, needsReload = false) {
    super(message); this.name = 'DomainAliasError'; this.code = code; this.needsReload = needsReload;
  }
}
export function normalizeAliasName(value) {
  const input = typeof value === 'string' ? value.trim().normalize('NFC').replace(/[\u3002\uff0e\uff61]/g, '.').replace(/\.$/, '') : '';
  if (!input || /[\s:/\\@?#%*\[\]\u0000-\u001f\u007f]/u.test(input)) {
    throw new DomainAliasError('alias_invalid', 'Yalnız alan adını girin; protokol, yol, port veya joker karakter eklemeyin.');
  }
  let name;
  try { name = new URL(`http://${input}/`).hostname.toLowerCase(); } catch { name = ''; }
  const labels = name.split('.');
  if (!name || name.length > 253 || labels.length < 2 || /^\d+$/.test(labels.at(-1))
    || labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new DomainAliasError('alias_invalid', 'Geçerli, tam bir alan adı girin. Örnek: www.ornek.com');
  }
  return name;
}
export function aliasList(values, primaryDomain) {
  if (!Array.isArray(values) || values.length > MAX_DOMAIN_ALIASES) {
    throw new DomainAliasError('alias_limit', 'En fazla 20 ek alan adı kullanılabilir.');
  }
  const names = values.map(normalizeAliasName);
  if (new Set(names).size !== names.length || names.includes(normalizeAliasName(primaryDomain))) {
    throw new DomainAliasError('alias_duplicate', 'Ana alan adı veya aynı ek alan adı ikinci kez eklenemez.');
  }
  return names;
}
export function aliasDiff(before, after) {
  return { added: after.filter((name) => !before.includes(name)), removed: before.filter((name) => !after.includes(name)) };
}
export function sameAliases(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && [...left].sort().every((name, i) => name === [...right].sort()[i]);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value ?? null;
}
export function aliasDomainSnapshot(domain) {
  if (!domain || typeof domain.id !== 'string' || typeof domain.serverId !== 'string'
    || !SAFE_ID.test(domain.id) || !SAFE_ID.test(domain.serverId)
    || !Number.isSafeInteger(domain.desiredRevision) || domain.desiredRevision < 1
    || !['off', 'managed'].includes(domain.httpsMode)
    || typeof domain.httpsRedirect !== 'boolean' || typeof domain.canonicalRedirect !== 'boolean'
    || !domain.target || !domain.nginxSettings) {
    throw new DomainAliasError('alias_target_invalid', 'Alan adı kaydı doğrulanamadı. Güncel kaydı yeniden yükleyin.');
  }
  const result = structuredClone(domain);
  result.aliases = aliasList(domain.aliases, domain.primaryDomain);
  if (normalizeAliasName(domain.primaryDomain) !== domain.primaryDomain
    || !sameAliases(domain.aliases, result.aliases)) {
    throw new DomainAliasError('alias_target_invalid', 'Alan adı kaydının biçimi doğrulanamadı.');
  }
  return result;
}
export function aliasDomainFingerprint(domain) {
  return JSON.stringify(stable(Object.fromEntries(FIELDS.map((key) => [key, domain?.[key]]))));
}
export function assertAliasDomain(expected, actual) {
  aliasDomainSnapshot(actual);
  if (aliasDomainFingerprint(expected) !== aliasDomainFingerprint(actual) || actual.state === 'suspended') {
    throw new DomainAliasError('alias_stale', 'Alan adı başka bir işlemle değişti. Taslağı kontrol edip güncel kaydı yükleyin.');
  }
  return actual;
}
// A background refresh may update publication status without changing the
// routing draft. Adopt only that same routing version; never merge new aliases
// into the user's pending edit or replace a just-saved version with an older one.
export function refreshAliasPublication(base, incoming) {
  try {
    const value = aliasDomainSnapshot(incoming);
    return base && aliasDomainFingerprint(base) === aliasDomainFingerprint(value) ? value : base;
  } catch { return base; }
}
export function aliasErrorMessage(error) {
  if (error instanceof DomainAliasError) return error.message;
  const messages = {
    domain_conflict: 'Bu alan adı başka bir kayıtta kullanılıyor.',
    domain_update_preview_stale: 'Önizlemeden sonra kayıt değişti. Güncel kaydı yükleyip yeniden inceleyin.',
    domain_update_operation_conflict: 'Bu site için çalışan işlem var. İşlem tamamlandıktan sonra yeniden inceleyin.',
    domain_suspended_update_blocked: 'Askıdaki alan adı değiştirilemez.',
    forbidden: 'Bu alan adını değiştirme yetkiniz yok.', unauthorized: 'Oturumunuz sona erdi.',
  };
  return Object.hasOwn(messages, error?.code) ? messages[error.code]
    : 'İşlem doğrulanamadı. Güncel kayıt ve işlem geçmişini kontrol edin.';
}
