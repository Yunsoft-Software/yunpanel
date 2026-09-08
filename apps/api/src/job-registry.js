import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOperationEnvelope, OPERATIONS } from '@yunpanel/protocol';

const STORE_VERSION = 1;
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const RESOURCE_TYPES = new Set(['domain', 'server', 'application', 'certificate', 'backup', 'database']);
const ASYNC_OPERATIONS = new Set([
  OPERATIONS.DOMAIN_STAGE,
  OPERATIONS.DOMAIN_ACTIVATE,
  OPERATIONS.SSL_ISSUE,
  OPERATIONS.SSL_RENEW,
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class JobRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'JobRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, jobs: [] };
}

function publicJob(job) {
  return {
    id: job.id,
    serverId: job.serverId,
    type: job.type,
    operation: job.operation,
    resourceType: job.resourceType,
    resourceId: job.resourceId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    attempts: job.attempts,
    result: job.result ?? null,
    error: job.error ?? null,
  };
}

function validateError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  return {
    code: typeof error.code === 'string' ? error.code.slice(0, 120) : 'job_failed',
    message: typeof error.message === 'string' ? error.message.slice(0, 500) : 'Agent job failed',
  };
}

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function sanitizeCertificateMetadata(result) {
  const certName = boundedString(result.certName, 253);
  const certificatePath = boundedString(result.certificatePath, 500);
  const fullchainPath = boundedString(result.fullchainPath, 500);
  const privateKeyPath = boundedString(result.privateKeyPath, 500);
  const validFrom = boundedString(result.validFrom, 80);
  const validTo = boundedString(result.validTo, 80);
  const fingerprint256 = boundedString(result.fingerprint256, 160);

  if (!certName || !certificatePath || !fullchainPath || !privateKeyPath || !validFrom || !validTo || !fingerprint256) {
    throw new JobRegistryError('invalid_job_result', 'Certificate job result metadata is incomplete');
  }

  const sanitized = {
    certName,
    certificatePath,
    fullchainPath,
    privateKeyPath,
    validFrom,
    validTo,
    fingerprint256,
    subject: boundedString(result.subject, 500),
    issuer: boundedString(result.issuer, 500),
    subjectAltName: boundedString(result.subjectAltName, 2000),
  };

  if (Array.isArray(result.domains)) {
    if (result.domains.length < 1 || result.domains.length > 21 || result.domains.some((domain) => !boundedString(domain, 253))) {
      throw new JobRegistryError('invalid_job_result', 'Certificate job result domains are invalid');
    }
    sanitized.domains = [...result.domains];
  }
  if (typeof result.staging === 'boolean') sanitized.staging = result.staging;
  if (typeof result.status === 'string') sanitized.status = result.status.slice(0, 40);
  if (typeof result.dryRun === 'boolean') sanitized.dryRun = result.dryRun;
  return sanitized;
}

function sanitizeResult(job, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new JobRegistryError('invalid_job_result', 'Agent job result must be an object');
  }

  if (job.operation === OPERATIONS.DOMAIN_STAGE) {
    if (typeof result.checksum !== 'string' || !SHA256_PATTERN.test(result.checksum)) {
      throw new JobRegistryError('invalid_job_result', 'Domain staging result requires a SHA-256 checksum');
    }
    if (typeof result.configName !== 'string' || result.configName.length < 1 || result.configName.length > 300) {
      throw new JobRegistryError('invalid_job_result', 'Domain staging result configName is invalid');
    }
    if (!Number.isInteger(result.bytes) || result.bytes < 1 || result.bytes > 2 * 1024 * 1024) {
      throw new JobRegistryError('invalid_job_result', 'Domain staging result byte size is invalid');
    }
    return {
      checksum: result.checksum,
      configName: result.configName,
      bytes: result.bytes,
    };
  }

  if (job.operation === OPERATIONS.DOMAIN_ACTIVATE) {
    if (typeof result.checksum !== 'string' || !SHA256_PATTERN.test(result.checksum)) {
      throw new JobRegistryError('invalid_job_result', 'Domain activation result requires a SHA-256 checksum');
    }
    if (typeof result.configName !== 'string' || result.configName.length < 1 || result.configName.length > 300) {
      throw new JobRegistryError('invalid_job_result', 'Domain activation result configName is invalid');
    }
    if (result.active !== true) {
      throw new JobRegistryError('invalid_job_result', 'Domain activation result must confirm active state');
    }
    return {
      checksum: result.checksum,
      configName: result.configName,
      active: true,
    };
  }

  if (job.operation === OPERATIONS.SSL_ISSUE) {
    return sanitizeCertificateMetadata(result);
  }

  if (job.operation === OPERATIONS.SSL_RENEW) {
    if (result.dryRun === true && result.status === 'validated') {
      const certName = boundedString(result.certName, 253);
      if (!certName) throw new JobRegistryError('invalid_job_result', 'Certificate dry-run result certName is invalid');
      return { certName, dryRun: true, status: 'validated' };
    }
    return sanitizeCertificateMetadata(result);
  }

  throw new JobRegistryError('invalid_operation', 'Agent operation is not supported by the async queue');
}

