export const DNS_RECORD_TYPES = Object.freeze(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV', 'NS', 'SOA']);

export function rootDnsDomain(domain, domains) {
  if (!domain || typeof domain.id !== 'string') return null;
  const byId = new Map((Array.isArray(domains) ? domains : []).map((item) => [item.id, item]));
  let current = domain;
  const seen = new Set();
  while (current?.parentDomainId) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = byId.get(current.parentDomainId) ?? null;
    if (!current) return null;
  }
  return current;
}

export function relativeDnsOwner(owner, zoneName) {
  const normalizedOwner = String(owner ?? '').replace(/\.$/, '').toLowerCase();
  const normalizedZone = String(zoneName ?? '').replace(/\.$/, '').toLowerCase();
  if (!normalizedOwner || !normalizedZone) return '';
  if (normalizedOwner === normalizedZone) return '@';
  const suffix = `.${normalizedZone}`;
  return normalizedOwner.endsWith(suffix) ? normalizedOwner.slice(0, -suffix.length) : normalizedOwner;
}

export function dnsRrsetValues(rrset) {
  return Object.freeze((Array.isArray(rrset?.records) ? rrset.records : [])
    .filter((entry) => entry?.disabled !== true && typeof entry?.value === 'string')
    .map((entry) => entry.value));
}

export function dnsRecordEditable(rrset) {
  return rrset?.source === 'manual';
}

export function dnsRecordDraft(rrset, zoneName) {
  return Object.freeze({
    owner: rrset ? relativeDnsOwner(rrset.owner, zoneName) : '@',
    type: rrset?.type && DNS_RECORD_TYPES.includes(rrset.type) ? rrset.type : 'A',
    ttl: Number.isSafeInteger(rrset?.ttl) ? String(rrset.ttl) : '300',
    values: rrset ? dnsRrsetValues(rrset).join('\n') : '',
  });
}

export function dnsRecordPayload(draft, serial) {
  if (!draft || typeof draft !== 'object') throw new Error('DNS record form is invalid');
  const owner = typeof draft.owner === 'string' ? draft.owner.trim() : '';
  const type = typeof draft.type === 'string' ? draft.type.toUpperCase() : '';
  const ttl = Number.parseInt(String(draft.ttl ?? ''), 10);
  const values = String(draft.values ?? '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (!owner) throw new Error('Kayıt adı gerekli. Kök kayıt için @ kullanın.');
  if (!DNS_RECORD_TYPES.includes(type)) throw new Error('DNS kayıt türü desteklenmiyor.');
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error('TTL 60 ile 86400 saniye arasında olmalı.');
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Güncel SOA serial alınmadan DNS kaydı değiştirilemez.');
  if (values.length < 1 || values.length > 16) throw new Error('En az bir, en fazla 16 kayıt değeri girin.');
  if ((type === 'CNAME' || type === 'SOA') && values.length !== 1) throw new Error(`${type} kaydı tam olarak bir değer içermeli.`);
  return Object.freeze({ owner, type, ttl, values: Object.freeze(values), expectedSerial: serial });
}

export function dnsRecordDeletePayload(rrset, zoneName, serial) {
  if (!rrset || !dnsRecordEditable(rrset)) throw new Error('Yalnız manual DNS kayıtları silinebilir.');
  if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Güncel SOA serial alınmadan DNS kaydı silinemez.');
  return Object.freeze({
    owner: relativeDnsOwner(rrset.owner, zoneName),
    type: rrset.type,
    expectedSerial: serial,
  });
}

export function dnsSourceLabel(source) {
  return ({ template: 'Zone Template', runtime: 'Runtime', mail: 'Mail', manual: 'Manual' })[source] ?? 'Bilinmiyor';
}

export function dnssecPresentation(status) {
  const value = {
    secure_ready: ['active', 'Güvenli delegasyon'],
    pending_parent_ds: ['pending', 'Parent DS bekleniyor'],
    parent_ds_mismatch: ['error', 'Parent DS uyuşmuyor'],
    parent_ds_without_dnssec: ['error', 'İmza kapalı, parent DS açık'],
    parent_ds_unverifiable: ['warning', 'Parent DS doğrulanamıyor'],
    signing_material_incomplete: ['error', 'Signing material eksik'],
    insecure_parent_unverifiable: ['warning', 'DNSSEC kapalı · parent belirsiz'],
    insecure: ['off', 'DNSSEC kapalı'],
  }[status];
  return value ? Object.freeze({ state: value[0], label: value[1] }) : Object.freeze({ state: 'unknown', label: status || 'Bilinmiyor' });
}

export function operationPresentation(operation) {
  if (!operation) return Object.freeze({ state: 'unknown', label: 'İşlem yok' });
  if (operation.status === 'succeeded') return Object.freeze({ state: 'succeeded', label: 'Tamamlandı' });
  if (operation.status === 'failed') return Object.freeze({ state: 'failed', label: 'Başarısız' });
  if (operation.status === 'applying') return Object.freeze({ state: 'running', label: 'Uygulanıyor' });
  return Object.freeze({ state: 'pending', label: 'Bekliyor' });
}
