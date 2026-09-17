const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SITE_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const DATABASE_USER_PATTERN = /^ydb_[a-f0-9]{24}$/;
const DATABASE_ACCOUNT_PATTERN = /^[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}$/;
const DATABASE_AUTH_PLUGIN_PATTERN = /^[A-Za-z0-9_]{0,64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATABASE_HEALTH_REASONS = new Set([
  'database_security_inspection_unavailable',
  'database_native_socket_admin_auth_required',
  'database_anonymous_accounts_present',
  'database_remote_root_accounts_present',
  'database_test_schema_present',
]);
const DATABASE_PRIVILEGES = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX', 'DROP',
  'REFERENCES', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE',
]);

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

function databaseHealth(value) {
  if (!value || typeof value !== 'object' || typeof value.ready !== 'boolean'
    || !DATABASE_HEALTH_REASONS.has(value.reason ?? '') && value.reason !== null) return null;
  if (value.available === false && value.ready === false
    && value.reason === 'database_security_inspection_unavailable') {
    return { available: false, ready: false, reason: value.reason, connection: null, hygiene: null };
  }
  if (value.available !== true || !value.connection || typeof value.connection !== 'object'
    || value.connection.protocol !== 'socket'
    || !DATABASE_ACCOUNT_PATTERN.test(value.connection.adminAccount ?? '')
    || !DATABASE_ACCOUNT_PATTERN.test(value.connection.loginAccount ?? '')
    || !DATABASE_AUTH_PLUGIN_PATTERN.test(value.connection.authPlugin ?? '')
    || typeof value.connection.nativeSocketAuth !== 'boolean'
    || !value.hygiene || typeof value.hygiene !== 'object'
    || typeof value.hygiene.anonymousAccountsAbsent !== 'boolean'
    || typeof value.hygiene.remoteRootAccountsAbsent !== 'boolean'
    || typeof value.hygiene.testSchemaAbsent !== 'boolean') return null;
  return {
    available: true,
    ready: value.ready,
    reason: value.reason,
    connection: {
      adminAccount: value.connection.adminAccount,
      authPlugin: value.connection.authPlugin,
      nativeSocketAuth: value.connection.nativeSocketAuth,
    },
    hygiene: {
      anonymousAccountsAbsent: value.hygiene.anonymousAccountsAbsent,
      remoteRootAccountsAbsent: value.hygiene.remoteRootAccountsAbsent,
      testSchemaAbsent: value.hygiene.testSchemaAbsent,
    },
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
    health: databaseHealth(data?.health),
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

export function websiteDatabaseResourcesView(data) {
  if (!data || typeof data !== 'object' || !UUID_PATTERN.test(data.websiteId ?? '')
    || !UUID_PATTERN.test(data.applicationId ?? '') || !Array.isArray(data.databases)) return null;
  const databases = [];
  const ids = new Set();
  for (const entry of data.databases) {
    const binding = entry?.binding;
    const credential = entry?.credential;
    if (!binding || typeof binding !== 'object' || !UUID_PATTERN.test(binding.id ?? '')
      || ids.has(binding.id) || !validDatabaseName(binding.databaseName)
      || binding.websiteId !== data.websiteId || binding.applicationId !== data.applicationId
      || !SITE_USER_PATTERN.test(binding.unixUser ?? '')
      || !Number.isSafeInteger(binding.revision) || binding.revision < 1) return null;
    if (credential !== null && (!credential || typeof credential !== 'object'
      || !UUID_PATTERN.test(credential.id ?? '') || !DATABASE_USER_PATTERN.test(credential.username ?? '')
      || credential.host !== 'localhost' || !Array.isArray(credential.privileges)
      || credential.privileges.length < 1 || credential.privileges.length > DATABASE_PRIVILEGES.size
      || credential.privileges.some((privilege) => !DATABASE_PRIVILEGES.has(privilege))
      || new Set(credential.privileges).size !== credential.privileges.length
      || !Number.isSafeInteger(credential.revision) || credential.revision < 1
      || credential.passwordConfigured !== true || typeof credential.passwordUpdatedAt !== 'string')) return null;
    ids.add(binding.id);
    databases.push({
      binding: {
        id: binding.id,
        databaseName: binding.databaseName,
        unixUser: binding.unixUser,
        revision: binding.revision,
      },
      credential: credential ? {
        id: credential.id,
        username: credential.username,
        privileges: [...credential.privileges],
        revision: credential.revision,
        passwordUpdatedAt: credential.passwordUpdatedAt,
      } : null,
    });
  }
  databases.sort((left, right) => left.binding.databaseName.localeCompare(right.binding.databaseName));
  return { websiteId: data.websiteId, applicationId: data.applicationId, databases };
}

export function databaseBackupChoices(jobs, { serverId, databaseName } = {}) {
  if (!Array.isArray(jobs) || !UUID_PATTERN.test(serverId ?? '') || !validDatabaseName(databaseName)) return [];
  const choices = [];
  const ids = new Set();
  for (const job of jobs) {
    const result = job?.result;
    if (!job || typeof job !== 'object' || !BACKUP_ID_PATTERN.test(job.id ?? '') || ids.has(job.id)
      || job.serverId !== serverId || job.operation !== 'database.backup' || job.status !== 'succeeded'
      || job.resourceType !== 'database' || job.resourceId !== databaseName
      || !result || typeof result !== 'object' || result.version !== 1 || result.backupId !== job.id
      || result.databaseName !== databaseName || !['mariadb', 'mysql'].includes(result.engine)
      || typeof result.databaseVersion !== 'string' || result.databaseVersion.length < 1 || result.databaseVersion.length > 120
      || /[\u0000-\u001f\u007f]/.test(result.databaseVersion)
      || !SHA256_PATTERN.test(result.dumpSha256 ?? '')
      || !Number.isSafeInteger(result.dumpBytes) || result.dumpBytes < 1
      || typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt))
      || result.backedUp !== true || result.sideEffects !== true) continue;
    ids.add(job.id);
    choices.push({
      id: job.id,
      createdAt: new Date(result.createdAt).toISOString(),
      dumpBytes: result.dumpBytes,
      engine: result.engine,
      databaseVersion: result.databaseVersion,
      dumpSha256: result.dumpSha256,
    });
  }
  return choices.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function databaseRestorePreviewView(value, { serverId, databaseName, backupId } = {}) {
  if (!value || typeof value !== 'object' || value.version !== 1 || value.operation !== 'database_restore'
    || value.serverId !== serverId || value.databaseName !== databaseName || value.backupId !== backupId
    || !UUID_PATTERN.test(serverId ?? '') || !validDatabaseName(databaseName) || !BACKUP_ID_PATTERN.test(backupId ?? '')
    || !SHA256_PATTERN.test(value.backupSha256 ?? '') || !SHA256_PATTERN.test(value.previewDigest ?? '')
    || !Number.isSafeInteger(value.backupBytes) || value.backupBytes < 1
    || !['mariadb', 'mysql'].includes(value.engine)
    || typeof value.databaseVersion !== 'string' || value.databaseVersion.length < 1 || value.databaseVersion.length > 120
    || /[\u0000-\u001f\u007f]/.test(value.databaseVersion)
    || value.confirmation !== `restore-database:${databaseName}:${value.previewDigest}`
    || value.sideEffects !== false) return null;
  return {
    serverId,
    databaseName,
    backupId,
    backupSha256: value.backupSha256,
    backupBytes: value.backupBytes,
    engine: value.engine,
    databaseVersion: value.databaseVersion,
    previewDigest: value.previewDigest,
    confirmation: value.confirmation,
  };
}

export const databaseModelInternals = Object.freeze({
  databaseNamePattern: DATABASE_NAME_PATTERN,
  reservedDatabases: Object.freeze([...RESERVED_DATABASES]),
  databaseOwnership,
  databaseHealth,
  backupIdPattern: BACKUP_ID_PATTERN,
  sha256Pattern: SHA256_PATTERN,
});
