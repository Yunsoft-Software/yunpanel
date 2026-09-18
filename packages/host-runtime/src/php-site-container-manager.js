import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApplicationIdentity } from './application-identity.js';
import { createWebsiteIdentityPathManager } from './website-identity-path-manager.js';

const execFileAsync = promisify(execFile);
const CHOWN_PATH = '/usr/bin/chown';
const CHMOD_PATH = '/usr/bin/chmod';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIGRATION_RECEIPT_ROOT = '/var/lib/yunpanel/staging/php-container-migrations';
const MIGRATION_RECEIPT_VERSION = 1;
const MIGRATION_RECEIPT_STATES = new Set(['prepared', 'active', 'compensated']);

export class PhpSiteContainerManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpSiteContainerManagerError';
    this.code = code;
  }
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PhpSiteContainerManagerError('php_site_container_identity_invalid', `${field} is invalid`);
  }
  return value.toLowerCase();
}

function modeOf(value) {
  return Number(value?.mode ?? 0) & 0o777;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function migrationSpecDigest(spec) {
  return sha256(JSON.stringify({
    version: 1,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    releaseId: spec.releaseId,
    unixUser: spec.unixUser,
    applicationRoot: spec.applicationRoot,
    releasesDirectory: spec.releasesDirectory,
    currentRelease: spec.currentRelease,
  }));
}

function receiptMetadata(value, { symlink = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || (!symlink && (!Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777))) {
    throw new PhpSiteContainerManagerError('php_site_container_migration_receipt_invalid', 'PHP container migration receipt metadata is invalid');
  }
  return Object.freeze({
    uid: value.uid,
    gid: value.gid,
    ...(symlink ? {} : { mode: value.mode }),
  });
}

function normalizeMigrationReceipt(value, { operationId, spec } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== MIGRATION_RECEIPT_VERSION
    || value.operationId !== operationId
    || value.websiteId !== spec.websiteId
    || value.applicationId !== spec.applicationId
    || value.releaseId !== spec.releaseId
    || value.unixUser !== spec.unixUser
    || value.specDigest !== migrationSpecDigest(spec)
    || !MIGRATION_RECEIPT_STATES.has(value.state)
    || !value.previous || typeof value.previous !== 'object' || Array.isArray(value.previous)) {
    throw new PhpSiteContainerManagerError('php_site_container_migration_receipt_invalid', 'PHP container migration receipt is invalid');
  }
  return Object.freeze({
    version: MIGRATION_RECEIPT_VERSION,
    operationId,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    releaseId: spec.releaseId,
    unixUser: spec.unixUser,
    specDigest: value.specDigest,
    previous: Object.freeze({
      applicationRoot: receiptMetadata(value.previous.applicationRoot),
      releasesDirectory: receiptMetadata(value.previous.releasesDirectory),
      currentRelease: receiptMetadata(value.previous.currentRelease, { symlink: true }),
    }),
    state: value.state,
  });
}

function normalizeIntent(value, operationId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => ![
      'websiteId', 'applicationId', 'unixUser', 'documentRoot',
      'maxChildren', 'memoryLimitMb', 'maxExecutionSeconds',
    ].includes(key))) {
    throw new PhpSiteContainerManagerError('php_site_container_intent_invalid', 'PHP Website container intent is invalid');
  }
  const websiteId = uuid(value.websiteId, 'websiteId');
  const releaseId = uuid(operationId, 'operationId');
  let identity;
  try { identity = createApplicationIdentity(value.applicationId); }
  catch { throw new PhpSiteContainerManagerError('php_site_container_application_invalid', 'PHP Website Application identity is invalid'); }
  if (value.unixUser !== identity.unixUser) {
    throw new PhpSiteContainerManagerError('php_site_container_identity_mismatch', 'PHP Website Unix identity does not match the Application');
  }
  const documentRoot = path.posix.join(identity.paths.runtime.currentRelease, 'public');
  if (value.documentRoot !== documentRoot) {
    throw new PhpSiteContainerManagerError('php_site_container_document_root_invalid', 'PHP Website document root must use canonical current/public');
  }
  const releaseDirectory = path.posix.join(identity.paths.runtime.releasesDirectory, releaseId);
  return Object.freeze({
    websiteId,
    applicationId: identity.applicationId,
    releaseId,
    unixUser: identity.unixUser,
    identity,
    documentRoot,
    applicationRoot: identity.paths.runtime.applicationRoot,
    releasesDirectory: identity.paths.runtime.releasesDirectory,
    currentRelease: identity.paths.runtime.currentRelease,
    releaseDirectory,
    releaseDocumentRoot: path.posix.join(releaseDirectory, 'public'),
  });
}