export function createJobRegistry({ filePath = null, now = () => Date.now() } = {}) {
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();
  let claimChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;

    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.jobs)) {
          throw new Error('unsupported or invalid job registry state');
        }
        state = parsed;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function enqueue({ serverId, type, operation, payload, resourceType, resourceId }) {
    await ensureInitialized();

    if (typeof serverId !== 'string' || !serverId) throw new JobRegistryError('invalid_server', 'serverId is required');
    if (typeof type !== 'string' || type.length < 1 || type.length > 80) throw new JobRegistryError('invalid_job_type', 'Job type is invalid');
    if (!ASYNC_OPERATIONS.has(operation)) throw new JobRegistryError('invalid_operation', 'Agent operation is not supported by the async queue');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JobRegistryError('invalid_payload', 'Job payload must be an object');
    if (!RESOURCE_TYPES.has(resourceType)) throw new JobRegistryError('invalid_resource_type', 'Job resource type is invalid');
    if (typeof resourceId !== 'string' || !resourceId) throw new JobRegistryError('invalid_resource_id', 'Job resource id is required');

    const id = randomUUID();
    try {
      createOperationEnvelope({ id, operation, payload });
    } catch (error) {
      throw new JobRegistryError('invalid_operation_payload', error.message);
    }

    const timestamp = new Date(now()).toISOString();
    const job = {
      id,
      serverId,
      type,
      operation,
      payload,
      resourceType,
      resourceId,
      status: 'queued',
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      result: null,
      error: null,
    };

    state.jobs.push(job);
    await persist();
    return publicJob(job);
  }

  async function claimNext(serverId) {
    await ensureInitialized();

    const claim = claimChain.catch(() => {}).then(async () => {
      const job = state.jobs.find((candidate) => candidate.serverId === serverId && candidate.status === 'queued');
      if (!job) return null;

      job.status = 'running';
      job.startedAt = new Date(now()).toISOString();
      job.attempts += 1;
      await persist();

      return {
        job: publicJob(job),
        envelope: createOperationEnvelope({
          id: job.id,
          operation: job.operation,
          payload: job.payload,
        }),
      };
    });

    claimChain = claim;
    return claim;
  }

  async function complete({ serverId, jobId, status, result = null, error = null }) {
    await ensureInitialized();

    if (!['succeeded', 'failed'].includes(status)) {
      throw new JobRegistryError('invalid_completion_status', 'Agent completion status must be succeeded or failed');
    }

    const job = state.jobs.find((candidate) => candidate.id === jobId && candidate.serverId === serverId);
    if (!job) throw new JobRegistryError('job_not_found', 'Job not found', 404);

    if (job.status === 'succeeded' || job.status === 'failed') {
      if (job.status === status) return publicJob(job);
      throw new JobRegistryError('job_already_completed', 'Job is already completed with a different status', 409);
    }

    if (job.status !== 'running') throw new JobRegistryError('job_not_running', 'Only running jobs may be completed', 409);

    const sanitizedResult = status === 'succeeded' ? sanitizeResult(job, result) : null;
    const sanitizedError = status === 'failed' ? validateError(error) : null;

    job.status = status;
    job.finishedAt = new Date(now()).toISOString();
    job.result = sanitizedResult;
    job.error = sanitizedError;
    await persist();
    return publicJob(job);
  }

  async function cancel(jobId) {
    await ensureInitialized();
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new JobRegistryError('job_not_found', 'Job not found', 404);
    if (job.status !== 'queued') throw new JobRegistryError('job_not_cancellable', 'Only queued jobs may be cancelled', 409);

    job.status = 'cancelled';
    job.finishedAt = new Date(now()).toISOString();
    await persist();
    return publicJob(job);
  }

  async function getJob(jobId) {
    await ensureInitialized();
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job ? publicJob(job) : null;
  }

  async function listJobs({ serverId = null, resourceType = null, resourceId = null, status = null } = {}) {
    await ensureInitialized();
    if (status && !JOB_STATUSES.has(status)) throw new JobRegistryError('invalid_status', 'Job status filter is invalid');

    return state.jobs
      .filter((job) => !serverId || job.serverId === serverId)
      .filter((job) => !resourceType || job.resourceType === resourceType)
      .filter((job) => !resourceId || job.resourceId === resourceId)
      .filter((job) => !status || job.status === status)
      .map(publicJob);
  }

  return {
    init,
    enqueue,
    claimNext,
    complete,
    cancel,
    getJob,
    listJobs,
  };
}
