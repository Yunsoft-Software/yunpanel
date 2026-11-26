import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const STORE_VERSION = 1;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/;

export class JobIdempotencyLookupError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'JobIdempotencyLookupError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new JobIdempotencyLookupError(code, message, status);
}

function requestDigest(input) {
  return createHash('sha256').update(JSON.stringify({
    serverId: input.serverId,
    type: input.type,
    operation: input.operation,
    payload: input.payload,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  })).digest('hex');
}

function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.serverId !== 'string' || input.serverId.length < 1
    || typeof input.type !== 'string' || input.type.length < 1
    || typeof input.operation !== 'string' || input.operation.length < 1
    || !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)
    || typeof input.resourceType !== 'string' || input.resourceType.length < 1
    || typeof input.resourceId !== 'string' || input.resourceId.length < 1
    || typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    fail('job_idempotency_lookup_request_invalid', 'Job idempotency lookup request is invalid', 400);
  }
  return input;
}

function matchingRecord(store, input) {
  if (!store || store.version !== STORE_VERSION || !Array.isArray(store.jobs)) {
    fail('job_idempotency_lookup_store_invalid', 'Job store is invalid');
  }
  const matches = store.jobs.filter((job) => job?.idempotencyKey === input.idempotencyKey);
  if (matches.length > 1) {
    fail('job_idempotency_lookup_store_invalid', 'Job store contains duplicate idempotency identities');
  }
  if (matches.length === 0) return null;
  const record = matches[0];
  const expectedDigest = requestDigest(input);
  if (record.idempotencyDigest !== expectedDigest
    || record.serverId !== input.serverId
    || record.type !== input.type
    || record.operation !== input.operation
    || record.resourceType !== input.resourceType
    || record.resourceId !== input.resourceId) {
    fail('job_idempotency_lookup_conflict', 'Job idempotency identity belongs to different work');
  }
  return record;
}

export function createJobIdempotencyLookup({ filePath, jobRegistry } = {}) {
  if (typeof filePath !== 'string' || filePath.length < 1
    || !jobRegistry || typeof jobRegistry.getJob !== 'function') {
    throw new JobIdempotencyLookupError(
      'job_idempotency_lookup_dependencies_invalid',
      'Job idempotency lookup dependencies are unavailable',
      503,
    );
  }

  async function find(requestValue) {
    const request = validateRequest(requestValue);
    let store;
    try {
      store = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail('job_idempotency_lookup_store_unavailable', 'Job store could not be read', 503);
    }
    const record = matchingRecord(store, request);
    if (!record) return null;

    let job;
    try { job = await jobRegistry.getJob(record.id); }
    catch {
      fail('job_idempotency_lookup_job_unavailable', 'Persisted job could not be read', 503);
    }
    if (!job
      || job.id !== record.id
      || job.serverId !== request.serverId
      || job.type !== request.type
      || job.operation !== request.operation
      || job.resourceType !== request.resourceType
      || job.resourceId !== request.resourceId) {
      fail('job_idempotency_lookup_state_mismatch', 'Persisted job does not match its idempotency record');
    }
    return job;
  }

  return Object.freeze({ find });
}

export const jobIdempotencyLookupInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  requestDigest,
  validateRequest,
  matchingRecord,
});
