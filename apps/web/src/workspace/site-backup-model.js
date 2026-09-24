const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAP = /^[a-f0-9]{8,64}$/i;
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const normalizedDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value, max = 120) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

export class SiteBackupBrowserError extends Error {
  constructor(code = 'site_backup_response_invalid') { super(code); this.code = code; }
}
function need(value) { if (!value) throw new SiteBackupBrowserError(); }

export function siteBackupScope(value) {
  need(record(value) && UUID.test(value.websiteId ?? '') && UUID.test(value.serverId ?? ''));
  return Object.freeze({ websiteId: value.websiteId, serverId: value.serverId });
}

function retention(value) {
  if (value === null) return null;
  need(record(value));
  const output = {};
  for (const key of ['keepLast', 'keepDaily', 'keepWeekly', 'keepMonthly', 'keepYearly']) {
    if (value[key] !== undefined) {
      need(Number.isSafeInteger(value[key]) && value[key] > 0);
      output[key] = value[key];
    }
  }
  if (value.keepTags !== undefined) {
    need(Array.isArray(value.keepTags) && value.keepTags.length <= 20 && value.keepTags.every((item) => text(item)));
    output.keepTags = Object.freeze([...value.keepTags]);
  }
  return Object.freeze(output);
}

function snapshot(value) {
  need(record(value) && SNAP.test(value.id ?? '') && SNAP.test(value.shortId ?? '')
    && normalizedDate(value.time) && ['backup', 'pre_restore'].includes(value.kind));
  return Object.freeze({ id: value.id, shortId: value.shortId, time: normalizedDate(value.time), kind: value.kind });
}

export function siteBackupBrowser(value, scope) {
  need(record(value) && value.schemaVersion === 1 && value.websiteId === scope.websiteId && value.serverId === scope.serverId
    && record(value.backupSet) && Array.isArray(value.repositories) && value.repositories.length <= 50 && normalizedDate(value.inspectedAt));
  const set = value.backupSet;
  need(Number.isSafeInteger(set.databaseCount) && set.databaseCount >= 0
    && Number.isSafeInteger(set.mailCount) && set.mailCount >= 0
    && Number.isSafeInteger(set.dnsCount) && set.dnsCount >= 0
    && Number.isSafeInteger(set.pathCount) && set.pathCount >= 0
    && typeof set.composeHooksEnabled === 'boolean'
    && (set.digest === null || /^[a-f0-9]{64}$/.test(set.digest))
    && (set.runtimeType === null || text(set.runtimeType, 40)));
  const repositories = value.repositories.map((repo) => {
    need(record(repo) && UUID.test(repo.id ?? '') && text(repo.name, 80)
      && ['local', 'rclone'].includes(repo.backend)
      && ['uninitialized', 'ready', 'error'].includes(repo.status)
      && ['ready', 'unavailable', 'error', 'partial'].includes(repo.snapshotStatus)
      && Array.isArray(repo.snapshots) && repo.snapshots.length <= 100);
    return Object.freeze({
      id: repo.id,
      name: repo.name,
      backend: repo.backend,
      status: repo.status,
      retentionPolicy: retention(repo.retentionPolicy),
      lastCheckedAt: repo.lastCheckedAt === null ? null : normalizedDate(repo.lastCheckedAt),
      lastSnapshotAt: repo.lastSnapshotAt === null ? null : normalizedDate(repo.lastSnapshotAt),
      snapshotStatus: repo.snapshotStatus,
      snapshots: Object.freeze(repo.snapshots.map(snapshot)),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    ...scope,
    backupSet: Object.freeze({
      digest: set.digest,
      runtimeType: set.runtimeType,
      databaseCount: set.databaseCount,
      mailCount: set.mailCount,
      dnsCount: set.dnsCount,
      pathCount: set.pathCount,
      composeHooksEnabled: set.composeHooksEnabled,
    }),
    repositories: Object.freeze(repositories),
    inspectedAt: normalizedDate(value.inspectedAt),
  });
}

export function resolveSiteBackupAccess({ domainId, domains, websites, canManage }) {
  if (!canManage || [domains?.status, websites?.status].some((status) => ['unauthorized', 'forbidden'].includes(status))) return { state: 'forbidden' };
  if (domains?.status !== 'ready' || websites?.status !== 'ready' || !Array.isArray(domains.items) || !Array.isArray(websites.items)) return { state: 'unavailable' };
  const matches = domains.items.filter((item) => item?.id === domainId);
  if (matches.length !== 1) return { state: 'not_found' };
  const domain = matches[0];
  if (!domain.websiteId) return { state: 'unbound' };
  const sites = websites.items.filter((item) => item?.id === domain.websiteId);
  if (sites.length !== 1) return { state: 'not_found' };
  const website = sites[0];
  if (website.serverId !== domain.serverId) return { state: 'inconsistent' };
  try { return { state: 'ready', scope: siteBackupScope({ websiteId: website.id, serverId: website.serverId }) }; }
  catch { return { state: 'inconsistent' }; }
}

export function siteBackupErrorMessage(error) {
  return ({
    site_backup_response_invalid: 'Yedekleme yanıtı bu siteyle eşleşmiyor. Sonuç kullanılmadı.',
    site_scope_forbidden: 'Bu sitenin yedeklerine erişim izniniz yok.',
    site_scope_unavailable: 'Site yetkileri doğrulanamadı.',
    restic_binary_missing: 'Yedekleme aracı sunucuda kullanılamıyor.',
    restic_repo_locked: 'Yedek deposu kilitli; Owner müdahalesi gerekiyor.',
  })[error?.code] ?? 'Yedekleme bilgileri alınamadı. Yeniden kontrol edin.';
}
