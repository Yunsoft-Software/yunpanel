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

export const DISASTER_RECOVERY_CATEGORIES = Object.freeze([
  'site_files',
  'database',
  'mail',
  'configuration',
  'panel_relationships',
  'encryption_keys',
]);

export function maskDisasterRecoverySecrets(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.includes('BEGIN PRIVATE KEY') || value.includes('BEGIN RSA PRIVATE KEY') || value.includes('BEGIN EC PRIVATE KEY') || value.includes('BEGIN OPENSSH PRIVATE KEY')) {
      return '[REDACTED_PRIVATE_KEY]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(maskDisasterRecoverySecrets));
  }
  if (typeof value === 'object') {
    const masked = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'secretsMasked' || k === 'secretsRedacted') {
        masked[k] = v;
      } else if (typeof v === 'string' && (v.includes('BEGIN PRIVATE KEY') || v.includes('BEGIN RSA PRIVATE KEY') || v.includes('BEGIN EC PRIVATE KEY') || v.includes('BEGIN OPENSSH PRIVATE KEY'))) {
        masked[k] = '[REDACTED_PRIVATE_KEY]';
      } else if (/private_?key/i.test(k)) {
        masked[k] = '[REDACTED_PRIVATE_KEY]';
      } else if (/password|secret|token|credential|salt|argon2/i.test(k)) {
        masked[k] = '[REDACTED]';
      } else {
        masked[k] = maskDisasterRecoverySecrets(v);
      }
    }
    return Object.freeze(masked);
  }
  return value;
}
const DOCKER_RESOURCE_KEYS = new Set([
  'identity', 'type', 'serverId', 'projectId', 'projectRevision', 'projectName', 'serviceName', 'storage', 'policy',
]);
const APPLICATION_RESOURCE_KEYS = new Set([
  'identity', 'type', 'serverId', 'applicationId', 'name', 'applicationType', 'snapshot', 'policy',
]);
const APPLICATION_SNAPSHOT_KEYS = new Set([
  'desiredRevision', 'appliedRevision', 'currentReleaseId', 'currentCommitSha', 'environment',
]);
const APPLICATION_INPUT_KEYS = new Set(['application', 'environment']);
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

function normalizeEnvironmentSnapshot(value) {
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
  if (value.currentCommitSha !== null
    && (typeof value.currentCommitSha !== 'string' || !COMMIT_PATTERN.test(value.currentCommitSha))) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Application commit state is invalid');
  }
  const currentCommitSha = value.currentCommitSha === null ? null : value.currentCommitSha.toLowerCase();
  if ((currentReleaseId === null) !== (currentCommitSha === null)
    || (currentReleaseId === null && value.appliedRevision !== 0)) {
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
  const snapshot = normalizeApplicationSnapshot(value.snapshot);
  if (value.applicationType === 'node' && snapshot.currentReleaseId !== null && snapshot.appliedRevision < 1) {
    throw new BackupManifestError('backup_manifest_application_invalid', 'Node Application active release requires an applied configuration revision');
  }
  return Object.freeze({
    identity,
    type: 'application',
    serverId,
    applicationId,
    name: safeApplicationName(value.name),
    applicationType: value.applicationType,
    snapshot,
    policy: normalizePolicy(value.policy, applicationBackupPolicy()),
  });
}

function normalizeSiteFilesResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'site_files') {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  const websiteId = safeUuid(value.websiteId, 'websiteId');
  const identity = value.identity ?? `site_files:${websiteId}`;
  return Object.freeze({
    identity,
    type: 'site_files',
    serverId,
    websiteId,
    policy: value.policy ?? Object.freeze({ disposition: 'include', reason: 'disaster_recovery_site_files' }),
    ...(value.details ? { details: maskDisasterRecoverySecrets(value.details) } : {}),
  });
}

function normalizeConfigurationResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'configuration') {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  const websiteId = value.websiteId ? safeUuid(value.websiteId, 'websiteId') : null;
  const identity = value.identity ?? `configuration:${websiteId ?? safeIdentifier(value.name ?? 'global', 'configName')}`;
  return Object.freeze({
    identity,
    type: 'configuration',
    serverId,
    ...(websiteId ? { websiteId } : {}),
    policy: value.policy ?? Object.freeze({ disposition: 'include', reason: 'disaster_recovery_configuration' }),
    ...(value.details ? { details: maskDisasterRecoverySecrets(value.details) } : {}),
  });
}

function normalizePanelRelationshipsResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'panel_relationships') {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  const websiteId = value.websiteId ? safeUuid(value.websiteId, 'websiteId') : null;
  const identity = value.identity ?? `panel_relationships:${websiteId ?? 'global'}`;
  return Object.freeze({
    identity,
    type: 'panel_relationships',
    serverId,
    ...(websiteId ? { websiteId } : {}),
    policy: value.policy ?? Object.freeze({ disposition: 'include', reason: 'disaster_recovery_panel_relationships' }),
    ...(value.details ? { details: maskDisasterRecoverySecrets(value.details) } : {}),
  });
}

function normalizeEncryptionKeysResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'encryption_keys') {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  const websiteId = value.websiteId ? safeUuid(value.websiteId, 'websiteId') : null;
  const identity = value.identity ?? `encryption_keys:${websiteId ?? 'global'}`;
  return Object.freeze({
    identity,
    type: 'encryption_keys',
    serverId,
    ...(websiteId ? { websiteId } : {}),
    policy: value.policy ?? Object.freeze({ disposition: 'include', reason: 'disaster_recovery_encryption_keys' }),
    ...(value.details ? { details: maskDisasterRecoverySecrets(value.details) } : {}),
  });
}

function normalizeDatabaseManifestResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'database') {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  const databaseName = value.databaseName ? safeIdentifier(value.databaseName, 'databaseName') : null;
  const websiteId = value.websiteId ? safeUuid(value.websiteId, 'websiteId') : null;
  const identity = value.identity ?? `database:${databaseName ?? websiteId}`;
  return Object.freeze({
    identity,
    type: 'database',
    serverId,
    ...(databaseName ? { databaseName } : {}),
    ...(websiteId ? { websiteId } : {}),
    policy: value.policy ?? Object.freeze({ disposition: 'include', reason: 'managed_database' }),
    ...(value.snapshot ? { snapshot: value.snapshot } : {}),
    ...(value.details ? { details: maskDisasterRecoverySecrets(value.details) } : {}),
  });
}

function normalizeMailManifestResource(value, expectedServerId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.type !== 'mail' && value.type !== 'mail_data')) {
    throw new BackupManifestError('backup_manifest_resource_invalid', 'Backup resource is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  if (expectedServerId && serverId !== expectedServerId) {
    throw new BackupManifestError('backup_manifest_server_mismatch', 'Backup resource belongs to a different server');
  }
  const mailDomainId = value.mailDomainId ? safeUuid(value.mailDomainId, 'mailDomainId') : null;
  const websiteId = value.websiteId ? safeUuid(value.websiteId, 'websiteId') : null;
  const identity = value.identity ?? `mail:${mailDomainId ?? websiteId}`;
  return Object.freeze({
    identity,
    type: value.type,
    serverId,
    ...(mailDomainId ? { mailDomainId } : {}),
    ...(websiteId ? { websiteId } : {}),
    policy: value.policy ?? Object.freeze({ disposition: 'include', reason: 'managed_mail' }),
    ...(value.snapshot ? { snapshot: value.snapshot } : {}),
    ...(value.details ? { details: maskDisasterRecoverySecrets(value.details) } : {}),
  });
}

