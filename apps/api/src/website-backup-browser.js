const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT = /^[a-f0-9]{8,64}$/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MAX_REPOSITORIES = 50;
const MAX_SNAPSHOTS = 100;

export class WebsiteBackupBrowserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteBackupBrowserError';
    this.code = code;
    this.status = status;
  }
}

function safeRetention(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of ['keepLast', 'keepDaily', 'keepWeekly', 'keepMonthly', 'keepYearly']) {
    if (Number.isSafeInteger(value[field]) && value[field] > 0) result[field] = value[field];
  }
  if (Array.isArray(value.keepTags)) {
    result.keepTags = value.keepTags.filter((tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= 120).slice(0, 20);
  }
  return Object.freeze(result);
}

function safeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !SNAPSHOT.test(value.id)
    || typeof value.time !== 'string' || !Number.isFinite(Date.parse(value.time))) return null;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string').slice(0, 50) : [];
  return Object.freeze({
    id: value.id,
    shortId: typeof value.shortId === 'string' && SNAPSHOT.test(value.shortId) ? value.shortId : value.id.slice(0, 8),
    time: new Date(value.time).toISOString(),
    kind: tags.includes('pre-restore') ? 'pre_restore' : 'backup',
  });
}

function backupSetSummary(value, websiteId) {
  if (!value || typeof value !== 'object' || value.website?.id !== websiteId) {
    throw new WebsiteBackupBrowserError('website_backup_set_invalid', 'Website backup set could not be verified', 503);
  }
  return Object.freeze({
    version: value.version ?? 1,
    digest: typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) ? value.digest : null,
    runtimeType: value.website?.runtimeType ?? null,
    databaseCount: Array.isArray(value.databases) ? value.databases.length : 0,
    mailCount: Array.isArray(value.mail) ? value.mail.length : 0,
    dnsCount: Array.isArray(value.dns) ? value.dns.length : 0,
    pathCount: Array.isArray(value.targetPaths) ? value.targetPaths.length : 0,
    composeHooksEnabled: value.composeHooks?.enabled === true,
  });
}

export function createWebsiteBackupBrowser({
  websiteRegistry,
  resticRepositoryRegistry,
  websiteBackupSetProvider,
  localServerId = null,
} = {}) {
  if (typeof websiteRegistry?.getWebsite !== 'function'
    || typeof resticRepositoryRegistry?.listRepositories !== 'function'
    || typeof resticRepositoryRegistry?.listSnapshots !== 'function'
    || typeof websiteBackupSetProvider?.getWebsiteBackupSet !== 'function') {
    throw new WebsiteBackupBrowserError('website_backup_browser_dependencies_invalid', 'Website backup browser dependencies are invalid', 503);
  }

  async function browse(websiteId) {
    if (typeof websiteId !== 'string' || !UUID.test(websiteId)) {
      throw new WebsiteBackupBrowserError('invalid_website_id', 'Website ID is invalid', 400);
    }
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || website.id !== websiteId || !UUID.test(website.serverId ?? '')) {
      throw new WebsiteBackupBrowserError('website_not_found', 'Website not found', 404);
    }
    if (localServerId && website.serverId !== localServerId) {
      throw new WebsiteBackupBrowserError('website_not_found', 'Website not found', 404);
    }

    const [repositories, backupSet] = await Promise.all([
      resticRepositoryRegistry.listRepositories({ serverId: website.serverId }),
      websiteBackupSetProvider.getWebsiteBackupSet({ websiteId, serverId: website.serverId }),
    ]);
    if (!Array.isArray(repositories) || repositories.length > MAX_REPOSITORIES) {
      throw new WebsiteBackupBrowserError('website_backup_repositories_invalid', 'Backup repositories could not be verified', 503);
    }

    const projected = [];
    for (const repository of repositories) {
      if (!repository || !UUID.test(repository.id ?? '') || repository.serverId !== website.serverId
        || !SAFE_NAME.test(repository.name ?? '') || !['local', 'rclone'].includes(repository.backend)
        || !['uninitialized', 'ready', 'error'].includes(repository.status)) {
        throw new WebsiteBackupBrowserError('website_backup_repository_invalid', 'Backup repository metadata is invalid', 503);
      }
      let snapshotStatus = repository.status === 'ready' ? 'ready' : 'unavailable';
      let snapshots = [];
      if (repository.status === 'ready') {
        try {
          const raw = await resticRepositoryRegistry.listSnapshots(repository.id, { tags: [`website:${websiteId}`] });
          if (!Array.isArray(raw) || raw.length > 5000) throw new Error('invalid snapshots');
          snapshots = raw.map(safeSnapshot).filter(Boolean)
            .sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, MAX_SNAPSHOTS);
          if (snapshots.length !== Math.min(raw.length, MAX_SNAPSHOTS)) snapshotStatus = 'partial';
        } catch {
          snapshotStatus = 'error';
          snapshots = [];
        }
      }
      projected.push(Object.freeze({
        id: repository.id,
        name: repository.name,
        backend: repository.backend,
        status: repository.status,
        retentionPolicy: safeRetention(repository.retentionPolicy),
        lastCheckedAt: typeof repository.lastCheckedAt === 'string' && Number.isFinite(Date.parse(repository.lastCheckedAt))
          ? new Date(repository.lastCheckedAt).toISOString() : null,
        lastSnapshotAt: typeof repository.lastSnapshotAt === 'string' && Number.isFinite(Date.parse(repository.lastSnapshotAt))
          ? new Date(repository.lastSnapshotAt).toISOString() : null,
        snapshotStatus,
        snapshots: Object.freeze(snapshots),
      }));
    }

    return Object.freeze({
      schemaVersion: 1,
      websiteId,
      serverId: website.serverId,
      backupSet: backupSetSummary(backupSet, websiteId),
      repositories: Object.freeze(projected),
      inspectedAt: new Date().toISOString(),
    });
  }

  return Object.freeze({ browse });
}

export const websiteBackupBrowserInternals = Object.freeze({ safeRetention, safeSnapshot, backupSetSummary });
