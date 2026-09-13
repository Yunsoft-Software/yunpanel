import { createHash } from 'node:crypto';

const MANIFEST_VERSION = 1;
const MAX_PROJECTS = 1024;
const MAX_RESOURCES = 4096;
const MAX_SERVICE_MOUNTS = 128;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STORAGE_KINDS = new Set(['bind', 'ephemeral', 'named_volume']);
const STORAGE_SCOPES = new Set(['host', 'project']);
const POLICY_DISPOSITIONS = new Set(['include', 'exclude', 'reject']);
const RESOURCE_KEYS = new Set([
  'identity', 'type', 'serverId', 'projectId', 'projectRevision', 'projectName', 'serviceName', 'storage', 'policy',
]);
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

function safeProjectName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BackupManifestError('backup_manifest_project_invalid', 'Docker project name is invalid');
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

function normalizePolicy(value, storage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== POLICY_KEYS.size
    || Object.keys(value).some((key) => !POLICY_KEYS.has(key))
    || typeof value.disposition !== 'string' || !POLICY_DISPOSITIONS.has(value.disposition)
    || typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 80) {
    throw new BackupManifestError('backup_manifest_policy_invalid', 'Backup policy is invalid');
  }
  const expected = dockerStorageBackupPolicy(storage);
  if (value.disposition !== expected.disposition || value.reason !== expected.reason) {
    throw new BackupManifestError('backup_manifest_policy_invalid', 'Backup policy does not match Docker storage safety rules');
  }
  return expected;
}

function normalizeDockerStorageResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== RESOURCE_KEYS.size
    || Object.keys(value).some((key) => !RESOURCE_KEYS.has(key))
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
    policy: normalizePolicy(value.policy, storage),
  });
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
  const resources = value.resources.map((resource) => normalizeDockerStorageResource(resource, serverId))
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

export function createBackupManifest({ serverId, dockerProjects = [], createdAt = new Date().toISOString() } = {}) {
  const normalizedServerId = safeIdentifier(serverId, 'serverId');
  if (!Array.isArray(dockerProjects) || dockerProjects.length > MAX_PROJECTS) {
    throw new BackupManifestError('backup_manifest_projects_invalid', 'Docker project list is invalid');
  }
  const resources = [];
  for (const project of dockerProjects) {
    if (project?.serverId !== normalizedServerId) {
      throw new BackupManifestError('backup_manifest_server_mismatch', 'Docker project belongs to a different server');
    }
    resources.push(...dockerStorageBackupResources(project));
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
  maxResources: MAX_RESOURCES,
  normalizeStorageMount,
  dockerStorageIdentity,
  normalizeDockerStorageResource,
  resourceCounts,
});
