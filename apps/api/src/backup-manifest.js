import { createHash } from 'node:crypto';

const MANIFEST_VERSION = 1;
const MAX_PROJECTS = 1024;
const MAX_APPLICATIONS = 2048;
const MAX_RESOURCES = 4096;
const MAX_SERVICE_MOUNTS = 128;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const STORAGE_KINDS = new Set(['bind', 'ephemeral', 'named_volume']);
const STORAGE_SCOPES = new Set(['host', 'project']);
const APPLICATION_TYPES = new Set(['static', 'node']);
const POLICY_DISPOSITIONS = new Set(['include', 'exclude', 'reject']);
const DOCKER_RESOURCE_KEYS = new Set([
  'identity', 'type', 'serverId', 'projectId', 'projectRevision', 'projectName', 'serviceName', 'storage', 'policy',
]);
const APPLICATION_RESOURCE_KEYS = new Set([
  'identity', 'type', 'serverId', 'applicationId', 'name', 'applicationType', 'snapshot', 'policy',
]);
const APPLICATION_SNAPSHOT_KEYS = new Set([
  'desiredRevision', 'appliedRevision', 'currentReleaseId', 'currentCommitSha', 'environment',
]);
const ENVIRONMENT_SNAPSHOT_KEYS = new Set(['savedRevision', 'appliedRevision', 'appliedReleaseId']);
const STORAGE_KEYS = new Set(['kind', 'source', 'sourceScope', 'target', 'readOnly']);
const POLICY_KEYS = new Set(['disposition', 'reason']);
const MANIFEST_KEYS = new Set(['version', 'createdAt', 'serverId', 'resources', 'counts']);
const COUNT_KEYS = new Set(['total', 'included', 'excluded', 'rejected']);

export class BackupManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupManifestError';
    this.code = code;
  }
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    throw new BackupManifestError('backup_manifest_identity_invalid', `${label} is invalid`);
  }
  return value;
}

function safeUuid(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BackupManifestError('backup_manifest_identity_invalid', `${label} is invalid`);
  }
  return value.toLowerCase();
}

function safeProjectName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BackupManifestError('backup_manifest_project_invalid', 'Docker project name is invalid');
  }
  return value;
}

function safeApplicationName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80
    || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application name is invalid');
  }
  return value;
}

function safeStoragePath(value, { absolute = false } = {}) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value) && (!absolute || value.startsWith('/'));
}

function validProjectBindSource(value) {
  if (value === './') return true;
  if (typeof value !== 'string' || !value.startsWith('./') || !safeStoragePath(value)) return false;
  const segments = value.slice(2).split('/');
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function normalizeStorageMount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== STORAGE_KEYS.size
    || Object.keys(value).some((key) => !STORAGE_KEYS.has(key))
    || typeof value.kind !== 'string' || !STORAGE_KINDS.has(value.kind)
    || !safeStoragePath(value.target, { absolute: true })
    || typeof value.readOnly !== 'boolean') {
    throw new BackupManifestError('backup_manifest_storage_invalid', 'Docker storage mount is invalid');
  }

  if (value.kind === 'ephemeral') {
    if (value.source !== null || value.sourceScope !== null) {
      throw new BackupManifestError('backup_manifest_storage_invalid', 'Ephemeral Docker storage identity is invalid');
    }
    return Object.freeze({ ...value });
  }

  if (typeof value.source !== 'string' || typeof value.sourceScope !== 'string' || !STORAGE_SCOPES.has(value.sourceScope)) {
    throw new BackupManifestError('backup_manifest_storage_invalid', 'Docker storage source identity is invalid');
  }

  if (value.kind === 'named_volume') {
    if (value.sourceScope !== 'project' || !RESOURCE_NAME_PATTERN.test(value.source)) {
      throw new BackupManifestError('backup_manifest_storage_invalid', 'Docker named volume identity is invalid');
    }
    return Object.freeze({ ...value });
  }

  if ((value.sourceScope === 'project' && !validProjectBindSource(value.source))
    || (value.sourceScope === 'host' && !safeStoragePath(value.source, { absolute: true }))) {
    throw new BackupManifestError('backup_manifest_storage_invalid', 'Docker bind mount identity is invalid');
  }
  return Object.freeze({ ...value });
}

export function dockerStorageBackupPolicy(storage) {
  const mount = normalizeStorageMount(storage);
  if (mount.kind === 'ephemeral') {
    return Object.freeze({ disposition: 'exclude', reason: 'ephemeral_storage' });
  }
  if (mount.kind === 'bind' && mount.sourceScope === 'host') {
    return Object.freeze({ disposition: 'reject', reason: 'arbitrary_host_bind' });
  }
  if (mount.kind === 'named_volume') {
    return Object.freeze({ disposition: 'include', reason: 'managed_named_volume' });
  }
  return Object.freeze({ disposition: 'include', reason: 'managed_project_bind' });
}

