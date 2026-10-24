const RESOURCE_LABELS = Object.freeze({
  website: 'Web sitesi',
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
  job: 'İşlem',
});

const DEPLOY_LOG_OPERATIONS = new Set(['app.static.deploy', 'app.node.deploy']);

const OPERATION_LABELS = Object.freeze({
  'app.static.deploy':'Statik siteyi yayınla', 'app.static.rollback':'Önceki statik sürüme dön',
  'app.node.deploy':'Node.js sürümünü yayınla', 'app.node.restart':'Node.js uygulamasını yeniden başlat',
  'app.node.rollback':'Önceki Node.js sürümüne dön', 'app.node.status':'Node.js durumunu kontrol et',
  'app.python.deploy':'Python sürümünü yayınla', 'app.python.restart':'Python uygulamasını yeniden başlat',
  'app.python.rollback':'Önceki Python sürümüne dön', 'app.python.status':'Python durumunu kontrol et',
  'ssl.issue':'SSL sertifikası al', 'ssl.renew':'SSL sertifikasını yenile',
  'domain.stage':'Barındırma ayarlarını kontrol et', 'domain.activate':'Barındırma ayarlarını uygula',
  'database.create':'Veritabanı oluştur', 'database.delete':'Veritabanını sil',
  'database.credential.apply':'Veritabanı erişimini uygula', 'database.credential.delete':'Veritabanı kullanıcısını kaldır',
  'website.php.action':'Site bakım işlemi', 'website.backup.action':'Site yedekleme işlemi',
  'database.inspect':'Veritabanını kontrol et', 'dns.record.apply':'DNS kaydını uygula',
  'mail.config.apply':'Posta ayarlarını uygula', 'mail.config.rollback':'Önceki posta ayarlarına dön',
  'system.upgrade':'Sunucuyu güncelle', 'system.service.control':'Sunucu hizmetini yönet',
});
export function jobOperationLabel(job) {
  const operation = boundedScalar(job?.operation) ?? boundedScalar(job?.type);
  if (operation === 'website.backup.action' && job?.result?.kind === 'restore') return 'Site yedeğini geri yükle';
  if (operation === 'website.backup.action' && job?.result?.kind === 'backup') return 'Site yedeği al';
  return Object.hasOwn(OPERATION_LABELS, operation) ? OPERATION_LABELS[operation] : operation ?? 'İşlem';
}

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
  ['environmentRevision', 'Ortam sürümü'],
  ['artifactFiles', 'Dosya sayısı'],
  ['artifactBytes', 'Dosya boyutu'],
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

function primarySiteDomain(website, domains = []) {
  if (!website) return null;
  const linked = domains.filter(item => item.websiteId === website.id);
  return linked.find(item => item.id === website.primaryDomainId)
    ?? linked.find(item => !item.parentDomainId && item.primaryDomain === website.name)
    ?? linked.find(item => !item.parentDomainId) ?? null;
}

function linkedSiteForApplication(resourceId, { websites = [], domains = [] } = {}) {
  const website = websites.find((item) => item.applicationId === resourceId);
  return primarySiteDomain(website, domains);
}

function linkedSiteForCertificate(resourceId, { domains = [] } = {}) {
  return domains.find((item) => item.certificateId === resourceId) ?? null;
}

