const RECOVERY_STORE_VERSION = 1;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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

function safeRunningJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job) || job.status !== 'running') return null;
  const identity = normalizeIdentity({ jobId: job.id, serverId: job.serverId });
  if (!identity) return null;
  return {
    ...identity,
    operation: boundedString(job.operation, 120),
    resourceType: boundedString(job.resourceType, 80),
    resourceId: boundedString(job.resourceId, 256),
    createdAt: safeTimestamp(job.createdAt),
    startedAt: safeTimestamp(job.startedAt),
    attempts: Number.isSafeInteger(job.attempts) && job.attempts >= 0 ? job.attempts : null,
  };
}

function identityKey(job) {
  return `${job.serverId}:${job.jobId}`;
}

function identitySignature(jobs) {
  return jobs.map(identityKey).sort().join('\n');
}

function failInvalid() {
  throw new JobRecoveryInspectionError('job_recovery_inspection_invalid', 'Durable job recovery state is inconsistent');
}

export async function inspectDurableJobRecovery({ registry } = {}) {
  if (!registry
    || typeof registry.init !== 'function'
    || typeof registry.listJobs !== 'function'
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
  const runningJobs = running.map(safeRunningJob);
  if (recordedJobs.some((job) => job === null) || recoveryJobs.some((job) => job === null) || runningJobs.some((job) => job === null)) failInvalid();

  const recordedSignature = identitySignature(recordedJobs);
  const recoverySignature = identitySignature(recoveryJobs);
  const runningSignature = identitySignature(runningJobs);
  if (recordedSignature !== recoverySignature || recoverySignature !== runningSignature) failInvalid();

  const detectedAt = record.detectedAt === null ? null : safeTimestamp(record.detectedAt);
  if ((runningJobs.length > 0 && !detectedAt) || (runningJobs.length === 0 && record.detectedAt !== null)) failInvalid();

  const code = recovery == null ? null : boundedString(recovery.code, 120);
  if (recovery != null && !code) failInvalid();

  return Object.freeze({
    version: RECOVERY_STORE_VERSION,
    state: runningJobs.length > 0 ? 'reconciliation_required' : 'clear',
    code,
    detectedAt,
    jobs: Object.freeze(runningJobs.map((job) => Object.freeze({ ...job }))),
  });
}

export const jobRecoveryInspectionInternals = Object.freeze({
  recoveryStoreVersion: RECOVERY_STORE_VERSION,
  normalizeIdentity,
  safeRunningJob,
  identitySignature,
});
