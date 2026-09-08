import { createHash, randomUUID } from 'node:crypto';
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
  OPERATIONS.APP_STATIC_DEPLOY,
  OPERATIONS.APP_STATIC_ROLLBACK,
  OPERATIONS.APP_NODE_DEPLOY,
  OPERATIONS.APP_NODE_ROLLBACK,
  OPERATIONS.APP_NODE_RESTART,
  OPERATIONS.APP_NODE_STATUS,
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NODE_SERVICE_PATTERN = /^yunpanel-node-[a-f0-9]{16}\.service$/;
const SYSTEMD_STATE_PATTERN = /^[a-z0-9-]{1,40}$/;
const MAX_ARTIFACT_FILES = 100_000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

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

function normalizeUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function sanitizeDomainArray(domains) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21 || domains.some((domain) => !boundedString(domain, 253))) {
    throw new JobRegistryError('invalid_job_result', 'Certificate job result domains are invalid');
  }
  return [...domains];
}

function sanitizeCertificateValidation(result) {
  const certName = boundedString(result.certName, 253);
  if (!certName || result.staging !== true || result.status !== 'validated') {
    throw new JobRegistryError('invalid_job_result', 'Certificate validation result is invalid');
  }
  return { certName, domains: sanitizeDomainArray(result.domains), staging: true, status: 'validated' };
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
  if (Array.isArray(result.domains)) sanitized.domains = sanitizeDomainArray(result.domains);
  if (typeof result.staging === 'boolean') sanitized.staging = result.staging;
  if (typeof result.status === 'string') sanitized.status = result.status.slice(0, 40);
  if (typeof result.dryRun === 'boolean') sanitized.dryRun = result.dryRun;
  return sanitized;
}

function sanitizeReleaseIdentity(job, result) {
  const deploymentId = normalizeUuid(result.deploymentId);
  const releaseId = normalizeUuid(result.releaseId);
  const expectedDeploymentId = normalizeUuid(job.payload?.deploymentId);
  if (!deploymentId || !releaseId || deploymentId !== expectedDeploymentId || releaseId !== deploymentId) {
    throw new JobRegistryError('invalid_job_result', 'Deployment result identity does not match the queued deployment');
  }
  const previousReleaseId = result.previousReleaseId == null ? null : normalizeUuid(result.previousReleaseId);
  if (result.previousReleaseId != null && !previousReleaseId) {
    throw new JobRegistryError('invalid_job_result', 'Deployment previous release identity is invalid');
  }
  if (typeof result.commitSha !== 'string' || !COMMIT_PATTERN.test(result.commitSha)) {
    throw new JobRegistryError('invalid_job_result', 'Deployment commit SHA is invalid');
  }
  return {
    deploymentId,
    releaseId,
    previousReleaseId,
    commitSha: result.commitSha.toLowerCase(),
  };
}

function sanitizeStaticDeploymentResult(job, result) {
  const identity = sanitizeReleaseIdentity(job, result);
  if (!Number.isInteger(result.artifactFiles) || result.artifactFiles < 1 || result.artifactFiles > MAX_ARTIFACT_FILES) {
    throw new JobRegistryError('invalid_job_result', 'Static deployment artifact file count is invalid');
  }
  if (!Number.isInteger(result.artifactBytes) || result.artifactBytes < 0 || result.artifactBytes > MAX_ARTIFACT_BYTES) {
    throw new JobRegistryError('invalid_job_result', 'Static deployment artifact byte size is invalid');
  }
  return {
    ...identity,
    artifactFiles: result.artifactFiles,
    artifactBytes: result.artifactBytes,
  };
}

function expectedNodeServiceName(applicationId) {
  const normalizedId = normalizeUuid(applicationId);
  if (!normalizedId) return null;
  const digest = createHash('sha256').update(normalizedId).digest('hex').slice(0, 16);
  return `yunpanel-node-${digest}.service`;
}

function validateManagedNodeResult(job, result, action) {
  const releaseId = normalizeUuid(result.releaseId);
  const expectedReleaseId = normalizeUuid(job.payload?.releaseId);
  const expectedService = expectedNodeServiceName(job.payload?.applicationId);
  if (!releaseId || releaseId !== expectedReleaseId) {
    throw new JobRegistryError('invalid_job_result', `Node ${action} release state does not match the queued operation`);
  }
  if (!expectedService || typeof result.serviceName !== 'string' || !NODE_SERVICE_PATTERN.test(result.serviceName) || result.serviceName !== expectedService) {
    throw new JobRegistryError('invalid_job_result', `Node ${action} service identity is invalid`);
  }
  if (!Number.isInteger(result.port) || result.port !== job.payload?.runtime?.port) {
    throw new JobRegistryError('invalid_job_result', `Node ${action} port does not match desired state`);
  }
  if (typeof result.healthPath !== 'string' || result.healthPath !== job.payload?.runtime?.healthPath) {
    throw new JobRegistryError('invalid_job_result', `Node ${action} health path does not match desired state`);
  }
  return { releaseId, serviceName: result.serviceName, port: result.port, healthPath: result.healthPath };
}