export function jobResourceTarget(job, resources = {}) {
  const resourceType = typeof job?.resourceType === 'string' ? job.resourceType : null;
  const resourceId = typeof job?.resourceId === 'string' && job.resourceId ? job.resourceId : null;
  if (!resourceType || !resourceId) return null;
  const label = RESOURCE_LABELS[resourceType] ?? 'Kaynak';
  if (resourceType === 'website') {
    const website = (resources.websites ?? []).find(item => item.id === resourceId);
    const domain = primarySiteDomain(website ?? {id:resourceId}, resources.domains);
    return Object.freeze({ label: boundedScalar(domain?.primaryDomain) ?? boundedScalar(website?.name) ?? label,
      href: domain ? `/websites/${encodeURIComponent(domain.id)}/overview` : null });
  }
  if (resourceType === 'domain') {
    const domain = (resources.domains ?? []).find(item => item.id === resourceId);
    return Object.freeze({ label: boundedScalar(domain?.primaryDomain) ?? label,
      href: domain ? `/websites/${encodeURIComponent(domain.id)}/overview` : null });
  }
  if (resourceType === 'application') {
    const domain = linkedSiteForApplication(resourceId, resources);
    const website = (resources.websites ?? []).find(item => item.applicationId === resourceId);
    const tab = website?.runtimeType === 'php' ? 'php' : ['static','docker'].includes(website?.runtimeType) ? 'overview' : 'node';
    return Object.freeze({ label: boundedScalar(domain?.primaryDomain) ?? boundedScalar(website?.name) ?? label,
      href: domain ? `/websites/${encodeURIComponent(domain.id)}/${tab}` : '/applications' });
  }
  if (resourceType === 'certificate') {
    const domain = linkedSiteForCertificate(resourceId, resources);
    return Object.freeze({ label: boundedScalar(domain?.primaryDomain) ?? label,
      href: domain ? `/websites/${encodeURIComponent(domain.id)}/ssl` : '/domains' });
  }
  if (resourceType === 'mail_domain') return Object.freeze({ label, href: `/mail/${encodeURIComponent(resourceId)}` });
  if (resourceType === 'docker_project') return Object.freeze({ label, href: `/docker/${encodeURIComponent(resourceId)}` });
  if (resourceType === 'database') return Object.freeze({ label, href: '/databases' });
  if (resourceType === 'dns_zone') return Object.freeze({ label, href: '/domains' });
  if (resourceType === 'backup') return Object.freeze({ label, href: '/backups' });
  if (resourceType === 'server' || resourceType === 'system') return Object.freeze({ label, href: '/servers' });
  if (resourceType === 'job') return Object.freeze({ label, href: '/jobs' });
  return Object.freeze({ label, href: null });
}

// Status is not a measured fraction or a retry budget. Keep progress unknown
// until the API exposes an explicit, validated measurement contract.
export function jobOutcome(job) {
  if (job?.status === 'succeeded' && job.result?.kind === 'restore' && job.result?.status === 'rolled_back') {
    return Object.freeze({state:'warning',label:'Geri alındı',detail:'Geri yükleme tamamlanamadı; işlem öncesindeki durum geri getirildi.'});
  }
  return Object.freeze({state:job?.status ?? 'unknown',label:undefined,detail:null});
}

export function jobLifecycle(job) {
  const outcome = jobOutcome(job);
  if (outcome.detail) return Object.freeze({stage:outcome.label,progress:'—',detail:outcome.detail,isSuccessful:false});
  const status = job?.status;
  if (status === 'saving') return Object.freeze({ stage: 'Kaydediliyor', progress: '—', detail: 'Değişiklikler sunucuya kaydediliyor.', isSuccessful: false });
  if (status === 'queued') return Object.freeze({ stage: 'Kuyrukta', progress: '—', detail: 'Sunucu yürütücüsü işi henüz üstlenmedi.', isSuccessful: false });
  if (status === 'running') return Object.freeze({ stage: 'Sunucuda çalışıyor', progress: '—', detail: 'İş sunucuda çalışıyor; sonucu henüz belli değil.', isSuccessful: false });
  if (status === 'applying') return Object.freeze({ stage: 'Uygulanıyor', progress: '—', detail: 'Yapılandırma sunucuda uygulanıyor.', isSuccessful: false });
  if (status === 'verifying') return Object.freeze({ stage: 'Doğrulanıyor', progress: '—', detail: 'Sunucu işlem sonucu ve durum güncelliği doğrulanıyor.', isSuccessful: false });
  if (status === 'partial' || status === 'partial_success') return Object.freeze({ stage: 'Kısmi başarılı', progress: '—', detail: 'İşlem kısmen tamamlandı; bazı adımlar müdahale veya doğrulama gerektiriyor.', isSuccessful: false });
  if (status === 'succeeded') return Object.freeze({ stage: 'Tamamlandı', progress: '—', detail: 'Sunucu doğrulanmış başarılı sonuç kaydetti.', isSuccessful: true });
  if (status === 'failed') return Object.freeze({ stage: 'Başarısız', progress: '—', detail: 'İşlem başarısız oldu. Hata ayrıntısını ve ilgili kaynak durumunu kontrol edin.', isSuccessful: false });
  if (status === 'cancelled') return Object.freeze({ stage: 'İptal edildi', progress: '—', detail: 'İş çalışmadan önce veya desteklenen iptal noktasında kapatıldı.', isSuccessful: false });
  return Object.freeze({ stage: 'Bilinmiyor', progress: '—', detail: 'İş yaşam döngüsü doğrulanamadı.', isSuccessful: false });
}

