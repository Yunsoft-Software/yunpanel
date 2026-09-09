const DAY = 86400000;
const ACTIVE_JOBS = new Set(['queued', 'running']);
export const SITE_TABS = [
  ['overview', 'Genel bakış'], ['node', 'Uygulama'], ['deploy', 'Git / Deploy'],
  ['domains', 'Alan adları'], ['ssl', 'SSL'], ['mail', 'Mail'], ['files', 'Dosyalar'],
  ['databases', 'Veritabanları'], ['logs', 'Loglar'], ['cron', 'Zamanlanmış işler'],
  ['backups', 'Yedekler'], ['terminal', 'Terminal'], ['settings', 'Ayarlar'],
];
export const siteHref = (id, tab = 'overview') => `/websites/${encodeURIComponent(id)}/${SITE_TABS.some(([key]) => key === tab) ? tab : 'overview'}`;
export function certificateState(domain, certificates, now = Date.now()) {
  if (!Array.isArray(certificates)) return { state: 'unknown', label: 'SSL bilgisi alınamadı' };
  const certificate = certificates.find((item) => item.id === domain.certificateId);
  if (!certificate) return { state: domain.httpsMode === 'managed' ? 'pending' : 'off', label: domain.httpsMode === 'managed' ? 'Sertifika bekliyor' : 'SSL kapalı' };
  if (certificate.staging) return { state: 'staging', label: 'Test sertifikası', certificate };
  if (certificate.state !== 'active') return { state: certificate.state ?? 'unknown', label: certificate.state === 'error' ? 'Sertifika hatası' : 'Sertifika hazır değil', certificate };
  const expiry = Date.parse(certificate.validTo);
  if (!Number.isFinite(expiry)) return { state: 'unknown', label: 'Süre bilgisi yok', certificate };
  const days = Math.ceil((expiry - now) / DAY);
  if (days <= 0) return { state: 'expired', label: 'Süresi dolmuş', certificate, days };
  return { state: days <= 30 ? 'warning' : 'active', label: `${days} gün`, certificate, days };
}

/** Compatibility view only: never persists or silently assigns an application. */
export function matchingApplications(domain, applications) {
  if (domain.targetType !== 'proxy' || !Number.isInteger(domain.target?.upstreamPort)) return [];
  return applications.filter((app) => app.serverId === domain.serverId && app.type === 'node'
    && app.runtime?.port === domain.target.upstreamPort);
}
export function selectedApplication(domain, applications, requestedId) {
  const matches = matchingApplications(domain, applications);
  if (requestedId) return matches.find((app) => app.id === requestedId) ?? null;
  return matches.length === 1 ? matches[0] : null;
}
export function siteJobs(domain, application, jobs) {
  return jobs.filter((job) => job.serverId === domain.serverId && (
    (job.resourceType === 'domain' && job.resourceId === domain.id)
    || (application && job.resourceType === 'application' && job.resourceId === application.id)
    || (domain.certificateId && job.resourceType === 'certificate' && job.resourceId === domain.certificateId)
  )).sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
}
export const jobActive = (job) => ACTIVE_JOBS.has(job?.status);
export function jobFromResponse(result) {
  const job = result?.job ?? result;
  if (!job || typeof job.id !== 'string' || !job.id || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status)) {
    throw new Error('API geçerli bir iş kaydı döndürmedi. İşler ekranından son durumu kontrol edin.');
  }
  return job;
}
export function externalSiteUrl(domain) {
  const name = domain.primaryDomain;
  if (typeof name !== 'string' || name.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(name)) return null;
  return `${domain.certificateId ? 'https' : 'http'}://${name}/`;
}
export function parentTrail(domain, domains) {
  const byId = new Map(domains.map((item) => [item.id, item]));
  const seen = new Set([domain.id]); const trail = [];
  let parent = byId.get(domain.parentDomainId);
  while (parent && !seen.has(parent.id)) {
    trail.unshift(parent); seen.add(parent.id); parent = byId.get(parent.parentDomainId);
  }
  return trail;
}
export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let unit = 0; let size = value;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}
export function formatDate(value) {
  if (value == null || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Date(value).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}
