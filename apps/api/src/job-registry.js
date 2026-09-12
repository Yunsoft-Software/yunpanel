import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createOperationEnvelope,
  MANAGED_SERVICE_ACTIONS,
  MANAGED_SERVICE_IDS,
  MANAGED_NODE_RUNTIME_MAJORS,
  OPERATIONS,
} from '@yunpanel/protocol';
import { normalizeGitDeploymentTarget, sanitizeLogMessage } from '@yunpanel/shared';
import { sanitizeDatabaseJobResult } from './database-job-result.js';
import { safeLocalOperationError } from './local-execution-error.js';
import { managedServiceStatePolicy } from './managed-service-state-policy.js';
import { operationErrorDiagnosis } from './operation-diagnosis.js';

const STORE_VERSION = 1;
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const RESOURCE_TYPES = new Set(['domain', 'server', 'application', 'certificate', 'backup', 'database', 'dns_zone', 'mail_domain', 'system']);
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
  OPERATIONS.APP_NODE_PROCESS,
  OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT,
  OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL,
  OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  OPERATIONS.SYSTEM_SERVICES_INSPECT,
  OPERATIONS.SYSTEM_SERVICE_INSTALL,
  OPERATIONS.SYSTEM_SERVICE_CONTROL,
  OPERATIONS.SYSTEM_UPGRADE,
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
  OPERATIONS.DNS_RECORD_APPLY,
  OPERATIONS.MAIL_CONFIG_APPLY,
  OPERATIONS.MAIL_DKIM_APPLY,
  OPERATIONS.ROUNDCUBE_CONFIG_APPLY,
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NODE_SERVICE_PATTERN = /^yunpanel-node-[a-f0-9]{16}\.service$/;
const SYSTEMD_STATE_PATTERN = /^[a-z0-9-]{1,40}$/;
const PACKAGE_VERSION_PATTERN = /^[A-Za-z0-9.+:~_-]{1,100}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,100}$/;
const SYSTEMD_UNIT_PATTERN = /^[a-z0-9@_.-]{1,120}\.service$/;
const NODE_VERSION_PATTERN = /^v(\d{1,2})\.\d{1,3}\.\d{1,3}$/;
const MANAGED_SERVICE_ID_SET = new Set(MANAGED_SERVICE_IDS);
const MANAGED_SERVICE_ACTION_SET = new Set(MANAGED_SERVICE_ACTIONS);
const MANAGED_SERVICE_HEALTH_STATUS_SET = new Set([
  'ready', 'installed', 'not_installed', 'inactive', 'unknown', 'configuration_invalid',
]);
const MANAGED_SERVICE_CONFIGURATION_STATUS_SET = new Set([
  'not_checked', 'not_applicable', 'valid', 'invalid',
]);
const MAX_ARTIFACT_FILES = 100_000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/;
const enqueueCreated = Symbol('yunpanel.job.enqueueCreated');

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
    result: job.result == null ? null : structuredClone(job.result),
    error: job.error == null ? null : structuredClone(job.error),
  };
}

function publicResult(operation, result) {
  if (result === null || result === undefined) return null;
  if (operation === OPERATIONS.SSL_ISSUE || operation === OPERATIONS.SSL_RENEW) {
    const output = {};
    for (const field of ['certName', 'validFrom', 'validTo', 'fingerprint256', 'status']) {
      if (typeof result[field] === 'string') output[field] = sanitizeLogMessage(result[field]).message.slice(0, 253);
    }
    for (const [field, limit] of [['subject', 500], ['issuer', 500], ['subjectAltName', 2000]]) {
      if (typeof result[field] === 'string') output[field] = sanitizeLogMessage(result[field]).message.slice(0, limit);
      else if (result[field] === null) output[field] = null;
    }
    if (Array.isArray(result.domains)) {
      output.domains = result.domains.filter((domain) => typeof domain === 'string').slice(0, 21)
        .map((domain) => sanitizeLogMessage(domain).message.slice(0, 253));
    }
    if (typeof result.staging === 'boolean') output.staging = result.staging;
    if (typeof result.dryRun === 'boolean') output.dryRun = result.dryRun;
    return output;
  }
  return structuredClone(result);
}

