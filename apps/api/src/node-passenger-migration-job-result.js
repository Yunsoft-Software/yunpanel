import { createHash } from 'node:crypto';
import path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CODE_PATTERN = /^[a-z0-9_]{1,100}$/;
const TARGET_FIELDS = new Set([
  'appRoot',
  'documentRoot',
  'startupFile',
  'nodeBinary',
  'user',
  'group',
  'appEnv',
  'environmentInclude',
]);

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

function applicationHash(applicationId) {
  const normalized = uuid(applicationId);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

function serviceName(applicationId) {
  const digest = applicationHash(applicationId);
  return digest ? `yunpanel-node-${digest.slice(0, 16)}.service` : null;
}

function applicationUser(applicationId) {
  const digest = applicationHash(applicationId);
  return digest ? `yunapp-${digest.slice(0, 12)}` : null;
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

function passengerTargetEvidence(job, applicationId, value) {
  const runtime = job?.payload?.node?.runtime;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== TARGET_FIELDS.size
    || Object.keys(value).some((field) => !TARGET_FIELDS.has(field))
    || !runtime || typeof runtime !== 'object') {
    throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger migration target evidence is invalid');
  }
  const currentRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
  const expectedAppRoot = runtime.documentRoot === '.'
    ? currentRoot
    : path.posix.join(currentRoot, runtime.documentRoot);
  const expectedUser = applicationUser(applicationId);
  const expectedNodeBinaries = new Set([
    `/opt/yunpanel/node-runtimes/v${runtime.nodeMajor}/bin/node`,
    '/usr/bin/node',
  ]);
  const expectedEnvironmentInclude = `/etc/yunpanel/passenger-env/${applicationId}.conf`;
  if (value.appRoot !== expectedAppRoot
    || value.documentRoot !== expectedAppRoot
    || value.startupFile !== runtime.start?.entryFile
    || !expectedNodeBinaries.has(value.nodeBinary)
    || value.user !== expectedUser
    || value.group !== expectedUser
    || value.appEnv !== runtime.mode
    || value.environmentInclude !== expectedEnvironmentInclude) {
    throw new NodePassengerMigrationJobResultError('invalid_job_result', 'Passenger migration target evidence does not match queued runtime state');
  }
  return Object.freeze({ ...value });
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
    passengerTarget: passengerTargetEvidence(job, applicationId, result.passengerTarget),
  });
}

export const nodePassengerMigrationJobResultInternals = Object.freeze({
  uuid,
  serviceName,
  applicationUser,
  cleanupEvidence,
  passengerTargetEvidence,
});