export function createDisasterRecoveryScope({
  serverId,
  websiteId,
  siteFiles,
  database,
  databases,
  mail,
  mailData,
  configuration,
  panelRelationships,
  encryptionKeys,
  createdAt = new Date().toISOString(),
} = {}) {
  const normalizedServerId = safeIdentifier(serverId, 'serverId');
  const normalizedWebsiteId = safeUuid(websiteId, 'websiteId');
  const resolvedDatabase = database ?? databases;
  const resolvedMail = mail ?? mailData;

  if (!siteFiles || typeof siteFiles !== 'object') {
    throw new BackupManifestError('backup_manifest_scope_invalid', 'Disaster recovery site files scope is invalid');
  }
  if (!resolvedDatabase || typeof resolvedDatabase !== 'object') {
    throw new BackupManifestError('backup_manifest_scope_invalid', 'Disaster recovery database scope is invalid');
  }
  if (!resolvedMail || typeof resolvedMail !== 'object') {
    throw new BackupManifestError('backup_manifest_scope_invalid', 'Disaster recovery mail scope is invalid');
  }
  if (!configuration || typeof configuration !== 'object') {
    throw new BackupManifestError('backup_manifest_scope_invalid', 'Disaster recovery configuration scope is invalid');
  }
  if (!panelRelationships || typeof panelRelationships !== 'object') {
    throw new BackupManifestError('backup_manifest_scope_invalid', 'Disaster recovery panel relationships scope is invalid');
  }
  if (!encryptionKeys || typeof encryptionKeys !== 'object') {
    throw new BackupManifestError('backup_manifest_scope_invalid', 'Disaster recovery encryption keys scope is invalid');
  }

  const maskedSiteFiles = maskDisasterRecoverySecrets(siteFiles);
  const maskedDatabase = maskDisasterRecoverySecrets(resolvedDatabase);
  const maskedMail = maskDisasterRecoverySecrets(resolvedMail);
  const maskedConfig = maskDisasterRecoverySecrets(configuration);
  const maskedRelationships = maskDisasterRecoverySecrets(panelRelationships);
  const maskedEncryptionKeys = maskDisasterRecoverySecrets(encryptionKeys);

  const canonicalScope = {
    version: MANIFEST_VERSION,
    category: 'disaster_recovery_scope',
    serverId: normalizedServerId,
    websiteId: normalizedWebsiteId,
    categories: DISASTER_RECOVERY_CATEGORIES,
    siteFiles: maskedSiteFiles,
    database: maskedDatabase,
    databases: maskedDatabase,
    mail: maskedMail,
    mailData: maskedMail,
    configuration: maskedConfig,
    panelRelationships: maskedRelationships,
    encryptionKeys: maskedEncryptionKeys,
  };

  const scopeDigest = createHash('sha256').update(JSON.stringify(canonicalScope)).digest('hex');

  return Object.freeze({
    ...canonicalScope,
    createdAt: normalizeCreatedAt(createdAt),
    scopeDigest,
    secretsMasked: true,
  });
}

export function normalizeDisasterRecoveryScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.category !== 'disaster_recovery_scope'
    || value.version !== MANIFEST_VERSION
    || typeof value.scopeDigest !== 'string' || value.scopeDigest.length !== 64
    || value.secretsMasked !== true) {
    throw new BackupManifestError('backup_manifest_scope_invalid', 'Disaster recovery scope is invalid');
  }
  const serverId = safeIdentifier(value.serverId, 'serverId');
  const websiteId = safeUuid(value.websiteId, 'websiteId');

  for (const cat of DISASTER_RECOVERY_CATEGORIES) {
    const key = cat === 'site_files' ? 'siteFiles' : cat === 'panel_relationships' ? 'panelRelationships' : cat === 'encryption_keys' ? 'encryptionKeys' : cat;
    if (!value[key]) {
      throw new BackupManifestError('incomplete_disaster_recovery_scope', `Disaster recovery scope is missing category ${cat}`);
    }
  }

  const serialized = JSON.stringify(value);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(serialized)) {
    throw new BackupManifestError('backup_manifest_secret_leak_detected', 'Disaster recovery scope contains unmasked private keys');
  }

  return Object.freeze({
    ...value,
    serverId,
    websiteId,
  });
}

export function disasterRecoveryScopeResources(drScope) {
  const normalized = normalizeDisasterRecoveryScope(drScope);
  const resources = [
    {
      identity: `site_files:${normalized.websiteId}`,
      type: 'site_files',
      serverId: normalized.serverId,
      websiteId: normalized.websiteId,
      policy: Object.freeze({ disposition: 'include', reason: 'disaster_recovery_site_files' }),
      details: normalized.siteFiles,
    },
    {
      identity: `database:${normalized.websiteId}`,
      type: 'database',
      serverId: normalized.serverId,
      websiteId: normalized.websiteId,
      policy: Object.freeze({ disposition: 'include', reason: 'disaster_recovery_database' }),
      details: normalized.database,
    },
    {
      identity: `mail:${normalized.websiteId}`,
      type: 'mail',
      serverId: normalized.serverId,
      websiteId: normalized.websiteId,
      policy: Object.freeze({ disposition: 'include', reason: 'disaster_recovery_mail' }),
      details: normalized.mail,
    },
    {
      identity: `configuration:${normalized.websiteId}`,
      type: 'configuration',
      serverId: normalized.serverId,
      websiteId: normalized.websiteId,
      policy: Object.freeze({ disposition: 'include', reason: 'disaster_recovery_configuration' }),
      details: normalized.configuration,
    },
    {
      identity: `panel_relationships:${normalized.websiteId}`,
      type: 'panel_relationships',
      serverId: normalized.serverId,
      websiteId: normalized.websiteId,
      policy: Object.freeze({ disposition: 'include', reason: 'disaster_recovery_panel_relationships' }),
      details: normalized.panelRelationships,
    },
    {
      identity: `encryption_keys:${normalized.websiteId}`,
      type: 'encryption_keys',
      serverId: normalized.serverId,
      websiteId: normalized.websiteId,
      policy: Object.freeze({ disposition: 'include', reason: 'disaster_recovery_encryption_keys' }),
      details: normalized.encryptionKeys,
    },
  ];
  return Object.freeze(resources.map((r) => normalizeBackupResource(r, normalized.serverId)));
}

