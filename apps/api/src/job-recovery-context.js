import { readFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RESOURCE_TYPES = new Set(['domain', 'server', 'application', 'certificate', 'backup', 'database', 'system']);
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export class JobRecoveryContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRecoveryContextError';
    this.code = code;
  }
}

function clonePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobRecoveryContextError('job_recovery_context_payload_invalid', 'Recovery job payload is invalid');
  }
  try {
    return structuredClone(value);
  } catch {
    throw new JobRecoveryContextError('job_recovery_context_payload_invalid', 'Recovery job payload is invalid');
  }
}

function normalizeContext(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)
    || typeof job.id !== 'string' || !JOB_ID_PATTERN.test(job.id)
    || typeof job.serverId !== 'string' || !SERVER_ID_PATTERN.test(job.serverId)
    || typeof job.operation !== 'string' || job.operation.length < 1 || job.operation.length > 80
    || typeof job.resourceType !== 'string' || !RESOURCE_TYPES.has(job.resourceType)
    || typeof job.resourceId !== 'string' || job.resourceId.length < 1 || job.resourceId.length > 256
    || typeof job.status !== 'string' || !JOB_STATUSES.has(job.status)) {
    throw new JobRecoveryContextError('job_recovery_context_invalid', 'Recovery job context is invalid');
  }

  return Object.freeze({
    id: job.id,
    serverId: job.serverId,
    operation: job.operation,
    resourceType: job.resourceType,
    resourceId: job.resourceId,
    status: job.status,
    attempts: Number.isSafeInteger(job.attempts) && job.attempts >= 0 ? job.attempts : 0,
    payload: clonePayload(job.payload),
  });
}

export function createJobRecoveryContextReader({ filePath, readFileFn = readFile } = {}) {
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath) || typeof readFileFn !== 'function') {
    throw new JobRecoveryContextError('job_recovery_context_dependencies_invalid', 'Recovery context reader configuration is invalid');
  }

  async function read(jobId) {
    if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
      throw new JobRecoveryContextError('job_recovery_context_identity_invalid', 'Recovery job identity is invalid');
    }

    let parsed;
    try {
      parsed = JSON.parse(await readFileFn(filePath, 'utf8'));
    } catch {
      throw new JobRecoveryContextError('job_recovery_context_read_failed', 'Recovery job state could not be read');
    }
    if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.jobs)) {
      throw new JobRecoveryContextError('job_recovery_context_store_invalid', 'Recovery job state is invalid');
    }

    const matches = parsed.jobs.filter((job) => job?.id === jobId);
    if (matches.length > 1) {
      throw new JobRecoveryContextError('job_recovery_context_duplicate', 'Recovery job identity is duplicated');
    }
    return matches.length === 1 ? normalizeContext(matches[0]) : null;
  }

  return Object.freeze({ read });
}

export const jobRecoveryContextInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  normalizeContext,
  clonePayload,
});
