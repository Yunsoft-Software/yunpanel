import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const STATUSES = new Set([
  'pending',
  'applying',
  'succeeded',
  'failed',
  'compensating',
  'compensated',
  'compensation_failed',
]);

export class WebsiteIsolationMigrationRegistryError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteIsolationMigrationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', `${field} is invalid`); }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration timestamp is invalid');
  }
  return value;
}

function safeCode(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value)) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration error code is invalid');
  }
  return value;
}

function target(value) {
  const fields = new Set(['name', 'directory', 'mode']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !['temporary', 'logs'].includes(value.name)
    || typeof value.directory !== 'string' || !value.directory.startsWith('/')
    || !['0700', '0750'].includes(value.mode)) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration target is invalid');
  }
  return Object.freeze({ name: value.name, directory: value.directory, mode: value.mode });
}

function intent(value) {
  const fields = new Set(['websiteId', 'applicationId', 'user', 'homeDirectory', 'targets', 'adapter', 'sourceOperationId']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![5, 6, 7].includes(Object.keys(value).length) || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.user !== 'string' || !USER_PATTERN.test(value.user)
    || typeof value.homeDirectory !== 'string' || !value.homeDirectory.startsWith('/')
    || !Array.isArray(value.targets) || value.targets.length > 2) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration intent is invalid');
  }
  const targets = value.targets.map(target);
  const adapter = value.adapter ?? (targets.length === 0 ? 'identity' : 'workspace');
  const sourceOperationId = value.sourceOperationId === undefined ? null : uuid(value.sourceOperationId, 'sourceOperationId');
  if (!['workspace', 'identity', 'sftp', 'php', 'php_container', 'static_control'].includes(adapter)
    || (adapter === 'workspace' && targets.length < 1)
    || (adapter !== 'workspace' && targets.length !== 0)
    || (['php', 'php_container', 'static_control'].includes(adapter) && sourceOperationId === null)
    || (!['php', 'php_container', 'static_control'].includes(adapter) && sourceOperationId !== null)) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration adapter is invalid');
  }
  if (new Set(targets.map((entry) => entry.name)).size !== targets.length) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration targets are not unique');
  }
  let applicationIdentity;
  try { applicationIdentity = createApplicationIdentity(value.applicationId); }
  catch {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration application identity is invalid');
  }
  const expectedTargets = Object.freeze({
    temporary: Object.freeze({
      directory: applicationIdentity.paths.workspace.temporaryDirectory,
      mode: applicationIdentity.paths.workspace.temporaryMode.toString(8).padStart(4, '0'),
    }),
    logs: Object.freeze({
      directory: applicationIdentity.paths.workspace.logDirectory,
      mode: applicationIdentity.paths.workspace.logMode.toString(8).padStart(4, '0'),
    }),
  });
  if (value.user !== applicationIdentity.unixUser
    || value.homeDirectory !== applicationIdentity.paths.workspace.homeDirectory
    || targets.some((entry) => entry.directory !== expectedTargets[entry.name].directory
      || entry.mode !== expectedTargets[entry.name].mode)) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration intent is outside the canonical application workspace');
  }
  return Object.freeze({
    websiteId: uuid(value.websiteId, 'websiteId'),
    applicationId: uuid(value.applicationId, 'applicationId'),
    user: value.user,
    homeDirectory: value.homeDirectory,
    targets: Object.freeze(targets),
    adapter,
    ...(sourceOperationId === null ? {} : { sourceOperationId }),
  });
}