export function jobAttemptCount(job) {
  return Number.isSafeInteger(job?.attempts) && job.attempts >= 0 ? job.attempts : null;
}

// Health checks must be cleanly separated from execution attempt counters.
// For example, a 0/3 health check pass ratio must never be displayed as "0/3 attempts".
export function jobHealthIndicator(job) {
  const health = job?.healthCheck ?? job?.result?.healthCheck ?? job?.health ?? null;
  if (!health || typeof health !== 'object') return null;
  if (typeof health.satisfied === 'boolean') {
    return Object.freeze({
      satisfied: health.satisfied,
      status: health.satisfied ? 'healthy' : 'unhealthy',
      label: health.satisfied ? 'Sağlıklı' : 'Sağlıksız',
      statusCode: typeof health.statusCode === 'number' ? health.statusCode : null,
      passed: Number.isInteger(health.passed) ? health.passed : (health.satisfied ? 1 : 0),
      total: Number.isInteger(health.total) ? health.total : 1,
    });
  }
  if (typeof health.healthy === 'boolean') {
    return Object.freeze({
      satisfied: health.healthy,
      status: health.healthy ? 'healthy' : 'unhealthy',
      label: health.healthy ? 'Sağlıklı' : 'Sağlıksız',
      statusCode: null,
      passed: health.healthy ? 1 : 0,
      total: 1,
    });
  }
  return null;
}

// Fixed stage progressions (1/3, 2/3, 3/3) must never be treated as true completion percentages,
// nor should failed/cancelled states be disguised as completed/successful.
export function jobStageProgress(job) {
  const isTerminalFailed = ['failed', 'cancelled'].includes(job?.status);
  const stages = job?.stages ?? job?.progress?.stages ?? null;
  if (stages && typeof stages === 'object' && Number.isInteger(stages.total) && Number.isInteger(stages.current)) {
    const current = isTerminalFailed && stages.current >= stages.total ? Math.max(0, stages.total - 1) : stages.current;
    return Object.freeze({
      current,
      total: stages.total,
      label: `${current}/${stages.total} aşama`,
      completed: !isTerminalFailed && stages.current === stages.total,
      isPercentage: false,
    });
  }
  const progress = job?.progress;
  if (progress && typeof progress === 'object' && Number.isInteger(progress.required) && Number.isInteger(progress.completed)) {
    const completed = isTerminalFailed && progress.completed >= progress.required ? Math.max(0, progress.required - 1) : progress.completed;
    return Object.freeze({
      current: completed,
      total: progress.required,
      label: `${completed}/${progress.required} adım`,
      completed: !isTerminalFailed && progress.completed === progress.required && progress.required > 0,
      isPercentage: false,
    });
  }
  if (Array.isArray(job?.steps) && job.steps.length > 0) {
    const requiredSteps = job.steps.filter((s) => s?.required !== false);
    const total = requiredSteps.length;
    let completed = requiredSteps.filter((s) => s?.state === 'succeeded').length;
    if (isTerminalFailed && completed >= total && total > 0) {
      completed = Math.max(0, total - 1);
    }
    return Object.freeze({
      current: completed,
      total,
      label: `${completed}/${total} adım`,
      completed: !isTerminalFailed && completed === total && total > 0,
      isPercentage: false,
    });
  }
  return null;
}

// Manual retry via 'Yeniden dene' can be triggered by authorized users even after
// automatic retry budget is exhausted, provided the system maximum retry limit is not reached.
export function jobSupportsManualRetry(job, { canManage = false } = {}) {
  if (!canManage || !job || typeof job !== 'object') return false;
  if (job.status !== 'failed' && job.canRetry !== true) return false;
  const attempts = Number.isSafeInteger(job.attempts) ? job.attempts : 0;
  const maxAttempts = Number.isSafeInteger(job.maxAttempts) ? job.maxAttempts : 10;
  if (attempts >= maxAttempts) return false;
  if (job.permanentError === true && job.manualRetryAllowed !== true) return false;
  if (job.canRetry === true) return true;
  if (job.status === 'failed') return true;
  return false;
}

export const canTriggerManualRetry = jobSupportsManualRetry;

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
  jobHealthIndicator,
  jobStageProgress,
  jobSupportsManualRetry,
  canTriggerManualRetry,
});