function missing(error) {
  return error?.code === 'ENOENT';
}

export function createPhpSiteContainerManager({
  migrationReceiptRoot = MIGRATION_RECEIPT_ROOT,
  identityManager = createWebsiteIdentityPathManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: 128 * 1024,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  readlinkFn = readlink,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (!identityManager || typeof identityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function' || typeof readlinkFn !== 'function'
    || typeof renameFn !== 'function' || typeof rmFn !== 'function' || typeof writeFileFn !== 'function') {
    throw new PhpSiteContainerManagerError('php_site_container_dependencies_invalid', 'PHP Website container dependencies are invalid');
  }

  function migrationReceiptPath(operationId) {
    return path.posix.join(migrationReceiptRoot, `${operationId}.json`);
  }

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await rmFn(temporaryPath, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
      await renameFn(temporaryPath, targetPath);
    } finally {
      await rmFn(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function loadMigrationReceipt(operationId, spec) {
    let raw;
    try { raw = await readFileFn(migrationReceiptPath(operationId), 'utf8'); }
    catch (error) {
      if (missing(error)) return null;
      throw new PhpSiteContainerManagerError('php_site_container_migration_receipt_unavailable', 'PHP container migration receipt could not be read');
    }
    try { return normalizeMigrationReceipt(JSON.parse(raw), { operationId, spec }); }
    catch (error) {
      if (error instanceof PhpSiteContainerManagerError) throw error;
      throw new PhpSiteContainerManagerError('php_site_container_migration_receipt_invalid', 'PHP container migration receipt is invalid');
    }
  }

  async function persistMigrationReceipt(operationId, spec, value) {
    await mkdirFn(migrationReceiptRoot, { recursive: true, mode: 0o700 });
    const receipt = {
      version: MIGRATION_RECEIPT_VERSION,
      operationId,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      releaseId: spec.releaseId,
      unixUser: spec.unixUser,
      specDigest: migrationSpecDigest(spec),
      previous: value.previous,
      state: value.state,
    };
    await atomicWrite(migrationReceiptPath(operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return normalizeMigrationReceipt(receipt, { operationId, spec });
  }

  async function identityEvidence(spec) {
    const value = await identityManager.inspect({
      user: spec.unixUser,
      homeDirectory: spec.identity.paths.workspace.homeDirectory,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
    });
    if (!value?.satisfied) {
      return Object.freeze({ satisfied: false, reason: value?.reason ?? 'website_identity_unavailable' });
    }
    if (value.user !== spec.unixUser || value.homeDirectory !== spec.identity.paths.workspace.homeDirectory
      || !Number.isSafeInteger(value.uid) || value.uid < 1 || !Number.isSafeInteger(value.gid) || value.gid < 1) {
      throw new PhpSiteContainerManagerError('php_site_container_identity_drift', 'PHP Website identity drifted');
    }
    return value;
  }

  async function statPath(target, type) {
    try {
      const info = await lstatFn(target);
      const validType = type === 'directory' ? info?.isDirectory?.() : info?.isSymbolicLink?.();
      if (!validType) throw new PhpSiteContainerManagerError('php_site_container_path_drift', 'PHP Website runtime container type drifted');
      return info;
    } catch (error) {
      if (error instanceof PhpSiteContainerManagerError) throw error;
      if (missing(error)) return null;
      throw new PhpSiteContainerManagerError('php_site_container_path_unavailable', 'PHP Website runtime container could not be inspected');
    }
  }

  async function previewMigration(rawIntent, { operationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    let identity;
    try {
      const value = await identityEvidence(spec);
      identity = value?.satisfied === true
        ? Object.freeze({
          satisfied: true,
          uid: value.uid,
          gid: value.gid,
          homeDirectory: value.homeDirectory,
        })
        : Object.freeze({
          satisfied: false,
          reason: value?.reason ?? 'website_identity_unavailable',
        });
    } catch (error) {
      identity = Object.freeze({
        satisfied: false,
        reason: typeof error?.code === 'string' ? error.code : 'php_site_container_identity_inspection_failed',
      });
    }

    async function state(target) {
      try {
        const info = await lstatFn(target);
        return Object.freeze({
          present: true,
          directory: Boolean(info?.isDirectory?.()),
          symbolicLink: Boolean(info?.isSymbolicLink?.()),
          uid: Number.isSafeInteger(info?.uid) ? info.uid : null,
          gid: Number.isSafeInteger(info?.gid) ? info.gid : null,
          mode: modeOf(info).toString(8).padStart(4, '0'),
        });
      } catch (error) {
        if (missing(error)) return Object.freeze({ present: false });
        throw new PhpSiteContainerManagerError('php_site_container_path_unavailable', 'PHP Website runtime container could not be inspected');
      }
    }

    const [applicationRoot, releasesDirectory, releaseDirectory, releaseDocumentRoot, currentRelease] = await Promise.all([
      state(spec.applicationRoot),
      state(spec.releasesDirectory),
      state(spec.releaseDirectory),
      state(spec.releaseDocumentRoot),
      state(spec.currentRelease),
    ]);

    let currentTarget = null;
    let currentTargetError = null;
    if (currentRelease.present && currentRelease.symbolicLink) {
      try { currentTarget = await readlinkFn(spec.currentRelease); }
      catch { currentTargetError = 'php_site_container_current_unavailable'; }
    }

    const differences = [];
    if (!identity.satisfied) differences.push(identity.reason);
    const entries = [applicationRoot, releasesDirectory, releaseDirectory, releaseDocumentRoot, currentRelease];
    if (entries.some((entry) => !entry.present)) differences.push('php_site_container_path_missing');
    if (applicationRoot.present && (
      !applicationRoot.directory || applicationRoot.symbolicLink || applicationRoot.uid !== 0
      || applicationRoot.gid !== 0 || applicationRoot.mode !== '0755'
    )) differences.push('php_site_container_control_plane_drift');
    if (releasesDirectory.present && (
      !releasesDirectory.directory || releasesDirectory.symbolicLink || releasesDirectory.uid !== 0
      || releasesDirectory.gid !== 0 || releasesDirectory.mode !== '0755'
    )) differences.push('php_site_container_control_plane_drift');
    if (currentRelease.present && (
      !currentRelease.symbolicLink || currentRelease.uid !== 0 || currentRelease.gid !== 0
    )) differences.push('php_site_container_control_plane_drift');
    if (identity.satisfied && releaseDirectory.present && (
      !releaseDirectory.directory || releaseDirectory.symbolicLink
      || releaseDirectory.uid !== identity.uid || releaseDirectory.gid !== identity.gid
      || releaseDirectory.mode !== '0750'
    )) differences.push('php_site_container_release_drift');
    if (identity.satisfied && releaseDocumentRoot.present && (
      !releaseDocumentRoot.directory || releaseDocumentRoot.symbolicLink
      || releaseDocumentRoot.uid !== identity.uid || releaseDocumentRoot.gid !== identity.gid
      || releaseDocumentRoot.mode !== '0750'
    )) differences.push('php_site_container_release_drift');
    if (currentTargetError) differences.push(currentTargetError);
    else if (currentRelease.present && currentRelease.symbolicLink && currentTarget !== spec.releaseDirectory) {
      differences.push('php_site_container_current_drift');
    }

    const safeMigrationCandidate = differences.length > 0
      && identity.satisfied === true
      && applicationRoot.present === true && applicationRoot.directory === true && applicationRoot.symbolicLink === false
      && releasesDirectory.present === true && releasesDirectory.directory === true && releasesDirectory.symbolicLink === false
      && releaseDirectory.present === true && releaseDirectory.directory === true && releaseDirectory.symbolicLink === false
      && releaseDocumentRoot.present === true && releaseDocumentRoot.directory === true && releaseDocumentRoot.symbolicLink === false
      && releaseDirectory.uid === identity.uid && releaseDirectory.gid === identity.gid && releaseDirectory.mode === '0750'
      && releaseDocumentRoot.uid === identity.uid && releaseDocumentRoot.gid === identity.gid && releaseDocumentRoot.mode === '0750'
      && currentRelease.present === true && currentRelease.symbolicLink === true
      && currentTargetError === null && currentTarget === spec.releaseDirectory
      && [...new Set(differences)].every((code) => code === 'php_site_container_control_plane_drift');

    return Object.freeze({
      version: 1,
      adapter: 'php-container',
      satisfied: differences.length === 0,
      safeMigrationCandidate,
      current: Object.freeze({
        identity,
        applicationRoot,
        releasesDirectory,
        releaseDirectory,
        releaseDocumentRoot,
        currentRelease,
        currentTarget,
        currentTargetError,
      }),
      desired: Object.freeze({
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
        releaseId: spec.releaseId,
        unixUser: spec.unixUser,
        documentRoot: spec.documentRoot,
        applicationRoot: spec.applicationRoot,
        releasesDirectory: spec.releasesDirectory,
        currentRelease: spec.currentRelease,
        releaseDirectory: spec.releaseDirectory,
        releaseDocumentRoot: spec.releaseDocumentRoot,
        controlDirectoryMode: '0755',
        releaseDirectoryMode: '0750',
      }),
      differences: Object.freeze([...new Set(differences)]),
    });
  }

  async function inspect(rawIntent, { operationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const identity = await identityEvidence(spec);
    if (!identity.satisfied) return identity;

    const applicationRoot = await statPath(spec.applicationRoot, 'directory');
    const releasesDirectory = await statPath(spec.releasesDirectory, 'directory');
    const releaseDirectory = await statPath(spec.releaseDirectory, 'directory');
    const releaseDocumentRoot = await statPath(spec.releaseDocumentRoot, 'directory');
    const currentRelease = await statPath(spec.currentRelease, 'symlink');
    if (![applicationRoot, releasesDirectory, releaseDirectory, releaseDocumentRoot, currentRelease].every(Boolean)) {
      return Object.freeze({ satisfied: false, reason: 'php_site_container_path_missing' });
    }

    if (applicationRoot.uid !== 0 || applicationRoot.gid !== 0 || modeOf(applicationRoot) !== 0o755
      || releasesDirectory.uid !== 0 || releasesDirectory.gid !== 0 || modeOf(releasesDirectory) !== 0o755
      || currentRelease.uid !== 0 || currentRelease.gid !== 0) {
      throw new PhpSiteContainerManagerError('php_site_container_control_plane_drift', 'PHP runtime container is not control-plane owned');
    }
    if (releaseDirectory.uid !== identity.uid || releaseDirectory.gid !== identity.gid || modeOf(releaseDirectory) !== 0o750
      || releaseDocumentRoot.uid !== identity.uid || releaseDocumentRoot.gid !== identity.gid || modeOf(releaseDocumentRoot) !== 0o750) {
      throw new PhpSiteContainerManagerError('php_site_container_release_drift', 'PHP release content is not Website-owned');
    }
    let currentTarget;
    try { currentTarget = await readlinkFn(spec.currentRelease); }
    catch { throw new PhpSiteContainerManagerError('php_site_container_current_unavailable', 'PHP current release target could not be read'); }
    if (currentTarget !== spec.releaseDirectory) {
      throw new PhpSiteContainerManagerError('php_site_container_current_drift', 'PHP current release target drifted');
    }

    return Object.freeze({
      satisfied: true,
      adapter: 'php-container',
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      releaseId: spec.releaseId,
      unixUser: spec.unixUser,
      documentRoot: spec.documentRoot,
      applicationRoot: spec.applicationRoot,
      releasesDirectory: spec.releasesDirectory,
      currentRelease: spec.currentRelease,
      containerOwner: 'root:root',
      releaseUid: identity.uid,
      releaseGid: identity.gid,
    });
  }

  async function migrationSnapshot(spec) {
    const identity = await identityEvidence(spec);
    if (!identity.satisfied) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_identity_required', 'Website identity must remain canonical during PHP container migration');
    }
    const [applicationRoot, releasesDirectory, releaseDirectory, releaseDocumentRoot, currentRelease] = await Promise.all([
      statPath(spec.applicationRoot, 'directory'),
      statPath(spec.releasesDirectory, 'directory'),
      statPath(spec.releaseDirectory, 'directory'),
      statPath(spec.releaseDocumentRoot, 'directory'),
      statPath(spec.currentRelease, 'symlink'),
    ]);
    if (![applicationRoot, releasesDirectory, releaseDirectory, releaseDocumentRoot, currentRelease].every(Boolean)) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_path_missing', 'PHP container migration requires the existing canonical release tree');
    }
    if (applicationRoot.directory !== true || applicationRoot.symbolicLink === true
      || releasesDirectory.directory !== true || releasesDirectory.symbolicLink === true
      || releaseDirectory.directory !== true || releaseDirectory.symbolicLink === true
      || releaseDocumentRoot.directory !== true || releaseDocumentRoot.symbolicLink === true
      || currentRelease.symbolicLink !== true) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_path_type_drift', 'PHP container migration path types changed after preview');
    }
    if (releaseDirectory.uid !== identity.uid || releaseDirectory.gid !== identity.gid || modeOf(releaseDirectory) !== 0o750
      || releaseDocumentRoot.uid !== identity.uid || releaseDocumentRoot.gid !== identity.gid || modeOf(releaseDocumentRoot) !== 0o750) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_release_drift', 'PHP container migration will not mutate release content ownership or permissions');
    }
    let currentTarget;
    try { currentTarget = await readlinkFn(spec.currentRelease); }
    catch { throw new PhpSiteContainerManagerError('php_site_container_migration_current_unavailable', 'PHP container migration current release could not be read'); }
    if (currentTarget !== spec.releaseDirectory) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_current_drift', 'PHP container migration current release target has drifted');
    }
    return Object.freeze({
      applicationRoot: Object.freeze({ uid: applicationRoot.uid, gid: applicationRoot.gid, mode: modeOf(applicationRoot) }),
      releasesDirectory: Object.freeze({ uid: releasesDirectory.uid, gid: releasesDirectory.gid, mode: modeOf(releasesDirectory) }),
      currentRelease: Object.freeze({ uid: currentRelease.uid, gid: currentRelease.gid }),
    });
  }

  function metadataMatches(current, expected, { symlink = false } = {}) {
    return current.uid === expected.uid && current.gid === expected.gid && (symlink || current.mode === expected.mode);
  }

  function desiredMigrationMetadata() {
    return Object.freeze({
      applicationRoot: Object.freeze({ uid: 0, gid: 0, mode: 0o755 }),
      releasesDirectory: Object.freeze({ uid: 0, gid: 0, mode: 0o755 }),
      currentRelease: Object.freeze({ uid: 0, gid: 0 }),
    });
  }

  function assertReceiptCompatibleSnapshot(snapshot, receipt) {
    const desired = desiredMigrationMetadata();
    for (const name of ['applicationRoot', 'releasesDirectory']) {
      if (!metadataMatches(snapshot[name], receipt.previous[name]) && !metadataMatches(snapshot[name], desired[name])) {
        throw new PhpSiteContainerManagerError('php_site_container_migration_drift', 'PHP container metadata changed after the migration receipt checkpoint');
      }
    }
    if (!metadataMatches(snapshot.currentRelease, receipt.previous.currentRelease, { symlink: true })
      && !metadataMatches(snapshot.currentRelease, desired.currentRelease, { symlink: true })) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_drift', 'PHP current symlink ownership changed after the migration receipt checkpoint');
    }
  }

  async function inspectMigrationOperation(rawIntent, { operationId, migrationOperationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const receiptId = uuid(migrationOperationId, 'migrationOperationId');
    let receipt = await loadMigrationReceipt(receiptId, spec);
    if (!receipt) return Object.freeze({ satisfied: false, reason: 'php_site_container_migration_receipt_missing' });
    if (receipt.state === 'compensated') return Object.freeze({ satisfied: false, reason: 'php_site_container_migration_compensated' });
    const snapshot = await migrationSnapshot(spec);
    assertReceiptCompatibleSnapshot(snapshot, receipt);
    const desired = desiredMigrationMetadata();
    const satisfied = metadataMatches(snapshot.applicationRoot, desired.applicationRoot)
      && metadataMatches(snapshot.releasesDirectory, desired.releasesDirectory)
      && metadataMatches(snapshot.currentRelease, desired.currentRelease, { symlink: true });
    if (!satisfied) return Object.freeze({ satisfied: false, reason: 'php_site_container_migration_incomplete' });
    if (receipt.state !== 'active') {
      receipt = await persistMigrationReceipt(receiptId, spec, { ...receipt, state: 'active' });
    }
    return Object.freeze({
      satisfied: true,
      phpContainerReceiptVersion: MIGRATION_RECEIPT_VERSION,
      migratedPhpContainer: true,
      receiptState: receipt.state,
    });
  }

  async function applyMigration(rawIntent, { operationId, migrationOperationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const receiptId = uuid(migrationOperationId, 'migrationOperationId');
    let receipt = await loadMigrationReceipt(receiptId, spec);
    if (receipt?.state === 'compensated') {
      throw new PhpSiteContainerManagerError('php_site_container_migration_compensated', 'Compensated PHP container migration cannot be re-applied');
    }
    if (!receipt) {
      const preview = await previewMigration(rawIntent, { operationId });
      if (preview.satisfied === true) {
        throw new PhpSiteContainerManagerError('php_site_container_migration_not_operation_owned', 'Canonical PHP container state is not owned by this migration operation');
      }
      if (preview.safeMigrationCandidate !== true) {
        throw new PhpSiteContainerManagerError('php_site_container_migration_not_safe', 'PHP container migration is limited to exact non-recursive control-plane metadata repair');
      }
      receipt = await persistMigrationReceipt(receiptId, spec, {
        previous: {
          applicationRoot: { uid: preview.current.applicationRoot.uid, gid: preview.current.applicationRoot.gid, mode: Number.parseInt(preview.current.applicationRoot.mode, 8) },
          releasesDirectory: { uid: preview.current.releasesDirectory.uid, gid: preview.current.releasesDirectory.gid, mode: Number.parseInt(preview.current.releasesDirectory.mode, 8) },
          currentRelease: { uid: preview.current.currentRelease.uid, gid: preview.current.currentRelease.gid },
        },
        state: 'prepared',
      });
    }

    const snapshot = await migrationSnapshot(spec);
    assertReceiptCompatibleSnapshot(snapshot, receipt);
    const desired = desiredMigrationMetadata();
    try {
      if (!metadataMatches(snapshot.applicationRoot, desired.applicationRoot)) {
        await run(CHOWN_PATH, ['root:root', spec.applicationRoot], { timeout: 10_000 });
        await run(CHMOD_PATH, ['0755', spec.applicationRoot], { timeout: 10_000 });
      }
      if (!metadataMatches(snapshot.releasesDirectory, desired.releasesDirectory)) {
        await run(CHOWN_PATH, ['root:root', spec.releasesDirectory], { timeout: 10_000 });
        await run(CHMOD_PATH, ['0755', spec.releasesDirectory], { timeout: 10_000 });
      }
      if (!metadataMatches(snapshot.currentRelease, desired.currentRelease, { symlink: true })) {
        await run(CHOWN_PATH, ['-h', 'root:root', spec.currentRelease], { timeout: 10_000 });
      }
    } catch {
      throw new PhpSiteContainerManagerError('php_site_container_migration_apply_failed', 'PHP container migration metadata could not be applied');
    }
    const verified = await inspectMigrationOperation(rawIntent, { operationId, migrationOperationId: receiptId });
    if (!verified.satisfied) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_unverified', 'PHP container migration metadata could not be verified');
    }
    return verified;
  }

  async function inspectMigrationCompensation(rawIntent, { operationId, migrationOperationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const receiptId = uuid(migrationOperationId, 'migrationOperationId');
    const receipt = await loadMigrationReceipt(receiptId, spec);
    if (!receipt) return Object.freeze({ satisfied: false, reason: 'php_site_container_migration_receipt_missing' });
    const snapshot = await migrationSnapshot(spec);
    const desired = desiredMigrationMetadata();
    for (const name of ['applicationRoot', 'releasesDirectory']) {
      if (!metadataMatches(snapshot[name], receipt.previous[name]) && !metadataMatches(snapshot[name], desired[name])) {
        return Object.freeze({ satisfied: false, reason: 'php_site_container_migration_compensation_drift' });
      }
    }
    if (!metadataMatches(snapshot.currentRelease, receipt.previous.currentRelease, { symlink: true })
      && !metadataMatches(snapshot.currentRelease, desired.currentRelease, { symlink: true })) {
      return Object.freeze({ satisfied: false, reason: 'php_site_container_migration_compensation_drift' });
    }
    const restored = metadataMatches(snapshot.applicationRoot, receipt.previous.applicationRoot)
      && metadataMatches(snapshot.releasesDirectory, receipt.previous.releasesDirectory)
      && metadataMatches(snapshot.currentRelease, receipt.previous.currentRelease, { symlink: true });
    return Object.freeze({
      satisfied: restored,
      restoredPhpContainerMetadata: restored,
      receiptState: receipt.state,
      ...(restored ? {} : { reason: 'php_site_container_migration_compensation_pending' }),
    });
  }

  async function compensateMigration(rawIntent, { operationId, migrationOperationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const receiptId = uuid(migrationOperationId, 'migrationOperationId');
    let receipt = await loadMigrationReceipt(receiptId, spec);
    if (!receipt) throw new PhpSiteContainerManagerError('php_site_container_migration_receipt_missing', 'PHP container migration receipt is required for rollback');
    if (receipt.state === 'compensated') return inspectMigrationCompensation(rawIntent, { operationId, migrationOperationId: receiptId });
    const before = await inspectMigrationCompensation(rawIntent, { operationId, migrationOperationId: receiptId });
    if (before.reason === 'php_site_container_migration_compensation_drift') {
      throw new PhpSiteContainerManagerError('php_site_container_migration_compensation_drift', 'PHP container metadata changed after migration and cannot be safely restored');
    }
    if (!before.satisfied) {
      const snapshot = await migrationSnapshot(spec);
      const desired = desiredMigrationMetadata();
      try {
        if (!metadataMatches(snapshot.currentRelease, receipt.previous.currentRelease, { symlink: true })) {
          if (!metadataMatches(snapshot.currentRelease, desired.currentRelease, { symlink: true })) {
            throw new PhpSiteContainerManagerError('php_site_container_migration_compensation_drift', 'PHP current symlink ownership changed after migration');
          }
          await run(CHOWN_PATH, ['-h', `${receipt.previous.currentRelease.uid}:${receipt.previous.currentRelease.gid}`, spec.currentRelease], { timeout: 10_000 });
        }
        for (const [name, target] of [
          ['releasesDirectory', spec.releasesDirectory],
          ['applicationRoot', spec.applicationRoot],
        ]) {
          if (!metadataMatches(snapshot[name], receipt.previous[name])) {
            if (!metadataMatches(snapshot[name], desired[name])) {
              throw new PhpSiteContainerManagerError('php_site_container_migration_compensation_drift', 'PHP container metadata changed after migration');
            }
            await run(CHOWN_PATH, [`${receipt.previous[name].uid}:${receipt.previous[name].gid}`, target], { timeout: 10_000 });
            await run(CHMOD_PATH, [receipt.previous[name].mode.toString(8).padStart(4, '0'), target], { timeout: 10_000 });
          }
        }
      } catch (error) {
        if (error instanceof PhpSiteContainerManagerError) throw error;
        throw new PhpSiteContainerManagerError('php_site_container_migration_compensation_failed', 'PHP container migration metadata could not be restored');
      }
    }
    const after = await inspectMigrationCompensation(rawIntent, { operationId, migrationOperationId: receiptId });
    if (!after.satisfied) {
      throw new PhpSiteContainerManagerError('php_site_container_migration_compensation_unverified', 'PHP container migration rollback could not be verified');
    }
    receipt = await persistMigrationReceipt(receiptId, spec, { ...receipt, state: 'compensated' });
    return Object.freeze({ ...after, receiptState: receipt.state });
  }

  async function apply(rawIntent, { operationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const identity = await identityEvidence(spec);
    if (!identity.satisfied) {
      throw new PhpSiteContainerManagerError('php_site_container_identity_required', 'Website identity must be ready before PHP container lockdown');
    }

    const releaseDirectory = await statPath(spec.releaseDirectory, 'directory');
    const releaseDocumentRoot = await statPath(spec.releaseDocumentRoot, 'directory');
    const applicationRoot = await statPath(spec.applicationRoot, 'directory');
    const releasesDirectory = await statPath(spec.releasesDirectory, 'directory');
    const currentRelease = await statPath(spec.currentRelease, 'symlink');
    if (![applicationRoot, releasesDirectory, releaseDirectory, releaseDocumentRoot, currentRelease].every(Boolean)) {
      throw new PhpSiteContainerManagerError('php_site_container_bootstrap_required', 'PHP bootstrap must complete before container lockdown');
    }
    if (releaseDirectory.uid !== identity.uid || releaseDirectory.gid !== identity.gid || modeOf(releaseDirectory) !== 0o750
      || releaseDocumentRoot.uid !== identity.uid || releaseDocumentRoot.gid !== identity.gid || modeOf(releaseDocumentRoot) !== 0o750) {
      throw new PhpSiteContainerManagerError('php_site_container_release_drift', 'PHP release content drifted before container lockdown');
    }
    let currentTarget;
    try { currentTarget = await readlinkFn(spec.currentRelease); }
    catch { throw new PhpSiteContainerManagerError('php_site_container_current_unavailable', 'PHP current release target could not be read'); }
    if (currentTarget !== spec.releaseDirectory) {
      throw new PhpSiteContainerManagerError('php_site_container_current_drift', 'PHP current release target drifted before lockdown');
    }

    try {
      await run(CHOWN_PATH, ['root:root', spec.applicationRoot], { timeout: 10_000 });
      await run(CHMOD_PATH, ['0755', spec.applicationRoot], { timeout: 10_000 });
      await run(CHOWN_PATH, ['root:root', spec.releasesDirectory], { timeout: 10_000 });
      await run(CHMOD_PATH, ['0755', spec.releasesDirectory], { timeout: 10_000 });
      await run(CHOWN_PATH, ['-h', 'root:root', spec.currentRelease], { timeout: 10_000 });
    } catch {
      throw new PhpSiteContainerManagerError('php_site_container_lockdown_failed', 'PHP runtime container could not be locked to the control plane');
    }

    const verified = await inspect(rawIntent, { operationId });
    if (!verified.satisfied) {
      throw new PhpSiteContainerManagerError('php_site_container_lockdown_unverified', 'PHP runtime container lockdown could not be verified');
    }
    return verified;
  }

  return Object.freeze({
    inspect,
    previewMigration,
    inspectMigrationOperation,
    applyMigration,
    inspectMigrationCompensation,
    compensateMigration,
    apply,
  });
}

export const phpSiteContainerManagerInternals = Object.freeze({
  normalizeIntent,
  modeOf,
  migrationSpecDigest,
  normalizeMigrationReceipt,
  paths: Object.freeze({ CHOWN_PATH, CHMOD_PATH, MIGRATION_RECEIPT_ROOT }),
});