function applicationBackupPolicy() {
  return Object.freeze({ disposition: 'include', reason: 'managed_application' });
}

function dockerStorageIdentity({ projectId, serviceName, storage }) {
  const mount = normalizeStorageMount(storage);
  const canonical = JSON.stringify([
    MANIFEST_VERSION,
    'docker_storage',
    projectId,
    serviceName,
    mount.kind,
    mount.sourceScope,
    mount.source,
    mount.target,
  ]);
  return `docker-storage:${createHash('sha256').update(canonical).digest('hex')}`;
}

function applicationIdentity(applicationId) {
  return `application:${safeUuid(applicationId, 'applicationId')}`;
}

function normalizePolicy(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== POLICY_KEYS.size
    || Object.keys(value).some((key) => !POLICY_KEYS.has(key))
    || typeof value.disposition !== 'string' || !POLICY_DISPOSITIONS.has(value.disposition)
    || typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 80) {
    throw new BackupManifestError('backup_manifest_policy_invalid', 'Backup policy is invalid');
  }
  if (value.disposition !== expected.disposition || value.reason !== expected.reason) {
    throw new BackupManifestError('backup_manifest_policy_invalid', 'Backup policy does not match resource safety rules');
  }
  return expected;
}

function normalizeDockerStorageResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== DOCKER_RESOURCE_KEYS.size
    || Object.keys(value).some((key) => !DOCKER_RESOURCE_KEYS.has(key))
    || value.type !== 'docker_storage') {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  const projectId = safeIdentifier(value.projectId, 'projectId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  if (!Number.isInteger(value.projectRevision) || value.projectRevision < 1) {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Docker project revision is invalid');
  }
  if (typeof value.serviceName !== 'string' || !SERVICE_NAME_PATTERN.test(value.serviceName)) {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Docker service name is invalid');
  }
  const storage = normalizeStorageMount(value.storage);
  const identity = dockerStorageIdentity({ projectId, serviceName: value.serviceName, storage });
  if (value.identity !== identity) {
    throw new BackupManifestError('backup_manifest_identity_invalid', 'Backup resource identity does not match its Docker storage identity');
  }
  return Object.freeze({
    identity,
    type: 'docker_storage',
    serverId,
    projectId,
    projectRevision: value.projectRevision,
    projectName: safeProjectName(value.projectName),
    serviceName: value.serviceName,
    storage,
    policy: normalizePolicy(value.policy, dockerStorageBackupPolicy(storage)),
  });
}

function normalizeEnvironmentSnapshot(value, applicationId) {
  const source = value ?? { savedRevision: 0, appliedRevision: null, appliedReleaseId: null };
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).length !== ENVIRONMENT_SNAPSHOT_KEYS.size
    || Object.keys(source).some((key) => !ENVIRONMENT_SNAPSHOT_KEYS.has(key))
    || !Number.isSafeInteger(source.savedRevision) || source.savedRevision < 0
    || (source.appliedRevision !== null && (!Number.isSafeInteger(source.appliedRevision)
      || source.appliedRevision < 0 || source.appliedRevision > source.savedRevision))) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application environment revision state is invalid');
  }
  const appliedReleaseId = safeUuid(source.appliedReleaseId, 'environment appliedReleaseId', { nullable: true });
  if ((source.appliedRevision === null) !== (appliedReleaseId === null)) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application environment applied state is incomplete');
  }
  return Object.freeze({
    savedRevision: source.savedRevision,
    appliedRevision: source.appliedRevision,
    appliedReleaseId,
  });
}

function normalizeApplicationSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== APPLICATION_SNAPSHOT_KEYS.size
    || Object.keys(value).some((key) => !APPLICATION_SNAPSHOT_KEYS.has(key))
    || !Number.isSafeInteger(value.desiredRevision) || value.desiredRevision < 1
    || !Number.isSafeInteger(value.appliedRevision) || value.appliedRevision < 0
    || value.appliedRevision > value.desiredRevision) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application revision state is invalid');
  }
  const currentReleaseId = safeUuid(value.currentReleaseId, 'currentReleaseId', { nullable: true });
  const currentCommitSha = value.currentCommitSha === null
    ? null
    : typeof value.currentCommitSha === 'string' && COMMIT_PATTERN.test(value.currentCommitSha)
      ? value.currentCommitSha.toLowerCase()
      : null;
  if ((currentReleaseId === null) !== (currentCommitSha === null)
    || (currentReleaseId === null && value.appliedRevision !== 0)
    || (currentReleaseId !== null && value.appliedRevision < 1)) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application active release state is invalid');
  }
  return Object.freeze({
    desiredRevision: value.desiredRevision,
    appliedRevision: value.appliedRevision,
    currentReleaseId,
    currentCommitSha,
    environment: normalizeEnvironmentSnapshot(value.environment),
  });
}

function normalizeApplicationResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== APPLICATION_RESOURCE_KEYS.size
    || Object.keys(value).some((key) => !APPLICATION_RESOURCE_KEYS.has(key))
    || value.type !== 'application') {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  const applicationId = safeUuid(value.applicationId, 'applicationId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  if (typeof value.applicationType !== 'string' || !APPLICATION_TYPES.has(value.applicationType)) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application type is invalid');
  }
  const identity = applicationIdentity(applicationId);
  if (value.identity !== identity) {
    throw new BackupManifestError('backup_manifest_identity_invalid', 'Backup resource identity does not match its Application identity');
  }
  return Object.freeze({
    identity,
    type: 'application',
    serverId,
    applicationId,
    name: safeApplicationName(value.name),
    applicationType: value.applicationType,
    snapshot: normalizeApplicationSnapshot(value.snapshot),
    policy: normalizePolicy(value.policy, applicationBackupPolicy()),
  });
}

function normalizeBackupResource(value, expectedServerId = null) {
  if (value?.type === 'docker_storage') return normalizeDockerStorageResource(value, expectedServerId);
  if (value?.type === 'application') return normalizeApplicationResource(value, expectedServerId);
  throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource type is invalid');
}

export function dockerStorageBackupResources(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new BackupManifestError('backup_manifest_project_invalid', 'Docker project is invalid');
  }
  const serverId = safeIdentifier(project.serverId, 'serverId');
  const projectId = safeIdentifier(project.id, 'projectId');
  if (!Number.isInteger(project.revision) || project.revision < 1
    || !Array.isArray(project.services) || project.services.length > 256) {
    throw new BackupManifestError('backup_manifest_project_invalid', 'Docker project backup metadata is invalid');
  }
  const projectName = safeProjectName(project.projectName);
  const resources = [];
  for (const service of project.services) {
    if (!service || typeof service !== 'object' || Array.isArray(service)
      || typeof service.name !== 'string' || !SERVICE_NAME_PATTERN.test(service.name)
      || !Array.isArray(service.storageMounts) || service.storageMounts.length > MAX_SERVICE_MOUNTS) {
      throw new BackupManifestError('backup_manifest_project_invalid', 'Docker service backup metadata is invalid');
    }
    for (const rawStorage of service.storageMounts) {
      const storage = normalizeStorageMount(rawStorage);
      const resource = {
        identity: dockerStorageIdentity({ projectId, serviceName: service.name, storage }),
        type: 'docker_storage',
        serverId,
        projectId,
        projectRevision: project.revision,
        projectName,
        serviceName: service.name,
        storage,
        policy: dockerStorageBackupPolicy(storage),
      };
      resources.push(normalizeDockerStorageResource(resource, serverId));
    }
  }
  return Object.freeze(resources.sort((left, right) => left.identity.localeCompare(right.identity)));
}

export function applicationBackupResource(application, environment = null) {
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application backup metadata is invalid');
  }
  const serverId = safeIdentifier(application.serverId, 'serverId');
  const applicationId = safeUuid(application.id, 'applicationId');
  if (typeof application.type !== 'string' || !APPLICATION_TYPES.has(application.type)
    || !Number.isSafeInteger(application.desiredRevision) || application.desiredRevision < 1
    || !Number.isSafeInteger(application.appliedRevision) || application.appliedRevision < 0) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application backup metadata is invalid');
  }
  if (environment !== null && (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || (environment.applicationId !== undefined && safeUuid(environment.applicationId, 'environment applicationId') !== applicationId))) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application environment belongs to a different Application');
  }
  const environmentSnapshot = environment === null ? null : {
    savedRevision: environment.savedRevision,
    appliedRevision: environment.appliedRevision,
    appliedReleaseId: environment.appliedReleaseId,
  };
  return normalizeApplicationResource({
    identity: applicationIdentity(applicationId),
    type: 'application',
    serverId,
    applicationId,
    name: application.name,
    applicationType: application.type,
    snapshot: {
      desiredRevision: application.desiredRevision,
      appliedRevision: application.appliedRevision,
      currentReleaseId: application.currentReleaseId ?? null,
      currentCommitSha: application.currentCommitSha ?? null,
      environment: environmentSnapshot ?? { savedRevision: 0, appliedRevision: null, appliedReleaseId: null },
    },
    policy: applicationBackupPolicy(),
  }, serverId);
}

