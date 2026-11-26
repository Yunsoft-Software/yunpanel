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

export const DISASTER_RECOVERY_CATEGORIES = Object.freeze([
  'site_files',
  'database',
  'mail',
  'configuration',
  'panel_relationships',
  'encryption_keys',
]);

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const SECRET_VALUE_PATTERNS = [
  /password/i,
  /secret/i,
  /private_?key/i,
  /token/i,
];

function maskSecrets(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (PRIVATE_KEY_PATTERN.test(obj)) return '[REDACTED_PRIVATE_KEY]';
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(maskSecrets);
  }
  if (typeof obj === 'object') {
    const copy = {};
    for (const [key, val] of Object.entries(obj)) {
      if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(key))) {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = maskSecrets(val);
      }
    }
    return copy;
  }
  return obj;
}

export function sanitizeDisasterRecoveryRestoreResult(job, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new DatabaseRestoreJobResultError('invalid_job_result', 'Disaster recovery restore result must be an object');
  }

  // 1. Explicitly reject snapshot listing or backup file creation alone as success criteria
  if (result.snapshotListOnly === true || result.backupFileOnly === true) {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_insufficient_evidence',
      'Snapshot listing or backup file creation alone does not constitute disaster recovery success; verified restore required',
    );
  }

  // 2. Target must be empty and authorized
  if (result.targetWasEmpty !== true) {
    throw new DatabaseRestoreJobResultError(
      'target_not_empty',
      'Disaster recovery target must be an empty directory before restoration',
    );
  }
  if (result.targetAuthorized !== true) {
    throw new DatabaseRestoreJobResultError(
      'target_unauthorized',
      'Disaster recovery target path is not within authorized restore locations',
    );
  }

  // 3. Operational verification (site functionality)
  if (result.operationalVerified !== true) {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_operational_verification_failed',
      'Site operational verification failed after disaster recovery restore',
    );
  }

  // 4. Data integrity verification
  if (result.integrityVerified !== true) {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_integrity_verification_failed',
      'Data integrity verification failed after disaster recovery restore',
    );
  }

  // 5. Scope must cover all 6 categories
  const restoredCats = Array.isArray(result.restoredCategories) ? result.restoredCategories : [];
  const missingCats = DISASTER_RECOVERY_CATEGORIES.filter((cat) => !restoredCats.includes(cat));
  if (missingCats.length > 0) {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_scope_incomplete',
      `Disaster recovery scope is incomplete. Missing categories: ${missingCats.join(', ')}`,
    );
  }

  // 6. Metrics: RPO and RTO
  const metrics = result.metrics;
  if (!metrics || typeof metrics !== 'object') {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_metrics_missing',
      'Disaster recovery metrics (RPO, RTO) are required',
    );
  }
  const { rpoSeconds, acceptableRpoSeconds, rtoSeconds, targetRtoSeconds } = metrics;
  if (typeof rpoSeconds !== 'number' || typeof acceptableRpoSeconds !== 'number' || rpoSeconds < 0 || acceptableRpoSeconds <= 0) {
    throw new DatabaseRestoreJobResultError('invalid_job_result', 'Disaster recovery RPO metrics are invalid');
  }
  if (typeof rtoSeconds !== 'number' || typeof targetRtoSeconds !== 'number' || rtoSeconds < 0 || targetRtoSeconds <= 0) {
    throw new DatabaseRestoreJobResultError('invalid_job_result', 'Disaster recovery RTO metrics are invalid');
  }
  if (rpoSeconds > acceptableRpoSeconds) {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_rpo_exceeded',
      `Data loss (RPO: ${rpoSeconds}s) exceeded acceptable threshold (${acceptableRpoSeconds}s)`,
    );
  }
  if (rtoSeconds > targetRtoSeconds) {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_rto_exceeded',
      `Recovery duration (RTO: ${rtoSeconds}s) exceeded target threshold (${targetRtoSeconds}s)`,
    );
  }

  // 7. Check for unmasked plaintext secrets in result
  const rawJson = JSON.stringify(result);
  if (PRIVATE_KEY_PATTERN.test(rawJson)) {
    throw new DatabaseRestoreJobResultError(
      'disaster_recovery_secret_leak',
      'Disaster recovery result contains unmasked private key; secrets must never be exposed',
    );
  }

  const maskedResult = maskSecrets(result);

  return Object.freeze({
    version: 1,
    recoveryId: result.recoveryId ?? job?.id ?? 'dr-recovery',
    websiteId: result.websiteId ?? null,
    targetPath: result.targetPath,
    targetWasEmpty: true,
    targetAuthorized: true,
    restoredCategories: Object.freeze([...DISASTER_RECOVERY_CATEGORIES]),
    operationalVerified: true,
    integrityVerified: true,
    metrics: Object.freeze({
      rpoSeconds,
      acceptableRpoSeconds,
      dataLossAccepted: rpoSeconds <= acceptableRpoSeconds,
      rtoSeconds,
      targetRtoSeconds,
      recoveryTargetMet: rtoSeconds <= targetRtoSeconds,
    }),
    scope: maskedResult.scope ?? null,
    secretsMasked: true,
    restored: true,
    verified: true,
  });
}