function diagnosisScope(operation) {
  if (operation === OPERATIONS.DOMAIN_STAGE || operation === OPERATIONS.DOMAIN_ACTIVATE) return 'nginx';
  if (operation === OPERATIONS.DNS_RECORD_APPLY) return 'dns';
  if (operation === OPERATIONS.SSL_ISSUE || operation === OPERATIONS.SSL_RENEW) return 'certificate';
  return null;
}

export function jobPublicView(job) {
  if (!job || typeof job !== 'object') return null;
  const view = publicJob(job);
  view.result = publicResult(job.operation, job.result);
  view.error = job.error ? safeLocalOperationError(job.error) : null;
  const scope = job.status === 'failed' ? diagnosisScope(job.operation) : null;
  if (scope) view.diagnosis = operationErrorDiagnosis(scope, view.error?.code);
  return Object.freeze(view);
}

function enqueueResult(job, created) {
  const result = publicJob(job);
  Object.defineProperty(result, enqueueCreated, { value: created === true });
  return result;
}

export function isNewlyEnqueuedJob(job) {
  return typeof job?.[enqueueCreated] === 'boolean' ? job[enqueueCreated] : null;
}

function idempotencyDigest(input) {
  return createHash('sha256').update(JSON.stringify({
    serverId: input.serverId,
    type: input.type,
    operation: input.operation,
    payload: input.payload,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  })).digest('hex');
}

