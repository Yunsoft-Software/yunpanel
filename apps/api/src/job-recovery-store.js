import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class JobRecoveryStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobRecoveryStoreError';
    this.code = code;
  }
}

function emptyState() {
  return { version: STORE_VERSION, detectedAt: null, jobs: [] };
}

function normalizeJob(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobRecoveryStoreError('invalid_job_recovery_record', 'Job recovery record is invalid');
  }
  const jobId = typeof value.jobId === 'string' && JOB_ID_PATTERN.test(value.jobId) ? value.jobId : null;
  const serverId = typeof value.serverId === 'string' && SERVER_ID_PATTERN.test(value.serverId) ? value.serverId : null;
  if (!jobId || !serverId || Object.keys(value).some((key) => !['jobId', 'serverId'].includes(key))) {
    throw new JobRecoveryStoreError('invalid_job_recovery_record', 'Job recovery record is invalid');
  }
  return { jobId, serverId };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION || !Array.isArray(value.jobs)) {
    throw new JobRecoveryStoreError('invalid_job_recovery_store', 'Job recovery store is invalid');
  }
  const jobs = value.jobs.map(normalizeJob);
  const identities = new Set(jobs.map((job) => `${job.serverId}:${job.jobId}`));
  if (identities.size !== jobs.length) throw new JobRecoveryStoreError('invalid_job_recovery_store', 'Job recovery store contains duplicate jobs');
  const detectedAt = value.detectedAt === null
    ? null
    : typeof value.detectedAt === 'string' && Number.isFinite(Date.parse(value.detectedAt)) ? value.detectedAt : null;
  if (value.jobs.length > 0 && !detectedAt) throw new JobRecoveryStoreError('invalid_job_recovery_store', 'Job recovery store timestamp is invalid');
  if (value.jobs.length === 0 && value.detectedAt !== null) throw new JobRecoveryStoreError('invalid_job_recovery_store', 'Empty job recovery store must not retain a timestamp');
  if (Object.keys(value).some((key) => !['version', 'detectedAt', 'jobs'].includes(key))) {
    throw new JobRecoveryStoreError('invalid_job_recovery_store', 'Job recovery store contains unsupported fields');
  }
  return { version: STORE_VERSION, detectedAt, jobs };
}

function identityKey(job) {
  return `${job.serverId}:${job.jobId}`;
}

export function createJobRecoveryStore({ filePath, now = () => Date.now() } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new JobRecoveryStoreError('job_recovery_store_path_required', 'Job recovery store requires a file path');
  let state = emptyState();
  let initialized = false;
  let mutationTail = Promise.resolve();

  async function init() {
    if (initialized) return;
    try {
      state = normalizeState(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof JobRecoveryStoreError) throw error;
        throw new JobRecoveryStoreError('job_recovery_store_read_failed', 'Job recovery store could not be read');
      }
    }
    initialized = true;
  }

  async function persist(next) {
    const snapshot = `${JSON.stringify(next, null, 2)}\n`;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
    state = next;
  }

  function queueMutation(transform) {
    const operation = mutationTail.catch(() => {}).then(async () => {
      await init();
      const next = transform(state);
      if (next === state) return snapshot();
      await persist(next);
      return snapshot();
    });
    mutationTail = operation;
    return operation;
  }

  async function replace(jobs) {
    if (!Array.isArray(jobs)) throw new JobRecoveryStoreError('invalid_job_recovery_jobs', 'Job recovery jobs must be an array');
    const normalized = jobs.map(normalizeJob);
    const identities = new Set(normalized.map(identityKey));
    if (identities.size !== normalized.length) throw new JobRecoveryStoreError('invalid_job_recovery_jobs', 'Job recovery jobs contain duplicates');
    return queueMutation(() => ({
      version: STORE_VERSION,
      detectedAt: normalized.length > 0 ? new Date(now()).toISOString() : null,
      jobs: normalized,
    }));
  }

  async function add(job) {
    const normalized = normalizeJob(job);
    return queueMutation((current) => {
      if (current.jobs.some((candidate) => identityKey(candidate) === identityKey(normalized))) return current;
      return {
        version: STORE_VERSION,
        detectedAt: current.jobs.length > 0 ? current.detectedAt : new Date(now()).toISOString(),
        jobs: [...current.jobs, normalized],
      };
    });
  }

  async function remove(job) {
    const normalized = normalizeJob(job);
    return queueMutation((current) => {
      const jobs = current.jobs.filter((candidate) => identityKey(candidate) !== identityKey(normalized));
      if (jobs.length === current.jobs.length) return current;
      return {
        version: STORE_VERSION,
        detectedAt: jobs.length > 0 ? current.detectedAt : null,
        jobs,
      };
    });
  }

  function snapshot() {
    return {
      version: state.version,
      detectedAt: state.detectedAt,
      jobs: state.jobs.map((job) => ({ ...job })),
    };
  }

  return { init, replace, add, remove, snapshot };
}

export const jobRecoveryStoreInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  normalizeJob,
  normalizeState,
  identityKey,
});