function evidence(value, field) {
  if (value === null) return null;
  const fields = new Set([
    'satisfied',
    'workspaceReceiptVersion',
    'createdWorkspaceDirectories',
    'removedWorkspaceDirectories',
    'identityReceiptVersion',
    'createdUnixIdentity',
    'removedUser',
    'removedGroup',
    'removedHome',
    'preservedHomeData',
    'sftpReceiptVersion',
    'activatedSftpIsolation',
    'removedSftpIsolation',
    'authorizedKeyCount',
    'authorizedKeysSha256',
    'phpFpmReceiptVersion',
    'createdPhpFpmPool',
    'phpContainerReceiptVersion',
    'migratedPhpContainer',
    'restoredPhpContainerMetadata',
    'staticControlReceiptVersion',
    'migratedStaticControlMetadata',
    'restoredStaticControlMetadata',
    'restoredPrevious',
    'preservedExisting',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.has(key))
    || value.satisfied !== true
    || (value.workspaceReceiptVersion !== undefined && value.workspaceReceiptVersion !== 1)
    || (value.identityReceiptVersion !== undefined && value.identityReceiptVersion !== 1)
    || (value.sftpReceiptVersion !== undefined && value.sftpReceiptVersion !== 1)
    || (value.phpFpmReceiptVersion !== undefined && value.phpFpmReceiptVersion !== 1)
    || (value.phpContainerReceiptVersion !== undefined && value.phpContainerReceiptVersion !== 1)
    || (value.staticControlReceiptVersion !== undefined && value.staticControlReceiptVersion !== 1)
    || (value.authorizedKeyCount !== undefined
      && (!Number.isSafeInteger(value.authorizedKeyCount) || value.authorizedKeyCount < 0 || value.authorizedKeyCount > 100))
    || (value.authorizedKeysSha256 !== undefined
      && (typeof value.authorizedKeysSha256 !== 'string' || !SHA256_PATTERN.test(value.authorizedKeysSha256)))
    || (value.createdWorkspaceDirectories !== undefined
      && (!Number.isSafeInteger(value.createdWorkspaceDirectories) || value.createdWorkspaceDirectories < 0 || value.createdWorkspaceDirectories > 2))
    || (value.removedWorkspaceDirectories !== undefined
      && (!Number.isSafeInteger(value.removedWorkspaceDirectories) || value.removedWorkspaceDirectories < 0 || value.removedWorkspaceDirectories > 2))
    || ['createdUnixIdentity', 'removedUser', 'removedGroup', 'removedHome', 'preservedHomeData', 'activatedSftpIsolation', 'removedSftpIsolation', 'createdPhpFpmPool', 'migratedPhpContainer', 'restoredPhpContainerMetadata', 'migratedStaticControlMetadata', 'restoredStaticControlMetadata', 'restoredPrevious', 'preservedExisting']
      .some((key) => value[key] !== undefined && typeof value[key] !== 'boolean')) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', `${field} is invalid`);
  }
  return Object.freeze({
    satisfied: true,
    ...(value.workspaceReceiptVersion === undefined ? {} : { workspaceReceiptVersion: value.workspaceReceiptVersion }),
    ...(value.createdWorkspaceDirectories === undefined ? {} : { createdWorkspaceDirectories: value.createdWorkspaceDirectories }),
    ...(value.removedWorkspaceDirectories === undefined ? {} : { removedWorkspaceDirectories: value.removedWorkspaceDirectories }),
    ...(value.identityReceiptVersion === undefined ? {} : { identityReceiptVersion: value.identityReceiptVersion }),
    ...(value.createdUnixIdentity === undefined ? {} : { createdUnixIdentity: value.createdUnixIdentity }),
    ...(value.removedUser === undefined ? {} : { removedUser: value.removedUser }),
    ...(value.removedGroup === undefined ? {} : { removedGroup: value.removedGroup }),
    ...(value.removedHome === undefined ? {} : { removedHome: value.removedHome }),
    ...(value.preservedHomeData === undefined ? {} : { preservedHomeData: value.preservedHomeData }),
    ...(value.sftpReceiptVersion === undefined ? {} : { sftpReceiptVersion: value.sftpReceiptVersion }),
    ...(value.activatedSftpIsolation === undefined ? {} : { activatedSftpIsolation: value.activatedSftpIsolation }),
    ...(value.removedSftpIsolation === undefined ? {} : { removedSftpIsolation: value.removedSftpIsolation }),
    ...(value.authorizedKeyCount === undefined ? {} : { authorizedKeyCount: value.authorizedKeyCount }),
    ...(value.authorizedKeysSha256 === undefined ? {} : { authorizedKeysSha256: value.authorizedKeysSha256 }),
    ...(value.phpFpmReceiptVersion === undefined ? {} : { phpFpmReceiptVersion: value.phpFpmReceiptVersion }),
    ...(value.createdPhpFpmPool === undefined ? {} : { createdPhpFpmPool: value.createdPhpFpmPool }),
    ...(value.phpContainerReceiptVersion === undefined ? {} : { phpContainerReceiptVersion: value.phpContainerReceiptVersion }),
    ...(value.migratedPhpContainer === undefined ? {} : { migratedPhpContainer: value.migratedPhpContainer }),
    ...(value.restoredPhpContainerMetadata === undefined ? {} : { restoredPhpContainerMetadata: value.restoredPhpContainerMetadata }),
    ...(value.staticControlReceiptVersion === undefined ? {} : { staticControlReceiptVersion: value.staticControlReceiptVersion }),
    ...(value.migratedStaticControlMetadata === undefined ? {} : { migratedStaticControlMetadata: value.migratedStaticControlMetadata }),
    ...(value.restoredStaticControlMetadata === undefined ? {} : { restoredStaticControlMetadata: value.restoredStaticControlMetadata }),
    ...(value.restoredPrevious === undefined ? {} : { restoredPrevious: value.restoredPrevious }),
    ...(value.preservedExisting === undefined ? {} : { preservedExisting: value.preservedExisting }),
  });
}