function validateError(error) {
  return safeLocalOperationError(error);
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
  let gitTarget;
  try { gitTarget = normalizeGitDeploymentTarget(job.payload?.gitTarget, { defaultBranch: job.payload?.branch ?? 'main' }); }
  catch { throw new JobRegistryError('invalid_job_result', 'Deployment Git target is invalid'); }
  if (gitTarget.kind === 'commit' && result.commitSha.toLowerCase() !== gitTarget.value) {
    throw new JobRegistryError('invalid_job_result', 'Deployment commit SHA does not match the requested Git target');
  }
  return {
    deploymentId,
    releaseId,
    previousReleaseId,
    commitSha: result.commitSha.toLowerCase(),
    gitTarget,
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

function sanitizedEnvironmentRevision(job) {
  const revision = job.payload?.environmentRevision;
  if (revision === undefined) return {};
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new JobRegistryError('invalid_job_result', 'Queued environment revision is invalid');
  }
  return { environmentRevision: revision };
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
    ...sanitizedEnvironmentRevision(job),
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
  return { ...managed, ...sanitizedEnvironmentRevision(job), previousReleaseId, healthy: true, active: true };
}

function sanitizeNodeRestartResult(job, result) {
  const managed = validateManagedNodeResult(job, result, 'restart');
  if (result.healthy !== true || result.restarted !== true) {
    throw new JobRegistryError('invalid_job_result', 'Node restart must confirm a healthy restarted service');
  }
  return { ...managed, ...sanitizedEnvironmentRevision(job), healthy: true, restarted: true };
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

function sanitizeNodeProcessResult(job, result) {
  const managed = validateManagedNodeResult(job, result, 'process');
  if (result.action !== job.payload?.action || !['enable', 'disable', 'start', 'stop'].includes(result.action)) {
    throw new JobRegistryError('invalid_job_result', 'Node process action does not match the queued operation');
  }
  for (const field of ['loadState', 'activeState', 'subState', 'unitFileState']) {
    if (typeof result[field] !== 'string' || !SYSTEMD_STATE_PATTERN.test(result[field])) {
      throw new JobRegistryError('invalid_job_result', `Node process ${field} is invalid`);
    }
  }
  if (result.loadState !== 'loaded' || !Number.isSafeInteger(result.mainPid) || result.mainPid < 0
    || typeof result.enabled !== 'boolean' || typeof result.active !== 'boolean' || typeof result.healthy !== 'boolean'
    || result.enabled !== (result.unitFileState === 'enabled')
    || result.active !== (result.activeState === 'active')) {
    throw new JobRegistryError('invalid_job_result', 'Node process state is inconsistent');
  }
  if ((result.action === 'enable' && !result.enabled)
    || (result.action === 'disable' && result.unitFileState !== 'disabled')
    || (result.action === 'start' && (!result.active || !result.healthy || result.mainPid < 1))
    || (result.action === 'stop' && (result.activeState !== 'inactive' || result.healthy || result.mainPid !== 0))) {
    throw new JobRegistryError('invalid_job_result', 'Node process result does not confirm the requested state');
  }
  return {
    ...managed,
    action: result.action,
    loadState: result.loadState,
    activeState: result.activeState,
    subState: result.subState,
    unitFileState: result.unitFileState,
    mainPid: result.mainPid,
    enabled: result.enabled,
    active: result.active,
    healthy: result.healthy,
  };
}

function sanitizeNodeExecutable(value, source, expectedMajor = null, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const match = typeof value?.version === 'string' ? value.version.match(NODE_VERSION_PATTERN) : null;
  const major = match ? Number.parseInt(match[1], 10) : null;
  const expectedPath = source === 'panel' ? '/usr/local/bin/node'
    : source === 'system' ? '/usr/bin/node'
      : `/opt/yunpanel/node-runtimes/v${expectedMajor}/bin/node`;
  if (!match || !Number.isInteger(major) || (expectedMajor !== null && major !== expectedMajor)
    || value.path !== expectedPath || value.source !== source) {
    throw new JobRegistryError('invalid_job_result', `Node ${source} runtime metadata is invalid`);
  }
  return { path: expectedPath, source, version: value.version, major };
}

function sanitizeManagedNodeRuntime(value, expectedMajor) {
  if (!value || value.major !== expectedMajor || typeof value.installed !== 'boolean'
    || value.path !== `/opt/yunpanel/node-runtimes/v${expectedMajor}/bin/node`
    || (value.installed ? typeof value.version !== 'string' : value.version !== null)
    || !Array.isArray(value.packageManagers)) {
    throw new JobRegistryError('invalid_job_result', 'Managed Node runtime inventory is invalid');
  }
  const packageManagers = [...value.packageManagers];
  if (new Set(packageManagers).size !== packageManagers.length
    || packageManagers.some((name) => !['npm', 'pnpm', 'yarn'].includes(name))
    || (!value.installed && packageManagers.length > 0)) {
    throw new JobRegistryError('invalid_job_result', 'Managed Node runtime package-manager inventory is invalid');
  }
  if (value.installed) sanitizeNodeExecutable({ ...value, source: 'managed' }, 'managed', expectedMajor);
  return { major: expectedMajor, installed: value.installed, path: value.path, version: value.version, packageManagers };
}

function sanitizeNodeRuntimeInventory(result) {
  if (!result || result.platform !== 'linux' || !['x64', 'arm64'].includes(result.architecture)
    || !Array.isArray(result.supportedMajors)
    || result.supportedMajors.length !== MANAGED_NODE_RUNTIME_MAJORS.length
    || result.supportedMajors.some((major, index) => major !== MANAGED_NODE_RUNTIME_MAJORS[index])
    || !Array.isArray(result.managedRuntimes)
    || result.managedRuntimes.length !== MANAGED_NODE_RUNTIME_MAJORS.length) {
    throw new JobRegistryError('invalid_job_result', 'Managed Node runtime inventory metadata is invalid');
  }
  return {
    platform: 'linux',
    architecture: result.architecture,
    supportedMajors: [...MANAGED_NODE_RUNTIME_MAJORS],
    panelRuntime: sanitizeNodeExecutable(result.panelRuntime, 'panel', null, { nullable: true }),
    systemRuntime: sanitizeNodeExecutable(result.systemRuntime, 'system', null, { nullable: true }),
    managedRuntimes: MANAGED_NODE_RUNTIME_MAJORS.map((major, index) => sanitizeManagedNodeRuntime(result.managedRuntimes[index], major)),
  };
}

function sanitizeNodeRuntimeInstallResult(job, result) {
  const expectedMajor = job.payload?.major;
  if (!MANAGED_NODE_RUNTIME_MAJORS.includes(expectedMajor) || typeof result?.changed !== 'boolean'
    || !result.runtime || result.runtime.major !== expectedMajor || result.runtime.source !== 'managed'
    || !Array.isArray(result.runtime.packageManagers)) {
    throw new JobRegistryError('invalid_job_result', 'Managed Node runtime installation result is invalid');
  }
  const runtime = sanitizeNodeExecutable(result.runtime, 'managed', expectedMajor);
  const packageManagers = [...result.runtime.packageManagers];
  if (packageManagers.length !== 3 || packageManagers.some((name, index) => name !== ['npm', 'pnpm', 'yarn'][index])) {
    throw new JobRegistryError('invalid_job_result', 'Managed Node runtime installation package managers are invalid');
  }
  const inventory = sanitizeNodeRuntimeInventory(result.inventory);
  const installed = inventory.managedRuntimes.find((entry) => entry.major === expectedMajor);
  if (!installed?.installed || installed.version !== runtime.version) {
    throw new JobRegistryError('invalid_job_result', 'Managed Node runtime installation is not confirmed by inventory');
  }
  return { changed: result.changed, runtime: { ...runtime, packageManagers }, inventory };
}

function sanitizePackageVersion(value, field, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !PACKAGE_VERSION_PATTERN.test(value)) {
    throw new JobRegistryError('invalid_job_result', `System package ${field} is invalid`);
  }
  return value;
}

function sanitizeSystemPackageResult(job, result) {
  if (result.packageName !== 'yunpanel') {
    throw new JobRegistryError('invalid_job_result', 'System package result must describe YunPanel');
  }
  const installedVersion = sanitizePackageVersion(result.installedVersion, 'installedVersion', { optional: true });
  const candidateVersion = sanitizePackageVersion(result.candidateVersion, 'candidateVersion', { optional: true });
  if (typeof result.installed !== 'boolean' || result.installed !== Boolean(installedVersion)) {
    throw new JobRegistryError('invalid_job_result', 'System package installed state is invalid');
  }
  const expectedUpdate = Boolean(installedVersion && candidateVersion && installedVersion !== candidateVersion);
  if (typeof result.updateAvailable !== 'boolean' || result.updateAvailable !== expectedUpdate) {
    throw new JobRegistryError('invalid_job_result', 'System package update state is invalid');
  }
  const sanitized = {
    packageName: 'yunpanel',
    installed: result.installed,
    installedVersion,
    candidateVersion,
    updateAvailable: result.updateAvailable,
  };
  if (job.operation === OPERATIONS.SYSTEM_PACKAGES_INSPECT) return sanitized;

  const previousVersion = sanitizePackageVersion(result.previousVersion, 'previousVersion');
  if (typeof result.upgraded !== 'boolean' || typeof result.restartScheduled !== 'boolean') {
    throw new JobRegistryError('invalid_job_result', 'System upgrade completion state is invalid');
  }
  if (result.upgraded && (!installedVersion || installedVersion === previousVersion || !result.restartScheduled)) {
    throw new JobRegistryError('invalid_job_result', 'System upgrade did not report a valid version transition');
  }
  if (!result.upgraded && (installedVersion !== previousVersion || result.restartScheduled)) {
    throw new JobRegistryError('invalid_job_result', 'No-op system upgrade result is inconsistent');
  }
  return { ...sanitized, previousVersion, upgraded: result.upgraded, restartScheduled: result.restartScheduled };
}

function sanitizeManagedServicePackage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobRegistryError('invalid_job_result', 'Managed service package state is invalid');
  if (typeof value.packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(value.packageName)) throw new JobRegistryError('invalid_job_result', 'Managed service package name is invalid');
  if (typeof value.installed !== 'boolean') throw new JobRegistryError('invalid_job_result', 'Managed service package installed state is invalid');
  const version = value.version == null ? null : sanitizePackageVersion(value.version, 'managedServiceVersion');
  if (value.installed !== Boolean(version)) throw new JobRegistryError('invalid_job_result', 'Managed service package version state is inconsistent');
  return { packageName: value.packageName, installed: value.installed, version };
}