function sanitizeNodeDeploymentResult(job, result) {
  const identity = sanitizeReleaseIdentity(job, result);
  const expectedService = expectedNodeServiceName(job.payload?.applicationId);
  if (!expectedService || typeof result.serviceName !== 'string' || !NODE_SERVICE_PATTERN.test(result.serviceName) || result.serviceName !== expectedService) {
    throw new JobRegistryError('invalid_job_result', 'Node deployment service identity is invalid');
  }
  if (!Number.isInteger(result.port) || result.port !== job.payload?.runtime?.port) {
    throw new JobRegistryError('invalid_job_result', 'Node deployment port does not match desired state');
  }
  if (typeof result.healthPath !== 'string' || result.healthPath !== job.payload?.runtime?.healthPath) {
    throw new JobRegistryError('invalid_job_result', 'Node deployment health path does not match desired state');
  }
  if (result.healthy !== true) {
    throw new JobRegistryError('invalid_job_result', 'Node deployment must confirm healthy state');
  }
  return {
    ...identity,
    serviceName: result.serviceName,
    port: result.port,
    healthPath: result.healthPath,
    healthy: true,
  };
}

function sanitizeStaticRollbackResult(job, result) {
  const releaseId = normalizeUuid(result.releaseId);
  const expectedReleaseId = normalizeUuid(job.payload?.releaseId);
  const previousReleaseId = normalizeUuid(result.previousReleaseId);
  if (!releaseId || releaseId !== expectedReleaseId || !previousReleaseId || result.active !== true) {
    throw new JobRegistryError('invalid_job_result', 'Static rollback result does not match the queued rollback');
  }
  if (previousReleaseId === releaseId) {
    throw new JobRegistryError('invalid_job_result', 'Static rollback previous release cannot equal the target release');
  }
  return { releaseId, previousReleaseId, active: true };
}

function sanitizeNodeRollbackResult(job, result) {
  const managed = validateManagedNodeResult(job, result, 'rollback');
  const previousReleaseId = normalizeUuid(result.previousReleaseId);
  if (!previousReleaseId || previousReleaseId === managed.releaseId) {
    throw new JobRegistryError('invalid_job_result', 'Node rollback previous release state is invalid');
  }
  if (result.healthy !== true || result.active !== true) {
    throw new JobRegistryError('invalid_job_result', 'Node rollback must confirm healthy active state');
  }
  return { ...managed, previousReleaseId, healthy: true, active: true };
}

function sanitizeNodeRestartResult(job, result) {
  const managed = validateManagedNodeResult(job, result, 'restart');
  if (result.healthy !== true || result.restarted !== true) {
    throw new JobRegistryError('invalid_job_result', 'Node restart must confirm a healthy restarted service');
  }
  return { ...managed, healthy: true, restarted: true };
}

function sanitizeNodeStatusResult(job, result) {
  const managed = validateManagedNodeResult(job, result, 'status');
  for (const [field, value] of [
    ['loadState', result.loadState],
    ['activeState', result.activeState],
    ['subState', result.subState],
  ]) {
    if (typeof value !== 'string' || !SYSTEMD_STATE_PATTERN.test(value)) {
      throw new JobRegistryError('invalid_job_result', `Node status ${field} is invalid`);
    }
  }
  if (!Number.isSafeInteger(result.restartCount) || result.restartCount < 0) {
    throw new JobRegistryError('invalid_job_result', 'Node status restart count is invalid');
  }
  if (!Number.isSafeInteger(result.mainPid) || result.mainPid < 0) {
    throw new JobRegistryError('invalid_job_result', 'Node status main PID is invalid');
  }
  if (typeof result.healthy !== 'boolean' || typeof result.inspectionError !== 'boolean') {
    throw new JobRegistryError('invalid_job_result', 'Node status health metadata is invalid');
  }
  return {
    ...managed,
    loadState: result.loadState,
    activeState: result.activeState,
    subState: result.subState,
    restartCount: result.restartCount,
    mainPid: result.mainPid,
    healthy: result.healthy,
    inspectionError: result.inspectionError,
  };
}