function persistedOperation(value) {
  const fields = new Set([
    'id', 'websiteId', 'applicationId', 'websiteRevision', 'previewDigest', 'intent', 'status',
    'result', 'compensation', 'error', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.websiteRevision) || value.websiteRevision < 1
    || typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || !STATUSES.has(value.status)) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration state is invalid');
  }
  const normalizedIntent = intent(value.intent);
  const operation = Object.freeze({
    id: uuid(value.id, 'operationId'),
    websiteId: uuid(value.websiteId, 'websiteId'),
    applicationId: uuid(value.applicationId, 'applicationId'),
    websiteRevision: value.websiteRevision,
    previewDigest: value.previewDigest,
    intent: normalizedIntent,
    status: value.status,
    result: evidence(value.result, 'Website isolation migration result evidence'),
    compensation: evidence(value.compensation, 'Website isolation migration compensation evidence'),
    error: safeCode(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (operation.intent.websiteId !== operation.websiteId || operation.intent.applicationId !== operation.applicationId) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration intent identity has drifted');
  }
  if (operation.status === 'succeeded' && operation.result === null) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Succeeded Website isolation migration lacks evidence');
  }
  if (!['succeeded', 'compensating', 'compensated', 'compensation_failed'].includes(operation.status) && operation.result !== null) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Incomplete Website isolation migration contains result evidence');
  }
  if (operation.status === 'compensated' && operation.compensation === null) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Compensated Website isolation migration lacks evidence');
  }
  if (operation.status !== 'compensated' && operation.compensation !== null) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration compensation evidence is inconsistent');
  }
  if (['failed', 'compensation_failed'].includes(operation.status) !== (operation.error !== null)) {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration error state is inconsistent');
  }
  return operation;
}

