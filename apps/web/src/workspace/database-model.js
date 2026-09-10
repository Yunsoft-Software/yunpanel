const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

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
        .map((entry) => ({ name: entry.name, sizeBytes: entry.sizeBytes, sizeLabel: formatDatabaseBytes(entry.sizeBytes) }))
        .sort((left, right) => left.name.localeCompare(right.name))
    : null;
  return {
    engine: ['mysql', 'mariadb'].includes(data?.engine) ? data.engine : null,
    version: typeof data?.version === 'string' && data.version ? data.version : null,
    databases,
    totalBytes: databases?.reduce((sum, entry) => sum + entry.sizeBytes, 0) ?? 0,
    snapshot: data?.snapshot?.jobId && data?.snapshot?.refreshedAt ? {
      jobId: data.snapshot.jobId,
      refreshedAt: data.snapshot.refreshedAt,
    } : null,
  };
}

export const databaseModelInternals = Object.freeze({
  databaseNamePattern: DATABASE_NAME_PATTERN,
  reservedDatabases: Object.freeze([...RESERVED_DATABASES]),
});