function sanitizeResult(job, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new JobRegistryError('invalid_job_result', 'Agent job result must be an object');
  }

  if (job.operation === OPERATIONS.DOMAIN_STAGE) {
    if (typeof result.checksum !== 'string' || !SHA256_PATTERN.test(result.checksum)) throw new JobRegistryError('invalid_job_result', 'Domain staging result requires a SHA-256 checksum');
    if (typeof result.configName !== 'string' || result.configName.length < 1 || result.configName.length > 300) throw new JobRegistryError('invalid_job_result', 'Domain staging result configName is invalid');
    if (!Number.isInteger(result.bytes) || result.bytes < 1 || result.bytes > 2 * 1024 * 1024) throw new JobRegistryError('invalid_job_result', 'Domain staging result byte size is invalid');
    return { checksum: result.checksum, configName: result.configName, bytes: result.bytes };
  }

  if (job.operation === OPERATIONS.DOMAIN_ACTIVATE) {
    if (typeof result.checksum !== 'string' || !SHA256_PATTERN.test(result.checksum)) throw new JobRegistryError('invalid_job_result', 'Domain activation result requires a SHA-256 checksum');
    if (typeof result.configName !== 'string' || result.configName.length < 1 || result.configName.length > 300) throw new JobRegistryError('invalid_job_result', 'Domain activation result configName is invalid');
    if (result.active !== true) throw new JobRegistryError('invalid_job_result', 'Domain activation result must confirm active state');
    return { checksum: result.checksum, configName: result.configName, active: true };
  }

  if (job.operation === OPERATIONS.SSL_ISSUE) {
    if (result.staging === true) return sanitizeCertificateValidation(result);
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

  if (job.operation === OPERATIONS.APP_STATIC_DEPLOY) return sanitizeStaticDeploymentResult(job, result);
  if (job.operation === OPERATIONS.APP_STATIC_ROLLBACK) return sanitizeStaticRollbackResult(job, result);
  if (job.operation === OPERATIONS.APP_NODE_DEPLOY) return sanitizeNodeDeploymentResult(job, result);
  if (job.operation === OPERATIONS.APP_NODE_ROLLACK) return sanitizeNodeRollbackResult(job, result);
  if (job.operation === OPERATIONS.APP_NODE_RESTART) return sanitizeNodeRestartResult(job, result);
  if (job.operation === OPERATIONS.APP_NODE_STATUS) return sanitizeNodeStatusResult(job, result);
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
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.jobs)) throw new Error('unsupported or invalid job registry state');
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
    const deploymentOperation = operation === OPERATIONS.APP_STATIC_DEPLOY || operation === OPERATIONS.APP_NODE_DEPLOY;
    const effectivePayload = deploymentOperation ? { ...payload, deploymentId: id } : payload;
    try {
      createOperationEnvelope({ id, operation, payload: effectivePayload });
    } catch (error) {
      throw new JobRegistryError('invalid_operation_payload', error.message);
    }

    const timestamp = new Date(now()).toISOString();
    const job = {
      id,
      serverId,
      type,
      operation,
      payload: effectivePayload,
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
      return { job: publicJob(job), envelope: createOperationEnvelope({ id: job.id, operation: job.operation, payload: job.payload }) };
    });
    claimChain = claim;
    return claim;
  }

  async function complete({ serverId, jobId, status, result = null, error = null }) {
    await ensureInitialized();
    if (!['succeeded', 'failed'].includes(status)) throw new JobRegistryError('invalid_completion_status', 'Agent completion status must be succeeded or failed');
    const job = state.jobs.find((candidate) => candidate.id === jobId && candidate.serverId === serverId);
    if (!job) throw new JobRegistryError('job_not_found', 'Job not found', 404);
    if (job.status === 'succeeded' || job.status === 'failed') {
      if (job.status === status) return publicJob(job);
      throw new JobRegistryError('job_already_completed', 'Job is already completed with a different status', 409);
    }
    if (job.status !== 'running') throw new JobRegistryError('job_not_running', 'Only running jobs may be completed', 409);

    job.result = status === 'succeeded' ? sanitizeResult(job, result) : null;
    job.error = status === 'failed' ? validateError(error) : null;
    job.status = status;
    job.finishedAt = new Date(now()).toISOString();
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

  return { init, enqueue, claimNext, complete, cancel, getJob, listJobs };
}