function operationFromAudit(audit, now, idFactory) {
  const migration = audit?.migration;
  const change = migration?.changes?.length === 1 ? migration.changes[0] : null;
  const identityCreate = change?.action === 'create_canonical_unix_identity';
  const sftpCreate = change?.action === 'create_sftp_isolation';
  const phpCreate = change?.action === 'create_php_fpm_pool';
  const phpContainerRepair = change?.action === 'repair_php_container_metadata';
  const staticControlRepair = change?.action === 'repair_static_control_metadata';
  const sourceOperationId = phpCreate || phpContainerRepair || staticControlRepair
    ? uuid(change?.current?.operationId, 'sourceOperationId')
    : null;
  const adapter = identityCreate
    ? 'identity'
    : sftpCreate
      ? 'sftp'
      : phpCreate
        ? 'php'
        : phpContainerRepair
          ? 'php_container'
          : staticControlRepair
            ? 'static_control'
            : 'workspace';
  const targets = change?.action === 'create_workspace_directories'
    ? change.desired?.directories
    : identityCreate || sftpCreate || phpCreate || phpContainerRepair || staticControlRepair
      ? []
      : null;
  if (audit?.applicable !== true || audit.migrationRequired !== true
    || migration?.applyAvailable !== true || change?.applyState !== 'requires_explicit_apply'
    || !Array.isArray(targets) || targets.length > 2
    || (identityCreate && (
      change.current?.identityMigrationPreview?.safeCreateCandidate !== true
      || change.desired?.identity?.user !== audit.expected?.unixUser
      || change.desired?.identity?.homeDirectory !== audit.expected?.homeDirectory
    ))
    || (sftpCreate && (
      change.current?.sftpMigrationPreview?.safeCreateCandidate !== true
      || change.desired?.sftp?.websiteId !== audit.websiteId
      || change.desired?.sftp?.applicationId !== audit.applicationId
      || change.desired?.sftp?.unixUser !== audit.expected?.unixUser
      || change.desired?.sftp?.sourceDirectory !== createApplicationIdentity(audit.applicationId).paths.workspace.sftpRoot
    ))
    || (phpCreate && (
      change.current?.phpRuntimeMigrationPreview?.safeCreateCandidate !== true
      || change.desired?.phpRuntime?.websiteId !== audit.websiteId
      || change.desired?.phpRuntime?.applicationId !== audit.applicationId
      || change.desired?.phpRuntime?.unixUser !== audit.expected?.unixUser
      || change.desired?.phpRuntime?.documentRoot !== path.posix.join(
        createApplicationIdentity(audit.applicationId).paths.runtime.currentRelease,
        'public',
      )
      || change.desired?.phpRuntime?.runtimeUmask !== '0027'
    ))
    || (phpContainerRepair && (
      change.current?.phpRuntimeMigrationPreview?.safeContainerMigrationCandidate !== true
      || change.current?.phpRuntimeMigrationPreview?.current?.container?.safeMigrationCandidate !== true
      || change.desired?.phpContainer?.websiteId !== audit.websiteId
      || change.desired?.phpContainer?.applicationId !== audit.applicationId
      || change.desired?.phpContainer?.releaseId !== sourceOperationId
      || change.desired?.phpContainer?.unixUser !== audit.expected?.unixUser
      || change.desired?.phpContainer?.documentRoot !== path.posix.join(
        createApplicationIdentity(audit.applicationId).paths.runtime.currentRelease,
        'public',
      )
      || change.desired?.phpContainer?.applicationRoot !== createApplicationIdentity(audit.applicationId).paths.runtime.applicationRoot
      || change.desired?.phpContainer?.releasesDirectory !== createApplicationIdentity(audit.applicationId).paths.runtime.releasesDirectory
      || change.desired?.phpContainer?.currentRelease !== createApplicationIdentity(audit.applicationId).paths.runtime.currentRelease
      || change.desired?.phpContainer?.releaseDirectory !== path.posix.join(
        createApplicationIdentity(audit.applicationId).paths.runtime.releasesDirectory,
        sourceOperationId,
      )
      || change.desired?.phpContainer?.releaseDocumentRoot !== path.posix.join(
        createApplicationIdentity(audit.applicationId).paths.runtime.releasesDirectory,
        sourceOperationId,
        'public',
      )
      || change.desired?.phpContainer?.controlDirectoryMode !== '0755'
      || change.desired?.phpContainer?.releaseDirectoryMode !== '0750'
    ))
    || (staticControlRepair && (
      change.current?.staticRuntimeMigrationPreview?.safeControlMigrationCandidate !== true
      || change.current?.staticRuntimeMigrationPreview?.current?.isolation?.safeMigrationCandidate !== true
      || change.desired?.staticControl?.websiteId !== audit.websiteId
      || change.desired?.staticControl?.applicationId !== audit.applicationId
      || change.desired?.staticControl?.unixUser !== audit.expected?.unixUser
      || change.desired?.staticControl?.homeDirectory !== audit.expected?.homeDirectory
      || change.desired?.staticControl?.publishRoot !== createApplicationIdentity(audit.applicationId).paths.static.publishRoot
      || change.desired?.staticControl?.releasesRoot !== path.posix.join(
        createApplicationIdentity(audit.applicationId).paths.static.publishRoot,
        'releases',
      )
      || change.desired?.staticControl?.currentPath !== path.posix.join(
        createApplicationIdentity(audit.applicationId).paths.static.publishRoot,
        'current',
      )
      || change.desired?.staticControl?.controlDirectoryMode !== '0711'
      || change.desired?.staticControl?.releaseDirectoryMode !== '0750'
      || change.desired?.staticControl?.releaseFileMode !== '0640'
      || change.desired?.staticControl?.nginxDirectoryAcl !== 'user:www-data:r-x'
      || change.desired?.staticControl?.nginxFileAcl !== 'user:www-data:r--'
      || change.desired?.staticControl?.aclPackage !== 'acl'
    ))
    || typeof audit.expected?.unixUser !== 'string' || typeof audit.expected?.homeDirectory !== 'string') {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_preview_invalid', 'Website isolation migration preview cannot be journaled');
  }
  const time = new Date(now()).toISOString();
  return persistedOperation({
    id: idFactory(),
    websiteId: audit.websiteId,
    applicationId: audit.applicationId,
    websiteRevision: audit.websiteRevision,
    previewDigest: migration.previewDigest,
    intent: {
      websiteId: audit.websiteId,
      applicationId: audit.applicationId,
      user: audit.expected.unixUser,
      homeDirectory: audit.expected.homeDirectory,
      targets,
      adapter,
      ...(sourceOperationId === null ? {} : { sourceOperationId }),
    },
    status: 'pending',
    result: null,
    compensation: null,
    error: null,
    createdAt: time,
    updatedAt: time,
  });
}

