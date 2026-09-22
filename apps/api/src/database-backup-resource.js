import { createHash } from 'node:crypto';
import { isInfrastructureDatabase } from '@yunpanel/shared';

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const ENGINE_VALUES = new Set(['mariadb', 'mysql']);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RESOURCE_KEYS = new Set(['identity', 'type', 'serverId', 'databaseName', 'snapshot', 'policy']);
const SNAPSHOT_KEYS = new Set(['engine', 'databaseVersion', 'sizeBytes', 'inventoryJobId', 'inventoryRefreshedAt']);
const POLICY_KEYS = new Set(['disposition', 'reason']);

export class DatabaseBackupResourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseBackupResourceError';
    this.code = code;
  }
}

function serverId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DatabaseBackupResourceError('database_backup_resource_server_invalid', 'Database server identity is invalid');
  }
  return value.toLowerCase();
}

function databaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value)
    || isInfrastructureDatabase(value)) {
    throw new DatabaseBackupResourceError('database_backup_resource_name_invalid', 'Database schema name is invalid');
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new DatabaseBackupResourceError('database_backup_resource_snapshot_invalid', 'Database inventory timestamp is invalid');
  }
  return new Date(value).toISOString();
}

function snapshotJobId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DatabaseBackupResourceError('database_backup_resource_snapshot_invalid', 'Database inventory job identity is invalid');
  }
  return value.toLowerCase();
}

export function databaseBackupIdentity({ serverId: requestedServerId, databaseName: requestedName } = {}) {
  const scopedServerId = serverId(requestedServerId);
  const name = databaseName(requestedName);
  const digest = createHash('sha256')
    .update(JSON.stringify(['database', scopedServerId, name.toLowerCase()]))
    .digest('hex');
  return `database:${digest}`;
}

export function normalizeDatabaseBackupResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== RESOURCE_KEYS.size
    || Object.keys(value).some((key) => !RESOURCE_KEYS.has(key))
    || value.type !== 'database') {
    throw new DatabaseBackupResourceError('database_backup_resource_invalid', 'Database backup resource is invalid');
  }
  const scopedServerId = serverId(value.serverId);
  if (expectedServerId !== null && scopedServerId !== serverId(expectedServerId)) {
    throw new DatabaseBackupResourceError('database_backup_resource_server_mismatch', 'Database backup resource belongs to another server');
  }
  const name = databaseName(value.databaseName);
  const expectedIdentity = databaseBackupIdentity({ serverId: scopedServerId, databaseName: name });
  if (value.identity !== expectedIdentity) {
    throw new DatabaseBackupResourceError('database_backup_resource_identity_invalid', 'Database backup resource identity does not match its schema');
  }
  if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)
    || Object.keys(value.snapshot).length !== SNAPSHOT_KEYS.size
    || Object.keys(value.snapshot).some((key) => !SNAPSHOT_KEYS.has(key))
    || typeof value.snapshot.engine !== 'string' || !ENGINE_VALUES.has(value.snapshot.engine)
    || typeof value.snapshot.databaseVersion !== 'string' || value.snapshot.databaseVersion.length < 1
    || value.snapshot.databaseVersion.length > 120 || /[\u0000-\u001f\u007f]/.test(value.snapshot.databaseVersion)
    || !Number.isSafeInteger(value.snapshot.sizeBytes) || value.snapshot.sizeBytes < 0) {
    throw new DatabaseBackupResourceError('database_backup_resource_snapshot_invalid', 'Database backup resource snapshot is invalid');
  }
  if (!value.policy || typeof value.policy !== 'object' || Array.isArray(value.policy)
    || Object.keys(value.policy).length !== POLICY_KEYS.size
    || Object.keys(value.policy).some((key) => !POLICY_KEYS.has(key))
    || value.policy.disposition !== 'include' || value.policy.reason !== 'managed_database') {
    throw new DatabaseBackupResourceError('database_backup_resource_policy_invalid', 'Database backup resource policy is invalid');
  }
  return Object.freeze({
    identity: expectedIdentity,
    type: 'database',
    serverId: scopedServerId,
    databaseName: name,
    snapshot: Object.freeze({
      engine: value.snapshot.engine,
      databaseVersion: value.snapshot.databaseVersion,
      sizeBytes: value.snapshot.sizeBytes,
      inventoryJobId: snapshotJobId(value.snapshot.inventoryJobId),
      inventoryRefreshedAt: timestamp(value.snapshot.inventoryRefreshedAt),
    }),
    policy: Object.freeze({ disposition: 'include', reason: 'managed_database' }),
  });
}

export function databaseBackupResources({ serverId: requestedServerId, inventory } = {}) {
  const scopedServerId = serverId(requestedServerId);
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)
    || typeof inventory.engine !== 'string' || !ENGINE_VALUES.has(inventory.engine)
    || typeof inventory.version !== 'string' || inventory.version.length < 1 || inventory.version.length > 120
    || /[\u0000-\u001f\u007f]/.test(inventory.version)
    || !Array.isArray(inventory.databases)
    || !inventory.snapshot || typeof inventory.snapshot !== 'object' || Array.isArray(inventory.snapshot)) {
    throw new DatabaseBackupResourceError('database_backup_resource_snapshot_invalid', 'Database inventory snapshot is invalid');
  }

  const sourceJobId = snapshotJobId(inventory.snapshot.jobId);
  const refreshedAt = timestamp(inventory.snapshot.refreshedAt);
  const identities = new Set();
  const names = new Set();
  const resources = inventory.databases.filter((database) => !isInfrastructureDatabase(database?.name)
    || SYSTEM_SCHEMAS.has(database.name.toLowerCase())).map((database) => {
    if (!database || typeof database !== 'object' || Array.isArray(database)
      || Object.keys(database).length !== 2
      || !Object.hasOwn(database, 'name') || !Object.hasOwn(database, 'sizeBytes')
      || !Number.isSafeInteger(database.sizeBytes) || database.sizeBytes < 0) {
      throw new DatabaseBackupResourceError('database_backup_resource_snapshot_invalid', 'Database inventory entry is invalid');
    }
    const name = databaseName(database.name);
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new DatabaseBackupResourceError('database_backup_resource_duplicate', 'Database inventory contains duplicate schema identities');
    }
    names.add(normalizedName);
    const identity = databaseBackupIdentity({ serverId: scopedServerId, databaseName: name });
    if (identities.has(identity)) {
      throw new DatabaseBackupResourceError('database_backup_resource_duplicate', 'Database backup resource identity is duplicated');
    }
    identities.add(identity);
    return normalizeDatabaseBackupResource({
      identity,
      type: 'database',
      serverId: scopedServerId,
      databaseName: name,
      snapshot: {
        engine: inventory.engine,
        databaseVersion: inventory.version,
        sizeBytes: database.sizeBytes,
        inventoryJobId: sourceJobId,
        inventoryRefreshedAt: refreshedAt,
      },
      policy: { disposition: 'include', reason: 'managed_database' },
    }, scopedServerId);
  });

  return Object.freeze(resources.sort((left, right) => left.identity.localeCompare(right.identity)));
}

export const databaseBackupResourceInternals = Object.freeze({
  databaseName,
  serverId,
  timestamp,
  snapshotJobId,
});