function sanitizeManagedServiceUnit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobRegistryError('invalid_job_result', 'Managed service unit state is invalid');
  if (typeof value.unit !== 'string' || !SYSTEMD_UNIT_PATTERN.test(value.unit)) throw new JobRegistryError('invalid_job_result', 'Managed service unit name is invalid');
  const unit = { unit: value.unit };
  for (const field of ['loadState', 'activeState', 'subState', 'unitFileState']) {
    if (typeof value[field] !== 'string' || !SYSTEMD_STATE_PATTERN.test(value[field])) {
      throw new JobRegistryError('invalid_job_result', `Managed service ${field} is invalid`);
    }
    unit[field] = value[field];
  }
  if (typeof value.inspectionError !== 'boolean') throw new JobRegistryError('invalid_job_result', 'Managed service inspection state is invalid');
  unit.inspectionError = value.inspectionError;
  return unit;
}

function sanitizeManagedServiceHealth(value, { policy, installed, active, units }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.status !== 'string' || !MANAGED_SERVICE_HEALTH_STATUS_SET.has(value.status)
    || typeof value.configuration !== 'string' || !MANAGED_SERVICE_CONFIGURATION_STATUS_SET.has(value.configuration)) {
    throw new JobRegistryError('invalid_job_result', 'Managed service health state is invalid');
  }
  const expectedConfiguration = !installed
    ? 'not_checked'
    : policy.checksConfiguration ? null : 'not_applicable';
  if ((expectedConfiguration && value.configuration !== expectedConfiguration)
    || (expectedConfiguration === null && !['valid', 'invalid'].includes(value.configuration))) {
    throw new JobRegistryError('invalid_job_result', 'Managed service configuration health is inconsistent');
  }
  const expectedStatus = !installed
    ? 'not_installed'
    : units.some((entry) => entry.inspectionError)
      ? 'unknown'
      : value.configuration === 'invalid'
        ? 'configuration_invalid'
        : units.length === 0 ? 'installed' : !active ? 'inactive' : 'ready';
  if (value.status !== expectedStatus) {
    throw new JobRegistryError('invalid_job_result', 'Managed service aggregate health is inconsistent');
  }
  return { status: value.status, configuration: value.configuration };
}

