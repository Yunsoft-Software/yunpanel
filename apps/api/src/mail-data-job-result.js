const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export class MailDataJobResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataJobResultError';
    this.code = code;
  }
}

function invalid(message) {
  throw new MailDataJobResultError('invalid_job_result', message);
}

function safeCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`Mail data ${field} is invalid`);
  return value;
}

function common(job, result, expectedKeys) {
  if (!job || !job.payload || !result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== expectedKeys.length
    || expectedKeys.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1
    || result.mailDomainId !== job.payload.mailDomainId
    || result.scope !== job.payload.scope
    || result.identity !== job.payload.identity
    || typeof result.contentSha256 !== 'string' || !SHA256_PATTERN.test(result.contentSha256)) {
    invalid('Mail data result does not match the queued operation');
  }
  return {
    version: 1,
    mailDomainId: result.mailDomainId,
    scope: result.scope,
    identity: result.identity,
    contentSha256: result.contentSha256,
    bytes: safeCount(result.bytes, 'byte count'),
    files: safeCount(result.files, 'file count'),
    directories: safeCount(result.directories, 'directory count'),
  };
}

export function sanitizeMailDataBackupResult(job, result) {
  const base = common(job, result, [
    'version', 'backupId', 'mailDomainId', 'scope', 'identity', 'sourcePresent',
    'sourceSnapshotSha256', 'contentSha256', 'bytes', 'files', 'directories', 'backedUp', 'sideEffects',
  ]);
  if (result.backupId !== job.id || typeof result.backupId !== 'string' || !BACKUP_ID_PATTERN.test(result.backupId)
    || typeof result.sourcePresent !== 'boolean'
    || result.sourceSnapshotSha256 !== job.payload.expectedSnapshotSha256
    || typeof result.sourceSnapshotSha256 !== 'string' || !SHA256_PATTERN.test(result.sourceSnapshotSha256)
    || result.backedUp !== true || result.sideEffects !== true) {
    invalid('Mail data backup result does not confirm the queued snapshot');
  }
  return Object.freeze({
    ...base,
    backupId: result.backupId,
    sourcePresent: result.sourcePresent,
    sourceSnapshotSha256: result.sourceSnapshotSha256,
    backedUp: true,
    sideEffects: true,
  });
}

export function sanitizeMailDataRestoreResult(job, result) {
  const base = common(job, result, [
    'version', 'transactionId', 'backupId', 'preRestoreBackupId', 'mailDomainId', 'scope', 'identity',
    'contentSha256', 'bytes', 'files', 'directories', 'restoredPresent', 'applied', 'sideEffects',
  ]);
  const expectedPreRestore = `pre-restore:${job.id}`;
  if (result.transactionId !== job.id || typeof result.transactionId !== 'string' || !BACKUP_ID_PATTERN.test(result.transactionId)
    || result.backupId !== job.payload.backupId || typeof result.backupId !== 'string' || !BACKUP_ID_PATTERN.test(result.backupId)
    || result.preRestoreBackupId !== expectedPreRestore || !BACKUP_ID_PATTERN.test(result.preRestoreBackupId)
    || result.restoredPresent !== true || result.applied !== true || result.sideEffects !== true) {
    invalid('Mail data restore result does not confirm the queued restore');
  }
  return Object.freeze({
    ...base,
    transactionId: result.transactionId,
    backupId: result.backupId,
    preRestoreBackupId: result.preRestoreBackupId,
    restoredPresent: true,
    applied: true,
    sideEffects: true,
  });
}

export const mailDataJobResultInternals = Object.freeze({
  sha256Pattern: SHA256_PATTERN,
  backupIdPattern: BACKUP_ID_PATTERN,
  safeCount,
});
