const RESOURCE_LABELS = Object.freeze({
  domain: 'Alan adı',
  server: 'Sunucu',
  system: 'Sunucu',
  application: 'Uygulama',
  certificate: 'Sertifika',
  backup: 'Yedek',
  database: 'Veritabanı',
  dns_zone: 'DNS zone',
  mail_domain: 'Mail domain',
  docker_project: 'Docker projesi',
});

const DEPLOY_LOG_OPERATIONS = new Set(['app.static.deploy', 'app.node.deploy']);

const SAFE_RESULT_FIELDS = Object.freeze([
  ['status', 'Sonuç'],
  ['action', 'İşlem'],
  ['activeState', 'Aktif durum'],
  ['subState', 'Alt durum'],
  ['serviceName', 'Servis'],
  ['databaseName', 'Veritabanı'],
  ['engine', 'Engine'],
  ['version', 'Sürüm'],
  ['commitSha', 'Commit'],
  ['releaseId', 'Release'],
  ['previousReleaseId', 'Önceki release'],
  ['environmentRevision', 'Env revizyonu'],
  ['artifactFiles', 'Dosya sayısı'],
  ['artifactBytes', 'Artifact boyutu'],
  ['port', 'Port'],
  ['healthy', 'Sağlık'],
  ['selector', 'DKIM selector'],
]);

function boundedScalar(value) {
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return null;
}

function linkedSiteForApplication(resourceId, { websites = [], domains = [] } = {}) {
  const website = websites.find((item) => item.applicationId === resourceId);
  if (!website) return null;
  return domains.find((item) => item.websiteId === website.id) ?? null;
}

function linkedSiteForCertificate(resourceId, { domains = [] } = {}) {
  return domains.find((item) => item.certificateId === resourceId) ?? null;
}

export function jobResourceTarget(job, resources = {}) {
  const resourceType = typeof job?.resourceType === 'string' ? job.resourceType : null;
  const resourceId = typeof job?.resourceId === 'string' && job.resourceId ? job.resourceId : null;
  if (!resourceType || !resourceId) return null;
  const label = RESOURCE_LABELS[resourceType] ?? 'Kaynak';
  if (resourceType === 'domain') return Object.freeze({ label, href: `/websites/${encodeURIComponent(resourceId)}/overview` });
  if (resourceType === 'application') {
    const domain = linkedSiteForApplication(resourceId, resources);
    return Object.freeze({ label, href: domain ? `/websites/${encodeURIComponent(domain.id)}/node` : '/applications' });
  }
  if (resourceType === 'certificate') {
    const domain = linkedSiteForCertificate(resourceId, resources);
    return Object.freeze({ label, href: domain ? `/websites/${encodeURIComponent(domain.id)}/ssl` : '/domains' });
  }
  if (resourceType === 'mail_domain') return Object.freeze({ label, href: `/mail/${encodeURIComponent(resourceId)}` });
  if (resourceType === 'docker_project') return Object.freeze({ label, href: `/docker/${encodeURIComponent(resourceId)}` });
  if (resourceType === 'database') return Object.freeze({ label, href: '/databases' });
  if (resourceType === 'dns_zone') return Object.freeze({ label, href: '/domains' });
  if (resourceType === 'backup') return Object.freeze({ label, href: '/backups' });
  if (resourceType === 'server' || resourceType === 'system') return Object.freeze({ label, href: '/servers' });
  return Object.freeze({ label, href: null });
}

// Status is not a measured fraction or a retry budget. Keep progress unknown
// until the API exposes an explicit, validated measurement contract.
export function jobLifecycle(job) {
  const status = job?.status;
  if (status === 'queued') return Object.freeze({ stage: 'Kuyrukta', progress: '—', detail: 'Sunucu yürütücüsü işi henüz üstlenmedi.' });
  if (status === 'running') return Object.freeze({ stage: 'Sunucuda çalışıyor', progress: '—', detail: 'İş sunucuda çalışıyor; sonucu henüz belli değil.' });
  if (status === 'succeeded') return Object.freeze({ stage: 'Tamamlandı', progress: '—', detail: 'Sunucu doğrulanmış başarılı sonuç kaydetti.' });
  if (status === 'failed') return Object.freeze({ stage: 'Başarısız', progress: '—', detail: 'İşlem başarısız oldu. Hata ayrıntısını ve ilgili kaynak durumunu kontrol edin.' });
  if (status === 'cancelled') return Object.freeze({ stage: 'İptal edildi', progress: '—', detail: 'İş çalışmadan önce veya desteklenen iptal noktasında kapatıldı.' });
  return Object.freeze({ stage: 'Bilinmiyor', progress: '—', detail: 'İş yaşam döngüsü doğrulanamadı.' });
}

export function jobAttemptCount(job) {
  return Number.isSafeInteger(job?.attempts) && job.attempts >= 0 ? job.attempts : null;
}

export function safeJobResultMetadata(job) {
  const result = job?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return Object.freeze([]);
  const entries = [];
  for (const [field, label] of SAFE_RESULT_FIELDS) {
    const value = boundedScalar(result[field]);
    if (value !== null) entries.push(Object.freeze([label, value]));
  }
  return Object.freeze(entries);
}

export function jobSupportsDeployLogs(job) {
  return DEPLOY_LOG_OPERATIONS.has(job?.operation ?? job?.type);
}

export const jobPresentationInternals = Object.freeze({
  resourceLabels: RESOURCE_LABELS,
  safeResultFields: SAFE_RESULT_FIELDS,
  boundedScalar,
  deployLogOperations: DEPLOY_LOG_OPERATIONS,
});