export function websiteIsolationMigrationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    websiteId: operation.websiteId,
    applicationId: operation.applicationId,
    websiteRevision: operation.websiteRevision,
    previewDigest: operation.previewDigest,
    adapter: operation.intent.adapter,
    targets: operation.intent.targets,
    status: operation.status,
    result: operation.result,
    compensation: operation.compensation,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createWebsiteIsolationMigrationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_dependencies_invalid', 'Website isolation migration registry dependencies are unavailable', 503);
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
          throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration store is invalid');
        }
        const operations = parsed.operations.map(persistedOperation);
        if (new Set(operations.map((entry) => entry.id)).size !== operations.length) {
          throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_state_invalid', 'Website isolation migration operation IDs are not unique');
        }
        state = { version: STORE_VERSION, operations };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist();
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function create(audit) {
    await ensureInitialized();
    const duplicate = state.operations.find((entry) => entry.websiteId === audit?.websiteId
      && entry.previewDigest === audit?.migration?.previewDigest
      && !['compensated', 'failed', 'compensation_failed'].includes(entry.status));
    if (duplicate) return duplicate;
    const operation = operationFromAudit(audit, now, idFactory);
    state.operations.push(operation);
    await persist();
    return operation;
  }

  async function get(operationId) {
    await ensureInitialized();
    const id = uuid(operationId, 'operationId');
    return state.operations.find((entry) => entry.id === id) ?? null;
  }

  async function listForWebsite(websiteId) {
    await ensureInitialized();
    const id = uuid(websiteId, 'websiteId');
    return state.operations.filter((entry) => entry.websiteId === id);
  }

  async function listInterrupted() {
    await ensureInitialized();
    return state.operations.filter((entry) => ['applying', 'compensating'].includes(entry.status));
  }

  async function mutate(operationId, update) {
    const current = await get(operationId);
    if (!current) throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_not_found', 'Website isolation migration was not found', 404);
    const next = persistedOperation({ ...current, ...update, updatedAt: new Date(now()).toISOString() });
    const index = state.operations.findIndex((entry) => entry.id === current.id);
    state.operations[index] = next;
    await persist();
    return next;
  }

  async function transition(operationId, allowed, status, update = {}) {
    const current = await get(operationId);
    if (!current) throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_not_found', 'Website isolation migration was not found', 404);
    if (current.status === status) return current;
    if (!allowed.includes(current.status)) {
      throw new WebsiteIsolationMigrationRegistryError('website_isolation_migration_transition_invalid', `Website isolation migration cannot enter ${status}`);
    }
    return mutate(current.id, { status, ...update });
  }

  return Object.freeze({
    init,
    create,
    get,
    listForWebsite,
    listInterrupted,
    markApplying: (id) => transition(id, ['pending'], 'applying'),
    succeed: (id, result) => transition(id, ['applying'], 'succeeded', { result: evidence(result, 'Website isolation migration result evidence'), error: null }),
    fail: (id, error) => transition(id, ['pending', 'applying'], 'failed', { result: null, error: safeCode(error) }),
    markCompensating: (id) => transition(id, ['succeeded', 'failed', 'compensation_failed'], 'compensating', { compensation: null, error: null }),
    compensate: (id, result) => transition(id, ['compensating'], 'compensated', { compensation: evidence(result, 'Website isolation migration compensation evidence'), error: null }),
    failCompensation: (id, error) => transition(id, ['compensating'], 'compensation_failed', { compensation: null, error: safeCode(error) }),
  });
}

export const websiteIsolationMigrationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  statuses: Object.freeze([...STATUSES]),
  persistedOperation,
  operationFromAudit,
  evidence,
  intent,
});
