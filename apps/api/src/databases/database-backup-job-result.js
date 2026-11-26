const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export class DatabaseBackupJobResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseBackupJobResultError';
    this.code = code;
  }
}

function invalid(message) {
  throw new DatabaseBackupJobResultError('invalid_job_result', message);
}

export function sanitizeDatabaseBackupResult(job, result) {
  const expectedKeys = [
    'version', 'backupId', 'databaseName', 'engine', 'databaseVersion',
    'dumpSha256', 'dumpBytes', 'createdAt', 'backedUp', 'sideEffects',
  ];
  if (!job?.payload || !result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== expectedKeys.length
    || expectedKeys.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1
    || result.backupId !== job.id
    || result.databaseName !== job.payload.databaseName
    || result.databaseName !== job.resourceId
    || !DATABASE_NAME_PATTERN.test(result.databaseName)
    || !['mariadb', 'mysql'].includes(result.engine)
    || typeof result.databaseVersion !== 'string' || result.databaseVersion.length < 1 || result.databaseVersion.length > 120
    || typeof result.dumpSha256 !== 'string' || !SHA256_PATTERN.test(result.dumpSha256)
    || !Number.isSafeInteger(result.dumpBytes) || result.dumpBytes < 1
    || typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt))
    || result.backedUp !== true || result.sideEffects !== true) {
    invalid('Database backup result does not match the queued backup');
  }
  return Object.freeze({
    version: 1,
    backupId: result.backupId,
    databaseName: result.databaseName,
    engine: result.engine,
    databaseVersion: result.databaseVersion,
    dumpSha256: result.dumpSha256,
    dumpBytes: result.dumpBytes,
    createdAt: new Date(result.createdAt).toISOString(),
    backedUp: true,
    sideEffects: true,
  });
}
