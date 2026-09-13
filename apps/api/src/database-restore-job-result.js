const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DatabaseRestoreJobResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseRestoreJobResultError';
    this.code = code;
  }
}

function invalid(message) {
  throw new DatabaseRestoreJobResultError('invalid_job_result', message);
}

export function sanitizeDatabaseRestoreResult(job, result) {
  const expectedKeys = [
    'version', 'transactionId', 'backupId', 'preRestoreBackupId', 'databaseName',
    'engine', 'dumpSha256', 'preRestoreDumpSha256', 'restored', 'verified', 'sideEffects',
  ];
  const expectedPreRestoreId = `pre-restore:${job?.id ?? ''}`;
  if (!job?.payload || !result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== expectedKeys.length
    || expectedKeys.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1 || result.transactionId !== job.id
    || result.backupId !== job.payload.backupId
    || result.preRestoreBackupId !== expectedPreRestoreId
    || result.databaseName !== job.payload.databaseName || result.databaseName !== job.resourceId
    || !['mariadb', 'mysql'].includes(result.engine)
    || result.dumpSha256 !== job.payload.expectedBackupSha256
    || typeof result.dumpSha256 !== 'string' || !SHA256_PATTERN.test(result.dumpSha256)
    || typeof result.preRestoreDumpSha256 !== 'string' || !SHA256_PATTERN.test(result.preRestoreDumpSha256)
    || result.restored !== true || result.verified !== true || result.sideEffects !== true) {
    invalid('Database restore result does not match the queued restore');
  }
  return Object.freeze({
    version: 1,
    transactionId: job.id,
    backupId: result.backupId,
    preRestoreBackupId: expectedPreRestoreId,
    databaseName: result.databaseName,
    engine: result.engine,
    dumpSha256: result.dumpSha256,
    preRestoreDumpSha256: result.preRestoreDumpSha256,
    restored: true,
    verified: true,
    sideEffects: true,
  });
}