function resourceCounts(resources) {
  const counts = { total: resources.length, included: 0, excluded: 0, rejected: 0 };
  for (const resource of resources) {
    if (resource.policy.disposition === 'include') counts.included += 1;
    else if (resource.policy.disposition === 'exclude') counts.excluded += 1;
    else counts.rejected += 1;
  }
  return Object.freeze(counts);
}

function normalizeCreatedAt(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new BackupManifestError('backup_manifest_timestamp_invalid', 'Backup manifest timestamp is invalid');
  }
  return new Date(value).toISOString();
}

function validateCounts(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== COUNT_KEYS.size
    || Object.keys(value).some((key) => !COUNT_KEYS.has(key))
    || !Object.entries(expected).every(([key, count]) => value[key] === count)) {
    throw new BackupManifestError('backup_manifest_counts_invalid', 'Backup manifest counts are invalid');
  }
  return expected;
}

export function normalizeBackupManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== MANIFEST_KEYS.size
    || Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))
    || value.version !== MANIFEST_VERSION
    || !Array.isArray(value.resources) || value.resources.length > MAX_RESOURCES) {
    throw new BackupManifestError('backup_manifest_invalid', 'Backup manifest is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  const resources = value.resources.map((resource) => normalizeBackupResource(resource, serverId))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  if (new Set(resources.map((resource) => resource.identity)).size !== resources.length) {
    throw new BackupManifestError('backup_manifest_duplicate_resource', 'Backup manifest contains duplicate resources');
  }
  const counts = resourceCounts(resources);
  validateCounts(value.counts, counts);
  return Object.freeze({
    version: MANIFEST_VERSION,
    createdAt: normalizeCreatedAt(value.createdAt),
    serverId,
    resources: Object.freeze(resources),
    counts,
  });
}

export function createBackupManifest({
  serverId,
  dockerProjects = [],
  applicationSnapshots = [],
  createdAt = new Date().toISOString(),
} = {}) {
  const normalizedServerId = safeIdentifier(serverId, 'serverId');
  if (!Array.isArray(dockerProjects) || dockerProjects.length > MAX_PROJECTS) {
    throw new BackupManifestError('backup_manifest_projects_invalid', 'Docker project list is invalid');
  }
  if (!Array.isArray(applicationSnapshots) || applicationSnapshots.length > MAX_APPLICATIONS) {
    throw new BackupManifestError('backup_manifest_applications_invalid', 'Application snapshot list is invalid');
  }
  const resources = [];
  for (const project of dockerProjects) {
    if (project?.serverId !== normalizedServerId) {
      throw new BackupManifestError('backup_manifest_server_mismatch', 'Docker project belongs to a different server');
    }
    resources.push(...dockerStorageBackupResources(project));
  }
  for (const entry of applicationSnapshots) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !entry.application || typeof entry.application !== 'object') {
      throw new BackupManifestError('backup_manifest_applications_invalid', 'Application snapshot is invalid');
    }
    if (entry.application.serverId !== normalizedServerId) {
      throw new BackupManifestError('backup_manifest_server_mismatch', 'Application belongs to a different server');
    }
    resources.push(applicationBackupResource(entry.application, entry.environment ?? null));
  }
  if (resources.length > MAX_RESOURCES) {
    throw new BackupManifestError('backup_manifest_too_large', 'Backup manifest contains too many resources');
  }
  const ordered = resources.sort((left, right) => left.identity.localeCompare(right.identity));
  if (new Set(ordered.map((resource) => resource.identity)).size !== ordered.length) {
    throw new BackupManifestError('backup_manifest_duplicate_resource', 'Backup manifest contains duplicate resources');
  }
  const manifest = {
    version: MANIFEST_VERSION,
    createdAt: normalizeCreatedAt(createdAt),
    serverId: normalizedServerId,
    resources: ordered,
    counts: resourceCounts(ordered),
  };
  return normalizeBackupManifest(manifest);
}

export const backupManifestInternals = Object.freeze({
  manifestVersion: MANIFEST_VERSION,
  maxProjects: MAX_PROJECTS,
  maxApplications: MAX_APPLICATIONS,
  maxResources: MAX_RESOURCES,
  normalizeStorageMount,
  dockerStorageIdentity,
  applicationIdentity,
  normalizeDockerStorageResource,
  normalizeApplicationResource,
  normalizeBackupResource,
  resourceCounts,
});