function sanitizeManagedServiceState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobRegistryError('invalid_job_result', 'Managed service state is invalid');
  if (typeof value.id !== 'string' || !MANAGED_SERVICE_ID_SET.has(value.id)) throw new JobRegistryError('invalid_job_result', 'Managed service id is invalid');
  const policy = managedServiceStatePolicy(value.id);
  if (typeof value.installed !== 'boolean' || typeof value.active !== 'boolean') throw new JobRegistryError('invalid_job_result', 'Managed service status is invalid');
  if (!Array.isArray(value.packages) || value.packages.length < 1 || value.packages.length > 8) throw new JobRegistryError('invalid_job_result', 'Managed service package list is invalid');
  if (!Array.isArray(value.units) || value.units.length !== policy.units.length) {
    throw new JobRegistryError('invalid_job_result', 'Managed service unit list is invalid');
  }
  const packages = value.packages.map(sanitizeManagedServicePackage);
  const units = value.units.map(sanitizeManagedServiceUnit);
  if (packages.length !== policy.packages.length
    || packages.some((entry, index) => entry.packageName !== policy.packages[index])
    || units.some((entry, index) => entry.unit !== policy.units[index])) {
    throw new JobRegistryError('invalid_job_result', 'Managed service package or unit identities are invalid');
  }
  if (value.installed !== packages.every((entry) => entry.installed)) throw new JobRegistryError('invalid_job_result', 'Managed service installed state is inconsistent');
  if (value.active !== (units.length > 0 && units.every((entry) => entry.activeState === 'active'))) throw new JobRegistryError('invalid_job_result', 'Managed service active state is inconsistent');
  const health = sanitizeManagedServiceHealth(value.health, {
    policy, installed: value.installed, active: value.active, units,
  });
  return { id: value.id, installed: value.installed, active: value.active, packages, units, health };
}

function sanitizeManagedServiceResult(job, result) {
  if (job.operation === OPERATIONS.SYSTEM_SERVICES_INSPECT) {
    if (job.payload?.serviceId) {
      const service = sanitizeManagedServiceState(result);
      if (service.id !== job.payload.serviceId) throw new JobRegistryError('invalid_job_result', 'Managed service inspection identity does not match the queued operation');
      return service;
    }
    if (!Array.isArray(result) || result.length !== MANAGED_SERVICE_IDS.length) throw new JobRegistryError('invalid_job_result', 'Managed service catalog result is incomplete');
    const services = result.map(sanitizeManagedServiceState);
    const ids = new Set(services.map((entry) => entry.id));
    if (ids.size !== MANAGED_SERVICE_IDS.length || MANAGED_SERVICE_IDS.some((id) => !ids.has(id))) throw new JobRegistryError('invalid_job_result', 'Managed service catalog identities are invalid');
    return services;
  }

  const service = sanitizeManagedServiceState(result);
  if (service.id !== job.payload?.serviceId) throw new JobRegistryError('invalid_job_result', 'Managed service result identity does not match the queued operation');
  if (job.operation === OPERATIONS.SYSTEM_SERVICE_INSTALL) {
    if (typeof result.changed !== 'boolean' || !service.installed
      || (service.units.length > 0 && !service.active)) {
      throw new JobRegistryError('invalid_job_result', 'Managed service installation result is inconsistent');
    }
    return { ...service, changed: result.changed };
  }
  if (job.operation === OPERATIONS.SYSTEM_SERVICE_CONTROL) {
    const action = result.action;
    if (typeof action !== 'string' || !MANAGED_SERVICE_ACTION_SET.has(action) || action !== job.payload?.action) throw new JobRegistryError('invalid_job_result', 'Managed service control action does not match the queued operation');
    if (!service.installed) throw new JobRegistryError('invalid_job_result', 'Managed service control result must remain installed');
    if (action === 'stop' ? service.active : !service.active) throw new JobRegistryError('invalid_job_result', 'Managed service control active state is inconsistent');
    return { ...service, action };
  }
  throw new JobRegistryError('invalid_operation', 'Managed service operation is not supported by the async queue');
}

