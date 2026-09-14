import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CODE_PATTERN = /^[a-z0-9_]{1,100}$/;

export class NodePassengerMigrationJobResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodePassengerMigrationJobResultError';
    this.code = code;
  }
}

function uuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function serviceName(applicationId) {
  const normalized = uuid(applicationId);
  return normalized
    ? `yunpanel-node-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}.service`
    : null;
}

function safeCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : null;
}

function cleanupEvidence(applicationId, value, migrated) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.complete !== 'boolean'
    || typeof value.stopped !== 'boolean'
    || typeof value.disabled !== 'boolean') {
    throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger migration cleanup evidence is invalid');
  }
  const expectedService = serviceName(applicationId);
  const result = {
    complete: value.complete,
    stopped: value.stopped,
    disabled: value.disabled,
  };
  if (value.serviceName !== undefined) {
    if (value.serviceName !== expectedService) {
      throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger migration cleanup service identity is invalid');
    }
    result.serviceName = value.serviceName;
  }
  if (migrated) {
    if (!value.complete || !value.stopped || !value.disabled || value.serviceName !== expectedService) {
      throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger migration did not confirm legacy systemd cleanup');
    }
    return Object.freeze(result);
  }
  if (value.complete) {
    throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger cleanup-required result cannot report complete cleanup');
  }
  const reason = safeCode(value.reason);
  const cause = safeCode(value.cause);
  if (!reason || !cause) {
    throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger cleanup-required result lacks safe failure evidence');
  }
  return Object.freeze({ ...result, reason, cause });
}

export function sanitizeNodePassengerMigrationResult(job, result) {
  const applicationId = uuid(job?.payload?.node?.applicationId);
  const releaseId = uuid(job?.payload?.node?.releaseId);
  const resultApplicationId = uuid(result?.applicationId);
  const resultReleaseId = uuid(result?.releaseId);
  const state = result?.state;
  const migrated = state === 'migrated';
  const cleanupRequired = state === 'passenger_active_cleanup_required';
  if (!applicationId || !releaseId || resultApplicationId !== applicationId || resultReleaseId !== releaseId
    || (!migrated && !cleanupRequired)
    || result?.satisfied !== migrated
    || result?.targetHealthy !== true
    || typeof result?.resumed !== 'boolean') {
    throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger migration result does not match the queued application release');
  }
  const sourceChecksum = result?.nginx?.sourceChecksum;
  const targetChecksum = result?.nginx?.targetChecksum;
  if (typeof sourceChecksum !== 'string' || !SHA256_PATTERN.test(sourceChecksum)
    || typeof targetChecksum !== 'string' || !SHA256_PATTERN.test(targetChecksum)
    || sourceChecksum === targetChecksum) {
    throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger migration Nginx evidence is invalid');
  }
  return Object.freeze({
    satisfied: migrated,
    state,
    applicationId,
    releaseId,
    targetHealthy: true,
    resumed: result.resumed,
    cleanup: cleanupEvidence(applicationId, result.cleanup, migrated),
    nginx: Object.freeze({ sourceChecksum, targetChecksum }),
  });
}

export const nodePassengerMigrationJobResultInternals = Object.freeze({
  uuid,
  serviceName,
  cleanupEvidence,
});