function normalizeBackupResource(value, expectedServerId = null) {
  if (value?.type === 'docker_storage') return normalizeDockerStorageResource(value, expectedServerId);
  if (value?.type === 'application') return normalizeApplicationResource(value, expectedServerId);
  if (value?.type === 'site_files') return normalizeSiteFilesResource(value, expectedServerId);
  if (value?.type === 'configuration') return normalizeConfigurationResource(value, expectedServerId);
  if (value?.type === 'panel_relationships') return normalizePanelRelationshipsResource(value, expectedServerId);
  if (value?.type === 'encryption_keys') return normalizeEncryptionKeysResource(value, expectedServerId);
  if (value?.type === 'database') return normalizeDatabaseManifestResource(value, expectedServerId);
  if (value?.type === 'mail' || value?.type === 'mail_data') return normalizeMailManifestResource(value, expectedServerId);
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
  disasterRecoveryScopes = [],
  createdAt = new Date().toISOString(),
} = {}) {
  const normalizedServerId = safeIdentifier(serverId, 'serverId');
  if (!Array.isArray(dockerProjects) || dockerProjects.length > MAX_PROJECTS) {
    throw new BackupManifestError('backup_manifest_projects_invalid', 'Docker project list is invalid');
  }
  if (!Array.isArray(applicationSnapshots) || applicationSnapshots.length > MAX_APPLICATIONS) {
    throw new BackupManifestError('backup_manifest_applications_invalid', 'Application snapshot list is invalid');
  }
  if (!Array.isArray(disasterRecoveryScopes) || disasterRecoveryScopes.length > 512) {
    throw new BackupManifestError('backup_manifest_scopes_invalid', 'Disaster recovery scope list is invalid');
  }
  const resources = [];
  for (const project of dockerProjects) {
    if (project?.serverId !== normalizedServerId) {
      throw new BackupManifestError('backup_manifest_server_mismatch', 'Docker project belongs to a different server');
    }
    resources.push(...dockerStorageBackupResources(project));
  }
  for (const entry of applicationSnapshots) {
    const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !entry.application || typeof entry.application !== 'object'
      || keys.length < 1 || keys.length > APPLICATION_INPUT_KEYS.size
      || keys.some((key) => !APPLICATION_INPUT_KEYS.has(key))) {
      throw new BackupManifestError('backup_manifest_applications_invalid', 'Application snapshot is invalid');
    }
    if (entry.application.serverId !== normalizedServerId) {
      throw new BackupManifestError('backup_manifest_server_mismatch', 'Application belongs to a different server');
    }
    resources.push(applicationBackupResource(entry.application, entry.environment ?? null));
  }
  for (const drScope of disasterRecoveryScopes) {
    if (drScope?.serverId !== normalizedServerId) {
      throw new BackupManifestError('backup_manifest_server_mismatch', 'Disaster recovery scope belongs to a different server');
    }
    resources.push(...disasterRecoveryScopeResources(drScope));
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
  normalizeSiteFilesResource,
  normalizeConfigurationResource,
  normalizePanelRelationshipsResource,
  normalizeEncryptionKeysResource,
  normalizeDatabaseManifestResource,
  normalizeMailManifestResource,
  resourceCounts,
  disasterRecoveryCategories: DISASTER_RECOVERY_CATEGORIES,
  maskDisasterRecoverySecrets,
});