function sanitizeDatabaseResult(job, result) {
  try {
    return sanitizeDatabaseJobResult(job, result);
  } catch (error) {
    if (error?.code === 'invalid_job_result') {
      throw new JobRegistryError('invalid_job_result', error.message);
    }
    throw error;
  }
}

function sanitizeDnsRecordResult(job, result) {
  const expectedState = job.payload?.action === 'upsert' ? 'present' : 'absent';
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.provider !== 'cloudflare' || result.provider !== job.payload?.provider
    || result.action !== job.payload?.action || result.zoneName !== job.payload?.zoneName
    || result.state !== expectedState || typeof result.changed !== 'boolean'
    || JSON.stringify(result.record) !== JSON.stringify(job.payload?.record)) {
    throw new JobRegistryError('invalid_job_result', 'DNS record result does not match the queued operation');
  }
  return {
    provider: 'cloudflare', action: result.action, zoneName: result.zoneName,
    record: structuredClone(job.payload.record), changed: result.changed, state: expectedState,
  };
}

function sanitizeMailConfigResult(job, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.version !== 1 || result.applied !== true || result.sideEffects !== true
    || result.mailDomainId !== job.payload?.mailDomainId
    || result.desiredStatus !== job.payload?.desiredStatus
    || result.previewDigest !== job.payload?.previewDigest
    || result.configurationSha256 !== job.payload?.configurationSha256
    || typeof result.planSha256 !== 'string' || !SHA256_PATTERN.test(result.planSha256)
    || typeof result.readinessSha256 !== 'string' || !SHA256_PATTERN.test(result.readinessSha256)) {
    throw new JobRegistryError('invalid_job_result', 'Managed mail result does not match the queued transition');
  }
  return {
    version: 1,
    mailDomainId: result.mailDomainId,
    desiredStatus: result.desiredStatus,
    previewDigest: result.previewDigest,
    configurationSha256: result.configurationSha256,
    planSha256: result.planSha256,
    readinessSha256: result.readinessSha256,
    applied: true,
    sideEffects: true,
  };
}

function sanitizeMailDkimResult(job, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 7
    || result.version !== 1 || result.applied !== true || result.sideEffects !== true
    || result.mailDomainId !== job.payload?.mailDomainId
    || result.expectedKeyRevision !== job.payload?.expectedKeyRevision
    || result.previewDigest !== job.payload?.previewDigest
    || result.configurationSha256 !== job.payload?.configurationSha256) {
    throw new JobRegistryError('invalid_job_result', 'Managed DKIM result does not match the queued configuration');
  }
  return {
    version: 1,
    mailDomainId: result.mailDomainId,
    expectedKeyRevision: result.expectedKeyRevision,
    previewDigest: result.previewDigest,
    configurationSha256: result.configurationSha256,
    applied: true,
    sideEffects: true,
  };
}

function sanitizeRoundcubeConfigResult(job, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== 9
    || result.version !== 1 || result.applied !== true || result.sideEffects !== true
    || result.previewSha256 !== job.payload?.previewSha256
    || result.configSha256 !== job.payload?.configSha256
    || result.fpmSha256 !== job.payload?.fpmSha256
    || typeof result.nginxSha256 !== 'string' || !SHA256_PATTERN.test(result.nginxSha256)
    || typeof result.databaseCreated !== 'boolean' || result.httpHealthy !== true) {
    throw new JobRegistryError('invalid_job_result', 'Roundcube result does not match the queued configuration');
  }
  return {
    version: 1,
    previewSha256: result.previewSha256,
    configSha256: result.configSha256,
    fpmSha256: result.fpmSha256,
    nginxSha256: result.nginxSha256,
    databaseCreated: result.databaseCreated,
    httpHealthy: true,
    applied: true,
    sideEffects: true,
  };
}

