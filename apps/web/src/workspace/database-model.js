const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SITE_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const DATABASE_USER_PATTERN = /^ydb_[a-f0-9]{24}$/;

function databaseOwnership(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object'
    || !UUID_PATTERN.test(value.bindingId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '')
    || !UUID_PATTERN.test(value.applicationId ?? '')
    || !SITE_USER_PATTERN.test(value.unixUser ?? '')
    || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
  const credential = value.credential && typeof value.credential === 'object'
    && UUID_PATTERN.test(value.credential.id ?? '')
    && DATABASE_USER_PATTERN.test(value.credential.username ?? '')
    && value.credential.host === 'localhost'
    && Number.isSafeInteger(value.credential.revision) && value.credential.revision > 0
    ? {
        id: value.credential.id,
        username: value.credential.username,
        revision: value.credential.revision,
      }
    : null;
  return {
    bindingId: value.bindingId,
    websiteId: value.websiteId,
    applicationId: value.applicationId,
    unixUser: value.unixUser,
    revision: value.revision,
    credential,
  };
}

export function validDatabaseName(value) {
  return typeof value === 'string'
    && DATABASE_NAME_PATTERN.test(value)
    && !RESERVED_DATABASES.has(value.toLowerCase());
}

export function formatDatabaseBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === units.at(-1)) {
      const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
      return `${Number(size.toFixed(digits))} ${unit}`;
    }
    size /= 1024;
  }
  return '—';
}

export function databaseInventoryView(data) {
  const databases = Array.isArray(data?.databases)
    ? data.databases
        .filter((entry) => entry && validDatabaseName(entry.name) && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0)
        .map((entry) => ({
          name: entry.name,
          sizeBytes: entry.sizeBytes,
          sizeLabel: formatDatabaseBytes(entry.sizeBytes),
          ownership: databaseOwnership(entry.ownership),
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    : null;
  return {
    engine: ['mysql', 'mariadb'].includes(data?.engine) ? data.engine : null,
    version: typeof data?.version === 'string' && data.version ? data.version : null,
    databases,
    totalBytes: databases?.reduce((sum, entry) => sum + entry.sizeBytes, 0) ?? 0,
    live: data?.live === true,
    ownership: data?.ownership
      && Number.isSafeInteger(data.ownership.bindingCount) && data.ownership.bindingCount >= 0
      && Number.isSafeInteger(data.ownership.credentialCount) && data.ownership.credentialCount >= 0
      && Number.isSafeInteger(data.ownership.missingDatabaseBindingCount) && data.ownership.missingDatabaseBindingCount >= 0
      ? {
          bindingCount: data.ownership.bindingCount,
          credentialCount: data.ownership.credentialCount,
          missingDatabaseBindingCount: data.ownership.missingDatabaseBindingCount,
        }
      : null,
    snapshot: data?.snapshot?.jobId && data?.snapshot?.refreshedAt ? {
      jobId: data.snapshot.jobId,
      refreshedAt: data.snapshot.refreshedAt,
    } : null,
  };
}

export const databaseModelInternals = Object.freeze({
  databaseNamePattern: DATABASE_NAME_PATTERN,
  reservedDatabases: Object.freeze([...RESERVED_DATABASES]),
  databaseOwnership,
});
