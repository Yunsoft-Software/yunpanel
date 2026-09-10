const RECOVERY_STORE_VERSION = 1;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RECOVERABLE_STATUSES = new Set(['running', 'succeeded', 'failed']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export class JobRecoveryInspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRecoveryInspectionError';
    this.code = code;
  }
}

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function safeTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const jobId = typeof value.jobId === 'string' && JOB_ID_PATTERN.test(value.jobId) ? value.jobId : null;
  const serverId = typeof value.serverId === 'string' && SERVER_ID_PATTERN.test(value.serverId) ? value.serverId : null;
  return jobId && serverId ? { jobId, serverId } : null;
}

function safeRecoveryJob(job, identity = null) {
  if (!job || typeof job !== 'object' || Array.isArray(job) || !RECOVERABLE_STATUSES.has(job.status)) return null;
  const normalized = normalizeIdentity({ jobId: job.id, serverId: job.serverId });
  if (!normalized) return null;
  if (identity && (normalized.jobId !== identity.jobId || normalized.serverId !== identity.serverId)) return null;
  return {
    ...normalized,
    status: job.status,
    operation: boundedString(job.operation, 120),
    resourceType: boundedString(job.resourceType, 80),
    resourceId: boundedString(job.resourceId, 256),
    createdAt: safeTimestamp(job.createdAt),
    startedAt: safeTimestamp(job.startedAt),
    finishedAt: safeTimestamp(job.finishedAt),
    attempts: Number.isSafeInteger(job.attempts) && job.attempts >= 0 ? job.attempts : null,
  };
}

function identityKey(job) {
  return `${job.serverId}:${job.jobId}`;
}

function identitySignature(jobs) {
  return jobs.map(identityKey).sort().join('\n');
}

function recoveryState(jobs) {
  if (jobs.length === 0) return 'clear';
  if (jobs.every((job) => job.status === 'running')) return 'execution_state_unknown';
  if (jobs.every((job) => TERMINAL_STATUSES.has(job.status))) return 'reconciliation_required';
  return 'mixed_recovery_required';
}

function failInvalid() {
  throw new JobRecoveryInspectionError('job_recovery_inspection_invalid', 'Durable job recovery state is inconsistent');
}

export async function inspectDurableJobRecovery({ registry } = {}) {
  if (!registry
    || typeof registry.init !== 'function'
    || typeof registry.listJobs !== 'function'
    || typeof registry.getJob !== 'function'
    || typeof registry.recovery !== 'function'
    || typeof registry.recoveryRecord !== 'function') {
    throw new JobRecoveryInspectionError('job_recovery_registry_required', 'Durable job recovery inspection requires a registry');
  }

  try {
    await registry.init();
  } catch {
    throw new JobRecoveryInspectionError('job_recovery_inspection_unavailable', 'Durable job recovery state could not be inspected');
  }

  let recovery;
  let record;
  let running;
  try {
    recovery = registry.recovery();
    record = registry.recoveryRecord();
    running = await registry.listJobs({ status: 'running' });
  } catch {
    throw new JobRecoveryInspectionError('job_recovery_inspection_unavailable', 'Durable job recovery state could not be inspected');
  }

  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== RECOVERY_STORE_VERSION || !Array.isArray(record.jobs) || !Array.isArray(running)) {
    failInvalid();
  }

  const recordedJobs = record.jobs.map(normalizeIdentity);
  const recoveryJobs = recovery == null ? [] : Array.isArray(recovery.jobs) ? recovery.jobs.map(normalizeIdentity) : [null];
  const runningJobs = running.map((job) => safeRecoveryJob(job));
  if (recordedJobs.some((job) => job === null) || recoveryJobs.some((job) => job === null) || runningJobs.some((job) => job === null)) failInvalid();
  if (identitySignature(recordedJobs) !== identitySignature(recoveryJobs)) failInvalid();

  const recordedKeys = new Set(recordedJobs.map(identityKey));
  if (runningJobs.some((job) => !recordedKeys.has(identityKey(job)))) failInvalid();

  const jobs = [];
  for (const identity of recordedJobs) {
    let job;
    try {
      job = await registry.getJob(identity.jobId);
    } catch {
      throw new JobRecoveryInspectionError('job_recovery_inspection_unavailable', 'Durable job recovery state could not be inspected');
    }
    const safe = safeRecoveryJob(job, identity);
    if (!safe) failInvalid();
    jobs.push(safe);
  }

  const detectedAt = record.detectedAt === null ? null : safeTimestamp(record.detectedAt);
  if ((jobs.length > 0 && !detectedAt) || (jobs.length === 0 && record.detectedAt !== null)) failInvalid();
  const code = recovery == null ? null : boundedString(recovery.code, 120);
  if ((jobs.length > 0 && !code) || (jobs.length === 0 && recovery !== null)) failInvalid();

  return Object.freeze({
    version: RECOVERY_STORE_VERSION,
    state: recoveryState(jobs),
    code,
    detectedAt,
    jobs: Object.freeze(jobs.map((job) => Object.freeze({ ...job }))),
  });
}

export const jobRecoveryInspectionInternals = Object.freeze({
  recoveryStoreVersion: RECOVERY_STORE_VERSION,
  normalizeIdentity,
  safeRecoveryJob,
  identitySignature,
  recoveryState,
});