function sanitizeResult(job, result) {
  if (job.operation === OPERATIONS.SYSTEM_SERVICES_INSPECT) return sanitizeManagedServiceResult(job, result);
  if ([OPERATIONS.DATABASE_INSPECT, OPERATIONS.DATABASE_CREATE, OPERATIONS.DATABASE_DELETE].includes(job.operation)) {
    return sanitizeDatabaseResult(job, result);
  }
  if (job.operation === OPERATIONS.DNS_RECORD_APPLY) return sanitizeDnsRecordResult(job, result);
  if (job.operation === OPERATIONS.MAIL_CONFIG_APPLY) return sanitizeMailConfigResult(job, result);
  if (job.operation === OPERATIONS.MAIL_DKIM_APPLY) return sanitizeMailDkimResult(job, result);
  if (job.operation === OPERATIONS.ROUNDCUBE_CONFIG_APPLY) return sanitizeRoundcubeConfigResult(job, result);
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
  if (job.operation === OPERATIONS.APP_NODE_ROLLBACK) return sanitizeNodeRollbackResult(job, result);
  if (job.operation === OPERATIONS.APP_NODE_RESTART) return sanitizeNodeRestartResult(job, result);
  if (job.operation === OPERATIONS.APP_NODE_STATUS) return sanitizeNodeStatusResult(job, result);
  if (job.operation === OPERATIONS.APP_NODE_PROCESS) return sanitizeNodeProcessResult(job, result);
  if (job.operation === OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT) return sanitizeNodeRuntimeInventory(result);
  if (job.operation === OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL) return sanitizeNodeRuntimeInstallResult(job, result);
  if (job.operation === OPERATIONS.SYSTEM_PACKAGES_INSPECT || job.operation === OPERATIONS.SYSTEM_UPGRADE) {
    return sanitizeSystemPackageResult(job, result);
  }
  if (job.operation === OPERATIONS.SYSTEM_SERVICE_INSTALL || job.operation === OPERATIONS.SYSTEM_SERVICE_CONTROL) {
    return sanitizeManagedServiceResult(job, result);
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

  async function enqueue({ serverId, type, operation, payload, resourceType, resourceId, idempotencyKey = null }) {
    await ensureInitialized();
    if (typeof serverId !== 'string' || !serverId) throw new JobRegistryError('invalid_server', 'serverId is required');
    if (typeof type !== 'string' || type.length < 1 || type.length > 80) throw new JobRegistryError('invalid_job_type', 'Job type is invalid');
    if (!ASYNC_OPERATIONS.has(operation)) throw new JobRegistryError('invalid_operation', 'Agent operation is not supported by the async queue');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JobRegistryError('invalid_payload', 'Job payload must be an object');
    if (!RESOURCE_TYPES.has(resourceType)) throw new JobRegistryError('invalid_resource_type', 'Job resource type is invalid');
    if (typeof resourceId !== 'string' || !resourceId) throw new JobRegistryError('invalid_resource_id', 'Job resource id is required');
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))) {
      throw new JobRegistryError('invalid_idempotency_key', 'Job idempotency key is invalid');
    }

    const requestDigest = idempotencyKey === null ? null : idempotencyDigest({
      serverId, type, operation, payload, resourceType, resourceId,
    });
    const existing = idempotencyKey === null ? null : state.jobs.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.idempotencyDigest !== requestDigest) {
        throw new JobRegistryError('job_idempotency_conflict', 'Job idempotency key was already used for different work', 409);
      }
      return enqueueResult(existing, false);
    }
    if (state.jobs.some((candidate) => candidate.resourceType === resourceType
      && candidate.resourceId === resourceId && ['queued', 'running'].includes(candidate.status))) {
      throw new JobRegistryError(`${resourceType}_job_conflict`, `A ${resourceType} operation is already queued or running`, 409);
    }

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
      idempotencyKey,
      idempotencyDigest: requestDigest,
    };
    state.jobs.push(job);
    await persist();
    return enqueueResult(job, true);
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