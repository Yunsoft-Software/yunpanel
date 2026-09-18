import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, chown, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApplicationIdentity } from './application-identity.js';
import { createWebsiteIdentityPathManager } from './website-identity-path-manager.js';

const execFileAsync = promisify(execFile);
const APT_GET_PATH = '/usr/bin/apt-get';
const SETFACL_PATH = '/usr/bin/setfacl';
const GETFACL_PATH = '/usr/bin/getfacl';
const CHOWN_PATH = '/usr/bin/chown';
const ACL_PACKAGE = 'acl';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIGRATION_RECEIPT_ROOT = '/var/lib/yunpanel/staging/static-control-migrations';
const MIGRATION_RECEIPT_VERSION = 1;
const MIGRATION_RECEIPT_STATES = new Set(['prepared', 'active', 'compensated']);
const MAX_RELEASE_PREVIEW_ENTRIES = 50_000;
const MAX_RELEASE_RECEIPT_ACL_BYTES = 64 * 1024 * 1024;
const RELEASE_MIGRATION_RECEIPT_ROOT = '/var/lib/yunpanel/staging/static-release-migrations';
const RELEASE_MIGRATION_RECEIPT_VERSION = 1;

export class StaticPublishIsolationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticPublishIsolationError';
    this.code = code;
  }
}

function normalizeIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['websiteId', 'applicationId'].includes(key))
    || typeof value.websiteId !== 'string' || !UUID_PATTERN.test(value.websiteId)) {
    throw new StaticPublishIsolationError('static_publish_isolation_intent_invalid', 'Static publish isolation intent is invalid');
  }
  let identity;
  try { identity = createApplicationIdentity(value.applicationId); }
  catch { throw new StaticPublishIsolationError('static_publish_isolation_application_invalid', 'Static publish Application identity is invalid'); }
  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    applicationId: identity.applicationId,
    identity,
    publishRoot: identity.paths.static.publishRoot,
    releasesRoot: path.posix.join(identity.paths.static.publishRoot, 'releases'),
    currentPath: path.posix.join(identity.paths.static.publishRoot, 'current'),
  });
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalAcl(value) {
  const lines = String(value ?? '').split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+#effective:[rwx-]{3}\s*$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.some((line) => !/^(?:default:)?(?:user|group|mask|other):[^:]*:[rwx-]{3}$/.test(line))) {
    throw new StaticPublishIsolationError('static_publish_acl_format_invalid', 'Static publish ACL contains an unsupported entry');
  }
  return `${[...new Set(lines)].sort().join('\n')}\n`;
}

function modeAdjustedReleaseAcl(previousAcl, type) {
  const ownerPermission = type === 'directory' ? 'rwx' : 'rw-';
  const groupPermission = type === 'directory' ? 'r-x' : 'r--';
  const otherPermission = '---';
  const lines = canonicalAcl(previousAcl).trim().split('\n').filter(Boolean);
  const hasMask = lines.some((line) => line.startsWith('mask::'));
  const adjusted = lines.map((line) => {
    if (line.startsWith('user::')) return `user::${ownerPermission}`;
    if (line.startsWith('other::')) return `other::${otherPermission}`;
    if (hasMask && line.startsWith('mask::')) return `mask::${groupPermission}`;
    if (!hasMask && line.startsWith('group::')) return `group::${groupPermission}`;
    return line;
  });
  return `${[...new Set(adjusted)].sort().join('\n')}\n`;
}

function desiredReleaseAcl(previousAcl, type) {
  const permission = type === 'directory' ? 'r-x' : 'r--';
  const lines = modeAdjustedReleaseAcl(previousAcl, type).trim().split('\n').filter(Boolean);
  const retained = lines.filter((line) => !line.startsWith('user:www-data:') && !line.startsWith('mask::'));
  retained.push(`user:www-data:${permission}`, `mask::${permission}`);
  return `${[...new Set(retained)].sort().join('\n')}\n`;
}

function relativeReleasePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
    || value.includes('\0') || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value || value.split('/').includes('..')) {
    throw new StaticPublishIsolationError('static_publish_release_receipt_invalid', 'Static release receipt path is invalid');
  }
  const [releaseId] = value.split('/');
  if (!UUID_PATTERN.test(releaseId)) {
    throw new StaticPublishIsolationError('static_publish_release_receipt_invalid', 'Static release receipt path is outside a managed release');
  }
  return value;
}

function releaseSnapshotDigest(entries) {
  return sha256(JSON.stringify(entries.map((entry) => ({
    relativePath: entry.relativePath,
    type: entry.type,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    dev: entry.dev,
    ino: entry.ino,
    aclSha256: sha256(entry.acl),
  }))));
}

function normalizeReleaseReceiptEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['file', 'directory'].includes(value.type)
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777
    || !Number.isSafeInteger(value.dev) || value.dev < 0
    || !Number.isSafeInteger(value.ino) || value.ino < 0
    || typeof value.acl !== 'string' || Buffer.byteLength(value.acl, 'utf8') > 65_536
    || typeof value.desiredAcl !== 'string' || Buffer.byteLength(value.desiredAcl, 'utf8') > 65_536) {
    throw new StaticPublishIsolationError('static_publish_release_receipt_invalid', 'Static release receipt entry is invalid');
  }
  const relativePath = relativeReleasePath(value.relativePath);
  const acl = canonicalAcl(value.acl);
  const desiredAcl = canonicalAcl(value.desiredAcl);
  if (acl !== value.acl || desiredAcl !== value.desiredAcl
    || desiredAcl !== desiredReleaseAcl(acl, value.type)) {
    throw new StaticPublishIsolationError('static_publish_release_receipt_invalid', 'Static release receipt ACL is invalid');
  }
  return Object.freeze({
    relativePath,
    type: value.type,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
    dev: value.dev,
    ino: value.ino,
    acl,
    desiredAcl,
  });
}

function normalizeReleaseMigrationReceipt(value, { operationId, spec } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== RELEASE_MIGRATION_RECEIPT_VERSION
    || value.operationId !== operationId
    || value.websiteId !== spec.websiteId
    || value.applicationId !== spec.applicationId
    || value.specDigest !== migrationSpecDigest(spec)
    || !MIGRATION_RECEIPT_STATES.has(value.state)
    || !Number.isSafeInteger(value.desiredUid) || value.desiredUid < 1
    || !Number.isSafeInteger(value.desiredGid) || value.desiredGid < 1
    || typeof value.currentTarget !== 'string' || releaseIdFromTarget(value.currentTarget) === null
    || typeof value.treeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.treeSha256)
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_RELEASE_PREVIEW_ENTRIES) {
    throw new StaticPublishIsolationError('static_publish_release_receipt_invalid', 'Static release migration receipt is invalid');
  }
  const entries = value.entries.map(normalizeReleaseReceiptEntry);
  if (new Set(entries.map((entry) => entry.relativePath)).size !== entries.length
    || releaseSnapshotDigest(entries) !== value.treeSha256
    || entries.reduce((total, entry) => total + Buffer.byteLength(entry.acl, 'utf8'), 0) > MAX_RELEASE_RECEIPT_ACL_BYTES) {
    throw new StaticPublishIsolationError('static_publish_release_receipt_invalid', 'Static release migration receipt topology is invalid');
  }
  return Object.freeze({
    version: RELEASE_MIGRATION_RECEIPT_VERSION,
    operationId,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    specDigest: value.specDigest,
    desiredUid: value.desiredUid,
    desiredGid: value.desiredGid,
    currentTarget: value.currentTarget,
    treeSha256: value.treeSha256,
    entries: Object.freeze(entries),
    state: value.state,
  });
}

function normalizeOperationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new StaticPublishIsolationError('static_publish_migration_operation_invalid', 'Static publish migration operation id is invalid');
  }
  return value.toLowerCase();
}

function migrationSpecDigest(spec) {
  return sha256(JSON.stringify({
    version: 1,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    publishRoot: spec.publishRoot,
    releasesRoot: spec.releasesRoot,
    currentPath: spec.currentPath,
  }));
}

function receiptMetadata(value, { symlink = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || (!symlink && (!Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777))) {
    throw new StaticPublishIsolationError('static_publish_migration_receipt_invalid', 'Static publish migration receipt metadata is invalid');
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
    || value.specDigest !== migrationSpecDigest(spec)
    || !MIGRATION_RECEIPT_STATES.has(value.state)
    || typeof value.currentTarget !== 'string' || releaseIdFromTarget(value.currentTarget) === null
    || !value.previous || typeof value.previous !== 'object' || Array.isArray(value.previous)) {
    throw new StaticPublishIsolationError('static_publish_migration_receipt_invalid', 'Static publish migration receipt is invalid');
  }
  return Object.freeze({
    version: MIGRATION_RECEIPT_VERSION,
    operationId,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    specDigest: value.specDigest,
    currentTarget: value.currentTarget,
    previous: Object.freeze({
      publishRoot: receiptMetadata(value.previous.publishRoot),
      releasesRoot: receiptMetadata(value.previous.releasesRoot),
      current: receiptMetadata(value.previous.current, { symlink: true }),
    }),
    state: value.state,
  });
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function aclHas(output, entry) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).includes(entry);
}

function releaseIdFromTarget(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

export function createStaticPublishIsolationManager({
  migrationReceiptRoot = MIGRATION_RECEIPT_ROOT,
  releaseMigrationReceiptRoot = RELEASE_MIGRATION_RECEIPT_ROOT,
  identityManager = createWebsiteIdentityPathManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: 1024 * 1024,
    env: options.env,
  }),
  accessFn = access,
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  openFn = open,
  readFileFn = readFile,
  readdirFn = readdir,
  readlinkFn = readlink,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (!identityManager || typeof identityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof accessFn !== 'function'
    || typeof chmodFn !== 'function' || typeof chownFn !== 'function'
    || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function' || typeof openFn !== 'function'
    || typeof readFileFn !== 'function' || typeof readdirFn !== 'function' || typeof readlinkFn !== 'function' || typeof renameFn !== 'function'
    || typeof rmFn !== 'function' || typeof writeFileFn !== 'function') {
    throw new StaticPublishIsolationError('static_publish_isolation_dependencies_invalid', 'Static publish isolation dependencies are invalid');
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
      throw new StaticPublishIsolationError('static_publish_migration_receipt_unavailable', 'Static publish migration receipt could not be read');
    }
    try { return normalizeMigrationReceipt(JSON.parse(raw), { operationId, spec }); }
    catch (error) {
      if (error instanceof StaticPublishIsolationError) throw error;
      throw new StaticPublishIsolationError('static_publish_migration_receipt_invalid', 'Static publish migration receipt is invalid');
    }
  }

  async function persistMigrationReceipt(operationId, spec, value) {
    await mkdirFn(migrationReceiptRoot, { recursive: true, mode: 0o700 });
    const receipt = {
      version: MIGRATION_RECEIPT_VERSION,
      operationId,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      specDigest: migrationSpecDigest(spec),
      currentTarget: value.currentTarget,
      previous: value.previous,
      state: value.state,
    };
    await atomicWrite(migrationReceiptPath(operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return normalizeMigrationReceipt(receipt, { operationId, spec });
  }

  function releaseMigrationReceiptPath(operationId) {
    return path.posix.join(releaseMigrationReceiptRoot, `${operationId}.json`);
  }

  async function loadReleaseMigrationReceipt(operationId, spec) {
    let raw;
    try { raw = await readFileFn(releaseMigrationReceiptPath(operationId), 'utf8'); }
    catch (error) {
      if (missing(error)) return null;
      throw new StaticPublishIsolationError('static_publish_release_receipt_unavailable', 'Static release migration receipt could not be read');
    }
    try { return normalizeReleaseMigrationReceipt(JSON.parse(raw), { operationId, spec }); }
    catch (error) {
      if (error instanceof StaticPublishIsolationError) throw error;
      throw new StaticPublishIsolationError('static_publish_release_receipt_invalid', 'Static release migration receipt is invalid');
    }
  }

  async function persistReleaseMigrationReceipt(operationId, spec, value) {
    await mkdirFn(releaseMigrationReceiptRoot, { recursive: true, mode: 0o700 });
    const receipt = {
      version: RELEASE_MIGRATION_RECEIPT_VERSION,
      operationId,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      specDigest: migrationSpecDigest(spec),
      desiredUid: value.desiredUid,
      desiredGid: value.desiredGid,
      currentTarget: value.currentTarget,
      treeSha256: value.treeSha256,
      entries: value.entries,
      state: value.state,
    };
    await atomicWrite(releaseMigrationReceiptPath(operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return normalizeReleaseMigrationReceipt(receipt, { operationId, spec });
  }

  async function inspectIdentity(spec) {
    const result = await identityManager.inspect({
      user: spec.identity.unixUser,
      homeDirectory: spec.identity.paths.workspace.homeDirectory,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
    });
    if (!result?.satisfied) return result;
    if (result.user !== spec.identity.unixUser || !Number.isSafeInteger(result.uid) || !Number.isSafeInteger(result.gid)) {
      throw new StaticPublishIsolationError('static_publish_identity_drift', 'Static publish Website identity has drifted');
    }
    return result;
  }

  async function aclToolsAvailable() {
    try {
      await Promise.all([accessFn(SETFACL_PATH), accessFn(GETFACL_PATH)]);
      return true;
    } catch { return false; }
  }

  async function ensureAclTools() {
    if (await aclToolsAvailable()) return;
    try {
      await run(APT_GET_PATH, ['install', '--yes', '--no-install-recommends', ACL_PACKAGE], {
        timeout: 10 * 60_000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new StaticPublishIsolationError('static_publish_acl_package_install_failed', 'POSIX ACL package could not be installed for static isolation');
    }
    if (!(await aclToolsAvailable())) {
      throw new StaticPublishIsolationError('static_publish_acl_package_unverified', 'POSIX ACL tooling could not be verified after installation');
    }
  }

  async function getAcl(target) {
    try { return String((await run(GETFACL_PATH, ['--absolute-names', '--omit-header', target], { timeout: 10_000 }))?.stdout ?? ''); }
    catch { throw new StaticPublishIsolationError('static_publish_acl_inspection_failed', 'Static publish ACL could not be inspected'); }
  }

  async function assertControlDirectory(target) {
    let info;
    try { info = await lstatFn(target); }
    catch (error) {
      if (missing(error)) return Object.freeze({ satisfied: false, reason: 'static_publish_container_missing', target });
      throw new StaticPublishIsolationError('static_publish_path_inspection_failed', 'Static publish container could not be inspected');
    }
    if (!info?.isDirectory?.() || info.isSymbolicLink?.() || info.uid !== 0 || info.gid !== 0 || modeOf(info) !== 0o711) {
      throw new StaticPublishIsolationError('static_publish_container_drift', 'Static publish control-plane container ownership or mode has drifted');
    }
    return Object.freeze({ satisfied: true });
  }

  async function releaseDirectories(spec) {
    let entries;
    try { entries = await readdirFn(spec.releasesRoot, { withFileTypes: true }); }
    catch (error) {
      if (missing(error)) return [];
      throw new StaticPublishIsolationError('static_publish_release_list_failed', 'Static publish releases could not be listed');
    }
    const releases = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) {
        throw new StaticPublishIsolationError('static_publish_release_entry_drift', 'Static publish releases contain an unmanaged entry');
      }
      releases.push(path.posix.join(spec.releasesRoot, entry.name.toLowerCase()));
    }
    return releases.sort();
  }

  async function walk(target, visitor) {
    const info = await lstatFn(target);
    if (info.isSymbolicLink?.()) throw new StaticPublishIsolationError('static_publish_symlink_drift', 'Static publish release contains a symbolic link');
    if (info.isFile?.()) {
      await visitor(target, info, 'file');
      return;
    }
    if (!info.isDirectory?.()) throw new StaticPublishIsolationError('static_publish_entry_drift', 'Static publish release contains an unsupported filesystem entry');
    await visitor(target, info, 'directory');
    const entries = await readdirFn(target, { withFileTypes: true });
    for (const entry of entries) await walk(path.posix.join(target, entry.name), visitor);
  }

  async function inspectRelease(target, identity) {
    await walk(target, async (entryPath, info, type) => {
      const expectedMode = type === 'directory' ? 0o750 : 0o640;
      if (info.uid !== identity.uid || info.gid !== identity.gid || modeOf(info) !== expectedMode) {
        throw new StaticPublishIsolationError('static_publish_release_drift', 'Static publish release ownership or mode has drifted');
      }
      const acl = await getAcl(entryPath);
      const expectedAcl = type === 'directory' ? 'user:www-data:r-x' : 'user:www-data:r--';
      if (!aclHas(acl, expectedAcl)) {
        throw new StaticPublishIsolationError('static_publish_acl_drift', 'Static publish Nginx ACL has drifted');
      }
    });
  }

  async function collectReleaseRepairSnapshot(spec, identity) {
    const releases = await releaseDirectories(spec);
    if (releases.length < 1) {
      return Object.freeze({ releases: Object.freeze([]), entries: Object.freeze([]) });
    }
    const entries = [];
    let aclBytes = 0;
    for (const release of releases) {
      await walk(release, async (entryPath, info, type) => {
        if (entries.length >= MAX_RELEASE_PREVIEW_ENTRIES) {
          throw new StaticPublishIsolationError(
            'static_publish_release_preview_too_large',
            'Static publish release tree exceeds the bounded migration preview limit',
          );
        }
        const relativePath = relativeReleasePath(path.posix.relative(spec.releasesRoot, entryPath));
        const rawAcl = await getAcl(entryPath);
        const acl = canonicalAcl(rawAcl);
        aclBytes += Buffer.byteLength(acl, 'utf8');
        if (aclBytes > MAX_RELEASE_RECEIPT_ACL_BYTES) {
          throw new StaticPublishIsolationError(
            'static_publish_release_preview_too_large',
            'Static publish release ACL snapshot exceeds the bounded migration preview limit',
          );
        }
        if (!Number.isSafeInteger(info.dev) || info.dev < 0 || !Number.isSafeInteger(info.ino) || info.ino < 0) {
          throw new StaticPublishIsolationError(
            'static_publish_release_identity_unavailable',
            'Static publish release inode identity could not be verified',
          );
        }
        entries.push(Object.freeze({
          relativePath,
          type,
          uid: info.uid,
          gid: info.gid,
          mode: modeOf(info),
          dev: info.dev,
          ino: info.ino,
          acl,
          desiredAcl: desiredReleaseAcl(acl, type),
        }));
      });
    }
    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return Object.freeze({
      releases: Object.freeze(releases.map((release) => path.posix.basename(release))),
      entries: Object.freeze(entries),
    });
  }

  async function releaseTreeSummary(spec, identity) {
    const snapshot = await collectReleaseRepairSnapshot(spec, identity);
    if (snapshot.entries.length < 1) {
      return Object.freeze({
        releases: snapshot.releases,
        tree: null,
        differences: Object.freeze(['static_publish_release_missing']),
      });
    }
    let ownershipModeDriftCount = 0;
    let aclDriftCount = 0;
    for (const entry of snapshot.entries) {
      const expectedMode = entry.type === 'directory' ? 0o750 : 0o640;
      const expectedAcl = entry.type === 'directory' ? 'user:www-data:r-x' : 'user:www-data:r--';
      if (entry.uid !== identity.uid || entry.gid !== identity.gid || entry.mode !== expectedMode) {
        ownershipModeDriftCount += 1;
      }
      if (!aclHas(entry.acl, expectedAcl)) aclDriftCount += 1;
    }
    return Object.freeze({
      releases: snapshot.releases,
      tree: Object.freeze({
        sha256: releaseSnapshotDigest(snapshot.entries),
        entryCount: snapshot.entries.length,
        ownershipModeDriftCount,
        aclDriftCount,
      }),
      differences: Object.freeze([
        ...(ownershipModeDriftCount > 0 ? ['static_publish_release_drift'] : []),
        ...(aclDriftCount > 0 ? ['static_publish_acl_drift'] : []),
      ]),
    });
  }

  async function previewReleaseMigration(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    let identity;
    try {
      const value = await inspectIdentity(spec);
      identity = value?.satisfied === true
        ? Object.freeze({
          satisfied: true,
          uid: value.uid,
          gid: value.gid,
          homeDirectory: value.homeDirectory,
        })
        : Object.freeze({
          satisfied: false,
          reason: value?.reason ?? 'static_publish_identity_unavailable',
        });
    } catch (error) {
      identity = Object.freeze({
        satisfied: false,
        reason: typeof error?.code === 'string' ? error.code : 'static_publish_identity_inspection_failed',
      });
    }

    const aclAvailable = await aclToolsAvailable();
    let releaseRootError = null;
    try {
      const [publishInfo, releasesInfo] = await Promise.all([
        lstatFn(spec.publishRoot),
        lstatFn(spec.releasesRoot),
      ]);
      if (!publishInfo?.isDirectory?.() || publishInfo.isSymbolicLink?.()
        || !releasesInfo?.isDirectory?.() || releasesInfo.isSymbolicLink?.()) {
        releaseRootError = 'static_publish_release_root_drift';
      }
    } catch (error) {
      releaseRootError = missing(error)
        ? 'static_publish_release_root_missing'
        : 'static_publish_release_root_unavailable';
    }

    let currentTarget = null;
    let currentTargetError = null;
    try {
      const info = await lstatFn(spec.currentPath);
      if (!info?.isSymbolicLink?.()) {
        currentTargetError = 'static_publish_current_invalid';
      } else {
        currentTarget = await readlinkFn(spec.currentPath);
      }
    } catch (error) {
      currentTargetError = missing(error)
        ? 'static_publish_current_missing'
        : 'static_publish_current_inspection_failed';
    }

    let summary = Object.freeze({
      releases: Object.freeze([]),
      tree: null,
      differences: Object.freeze([]),
    });
    let summaryError = null;
    if (identity.satisfied && aclAvailable && releaseRootError === null) {
      try { summary = await releaseTreeSummary(spec, identity); }
      catch (error) {
        summaryError = typeof error?.code === 'string'
          ? error.code
          : 'static_publish_release_preview_failed';
      }
    }

    const currentReleaseId = currentTarget === null ? null : releaseIdFromTarget(currentTarget);
    const currentTargetManaged = currentReleaseId !== null && summary.releases.includes(currentReleaseId);
    const differences = [
      ...(identity.satisfied ? [] : [identity.reason]),
      ...(aclAvailable ? [] : ['static_publish_acl_package_missing']),
      ...(releaseRootError ? [releaseRootError] : []),
      ...(summaryError ? [summaryError] : summary.differences),
      ...(currentTargetError ? [currentTargetError] : []),
      ...(!currentTargetError && !currentTargetManaged ? ['static_publish_current_drift'] : []),
    ];
    const uniqueDifferences = [...new Set(differences)];
    const satisfied = uniqueDifferences.length === 0;
    const repairCandidate = identity.satisfied === true
      && aclAvailable === true
      && releaseRootError === null
      && summaryError === null
      && summary.tree !== null
      && summary.tree.entryCount > 0
      && currentTargetManaged
      && (summary.tree.ownershipModeDriftCount > 0 || summary.tree.aclDriftCount > 0)
      && uniqueDifferences.every((code) => (
        code === 'static_publish_release_drift' || code === 'static_publish_acl_drift'
      ));

    return Object.freeze({
      version: 1,
      adapter: 'static-release-permissions',
      satisfied,
      automaticMigration: false,
      repairCandidate,
      migrationBlockedReason: 'static_release_explicit_migration_required',
      current: Object.freeze({
        identity,
        aclToolsAvailable: aclAvailable,
        releaseRootError,
        currentTarget,
        currentTargetError,
        releases: summary.releases,
        tree: summary.tree,
      }),
      desired: Object.freeze({
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
        unixUser: spec.identity.unixUser,
        releasesRoot: spec.releasesRoot,
        releaseDirectoryMode: '0750',
        releaseFileMode: '0640',
        nginxDirectoryAcl: 'user:www-data:r-x',
        nginxFileAcl: 'user:www-data:r--',
      }),
      differences: Object.freeze(uniqueDifferences),
    });
  }

  function desiredReleaseMode(type) {
    return type === 'directory' ? 0o750 : 0o640;
  }

  async function releaseMigrationState(spec) {
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_identity_required',
        'Static release migration requires the canonical Website identity',
      );
    }
    if (!(await aclToolsAvailable())) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_acl_unavailable',
        'Static release migration requires existing POSIX ACL tooling',
      );
    }

    let publishInfo;
    let releasesInfo;
    let currentInfo;
    try {
      [publishInfo, releasesInfo, currentInfo] = await Promise.all([
        lstatFn(spec.publishRoot),
        lstatFn(spec.releasesRoot),
        lstatFn(spec.currentPath),
      ]);
    } catch (error) {
      if (missing(error)) {
        throw new StaticPublishIsolationError(
          'static_publish_release_migration_path_missing',
          'Static release migration requires the existing managed publish tree',
        );
      }
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_path_unavailable',
        'Static release migration paths could not be inspected',
      );
    }
    if (!publishInfo?.isDirectory?.() || publishInfo.isSymbolicLink?.()
      || !releasesInfo?.isDirectory?.() || releasesInfo.isSymbolicLink?.()
      || !currentInfo?.isSymbolicLink?.()) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_path_type_drift',
        'Static release migration path types are not canonical',
      );
    }

    const snapshot = await collectReleaseRepairSnapshot(spec, identity);
    if (snapshot.entries.length < 1) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_release_missing',
        'Static release migration requires at least one managed release',
      );
    }
    let currentTarget;
    try { currentTarget = await readlinkFn(spec.currentPath); }
    catch {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_current_unavailable',
        'Static release migration current target could not be read',
      );
    }
    const currentReleaseId = releaseIdFromTarget(currentTarget);
    if (!currentReleaseId || !snapshot.releases.includes(currentReleaseId)) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_current_drift',
        'Static release migration current target is not a managed release',
      );
    }
    return Object.freeze({ identity, snapshot, currentTarget });
  }

  function releaseEntryState(current, previous, receipt) {
    if (current.relativePath !== previous.relativePath
      || current.type !== previous.type
      || current.dev !== previous.dev
      || current.ino !== previous.ino) return null;
    const desiredMode = desiredReleaseMode(previous.type);
    const previousMatch = current.uid === previous.uid
      && current.gid === previous.gid
      && current.mode === previous.mode
      && current.acl === previous.acl;
    if (previousMatch) return 'previous';

    const afterChown = current.uid === receipt.desiredUid
      && current.gid === receipt.desiredGid
      && current.mode === previous.mode
      && current.acl === previous.acl;
    if (afterChown) return 'after_chown';

    const afterChmod = current.uid === receipt.desiredUid
      && current.gid === receipt.desiredGid
      && current.mode === desiredMode
      && current.acl === modeAdjustedReleaseAcl(previous.acl, previous.type);
    if (afterChmod) return 'after_chmod';

    const desired = current.uid === receipt.desiredUid
      && current.gid === receipt.desiredGid
      && current.mode === desiredMode
      && current.acl === previous.desiredAcl;
    if (desired) return 'desired';
    return null;
  }

  function releaseSnapshotStates(state, receipt) {
    if (state.currentTarget !== receipt.currentTarget
      || state.snapshot.entries.length !== receipt.entries.length) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_drift',
        'Static release topology changed after the migration receipt checkpoint',
      );
    }
    const states = [];
    for (let index = 0; index < receipt.entries.length; index += 1) {
      const current = state.snapshot.entries[index];
      const previous = receipt.entries[index];
      const entryState = releaseEntryState(current, previous, receipt);
      if (!entryState) {
        throw new StaticPublishIsolationError(
          'static_publish_release_migration_drift',
          'Static release entry changed outside the migration-owned state transition',
        );
      }
      states.push(entryState);
    }
    return Object.freeze(states);
  }

  async function setReleaseAcl(target, acl, operationId, index) {
    await mkdirFn(releaseMigrationReceiptRoot, { recursive: true, mode: 0o700 });
    const aclPath = path.posix.join(releaseMigrationReceiptRoot, `${operationId}.${index}.acl`);
    try {
      await atomicWrite(aclPath, acl, 0o600);
      await run(SETFACL_PATH, [`--set-file=${aclPath}`, target], { timeout: 10_000 });
    } catch {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_acl_apply_failed',
        'Static release ACL could not be applied',
      );
    } finally {
      await rmFn(aclPath, { force: true }).catch(() => {});
    }
  }

  async function mutateReleaseEntry(spec, receipt, previous, currentState, targetState, index) {
    const target = path.posix.join(spec.releasesRoot, previous.relativePath);
    const desired = targetState === 'desired'
      ? Object.freeze({
        uid: receipt.desiredUid,
        gid: receipt.desiredGid,
        mode: desiredReleaseMode(previous.type),
        acl: previous.desiredAcl,
      })
      : Object.freeze({
        uid: previous.uid,
        gid: previous.gid,
        mode: previous.mode,
        acl: previous.acl,
      });

    let handle;
    try {
      handle = await openFn(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC);
      const info = await handle.stat();
      const expectedType = previous.type === 'directory' ? info?.isDirectory?.() : info?.isFile?.();
      if (!expectedType || info.dev !== previous.dev || info.ino !== previous.ino) {
        throw new StaticPublishIsolationError(
          'static_publish_release_migration_drift',
          'Static release inode changed after the migration receipt checkpoint',
        );
      }
      const fdPath = `/proc/${process.pid}/fd/${handle.fd}`;
      const currentAcl = canonicalAcl(await getAcl(fdPath));
      const current = Object.freeze({
        relativePath: previous.relativePath,
        type: previous.type,
        uid: info.uid,
        gid: info.gid,
        mode: modeOf(info),
        dev: info.dev,
        ino: info.ino,
        acl: currentAcl,
      });
      if (releaseEntryState(current, previous, receipt) !== currentState) {
        throw new StaticPublishIsolationError(
          'static_publish_release_migration_drift',
          'Static release entry changed before its migration mutation',
        );
      }

      await handle.chown(desired.uid, desired.gid);
      await handle.chmod(desired.mode);
      await setReleaseAcl(fdPath, desired.acl, receipt.operationId, index);
    } catch (error) {
      if (error instanceof StaticPublishIsolationError) throw error;
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_apply_failed',
        'Static release metadata could not be changed safely',
      );
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function inspectReleaseMigrationOperation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadReleaseMigrationReceipt(operationId, spec);
    if (!receipt) {
      return Object.freeze({ satisfied: false, reason: 'static_publish_release_receipt_missing' });
    }
    if (receipt.state === 'compensated') {
      return Object.freeze({ satisfied: false, reason: 'static_publish_release_migration_compensated' });
    }
    const state = await releaseMigrationState(spec);
    const states = releaseSnapshotStates(state, receipt);
    if (!states.every((entryState) => entryState === 'desired')) {
      return Object.freeze({
        satisfied: false,
        reason: 'static_publish_release_migration_incomplete',
      });
    }
    if (receipt.state !== 'active') {
      receipt = await persistReleaseMigrationReceipt(operationId, spec, { ...receipt, state: 'active' });
    }
    return Object.freeze({
      satisfied: true,
      staticReleaseReceiptVersion: RELEASE_MIGRATION_RECEIPT_VERSION,
      migratedStaticReleasePermissions: true,
      treeSha256: receipt.treeSha256,
      receiptState: receipt.state,
    });
  }

  async function applyReleaseMigration(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadReleaseMigrationReceipt(operationId, spec);
    if (receipt?.state === 'compensated') {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_compensated',
        'Compensated static release migration cannot be re-applied',
      );
    }

    if (!receipt) {
      const preview = await previewReleaseMigration(rawIntent);
      if (preview.satisfied === true) {
        throw new StaticPublishIsolationError(
          'static_publish_release_migration_not_operation_owned',
          'Canonical static release state is not owned by this migration operation',
        );
      }
      if (preview.repairCandidate !== true || !preview.current.tree) {
        throw new StaticPublishIsolationError(
          'static_publish_release_migration_not_safe',
          'Static release migration requires a bounded managed release drift preview',
        );
      }
      const state = await releaseMigrationState(spec);
      if (releaseSnapshotDigest(state.snapshot.entries) !== preview.current.tree.sha256
        || state.currentTarget !== preview.current.currentTarget) {
        throw new StaticPublishIsolationError(
          'static_publish_release_migration_preview_stale',
          'Static release state changed before the durable receipt checkpoint',
        );
      }
      receipt = await persistReleaseMigrationReceipt(operationId, spec, {
        desiredUid: state.identity.uid,
        desiredGid: state.identity.gid,
        currentTarget: state.currentTarget,
        treeSha256: preview.current.tree.sha256,
        entries: state.snapshot.entries,
        state: 'prepared',
      });
    }

    const before = await releaseMigrationState(spec);
    const states = releaseSnapshotStates(before, receipt);
    for (let index = 0; index < receipt.entries.length; index += 1) {
      if (states[index] === 'desired') continue;
      await mutateReleaseEntry(spec, receipt, receipt.entries[index], states[index], 'desired', index);
    }

    const verified = await inspectReleaseMigrationOperation(rawIntent, { operationId });
    if (!verified.satisfied) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_unverified',
        'Static release migration could not be verified',
      );
    }
    return verified;
  }

  async function inspectReleaseMigrationCompensation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReleaseMigrationReceipt(operationId, spec);
    if (!receipt) {
      return Object.freeze({ satisfied: false, reason: 'static_publish_release_receipt_missing' });
    }
    const state = await releaseMigrationState(spec);
    const states = releaseSnapshotStates(state, receipt);
    const restored = states.every((entryState) => entryState === 'previous');
    return Object.freeze({
      satisfied: restored,
      restoredStaticReleasePermissions: restored,
      treeSha256: receipt.treeSha256,
      receiptState: receipt.state,
      ...(restored ? {} : { reason: 'static_publish_release_migration_compensation_pending' }),
    });
  }

  async function compensateReleaseMigration(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadReleaseMigrationReceipt(operationId, spec);
    if (!receipt) {
      throw new StaticPublishIsolationError(
        'static_publish_release_receipt_missing',
        'Static release migration receipt is required for rollback',
      );
    }
    if (receipt.state === 'compensated') {
      return inspectReleaseMigrationCompensation(rawIntent, { operationId });
    }

    const before = await releaseMigrationState(spec);
    const states = releaseSnapshotStates(before, receipt);
    for (let index = 0; index < receipt.entries.length; index += 1) {
      if (states[index] === 'previous') continue;
      await mutateReleaseEntry(spec, receipt, receipt.entries[index], states[index], 'previous', index);
    }

    let after = await inspectReleaseMigrationCompensation(rawIntent, { operationId });
    if (!after.satisfied) {
      throw new StaticPublishIsolationError(
        'static_publish_release_migration_compensation_unverified',
        'Static release migration rollback could not be verified',
      );
    }
    receipt = await persistReleaseMigrationReceipt(operationId, spec, { ...receipt, state: 'compensated' });
    after = await inspectReleaseMigrationCompensation(rawIntent, { operationId });
    return Object.freeze({ ...after, receiptState: receipt.state });
  }

  async function previewMigration(rawIntent) {
    const spec = normalizeIntent(rawIntent);

    let identity;
    try {
      const value = await inspectIdentity(spec);
      identity = value?.satisfied === true
        ? Object.freeze({
          satisfied: true,
          uid: value.uid,
          gid: value.gid,
          homeDirectory: value.homeDirectory,
        })
        : Object.freeze({
          satisfied: false,
          reason: value?.reason ?? 'static_publish_identity_unavailable',
        });
    } catch (error) {
      identity = Object.freeze({
        satisfied: false,
        reason: typeof error?.code === 'string' ? error.code : 'static_publish_identity_inspection_failed',
      });
    }

    async function controlState(target) {
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
        throw new StaticPublishIsolationError('static_publish_path_inspection_failed', 'Static publish path could not be inspected');
      }
    }

    const [aclAvailable, publishRootState, releasesRootState] = await Promise.all([
      aclToolsAvailable(),
      controlState(spec.publishRoot),
      controlState(spec.releasesRoot),
    ]);

    let releases = [];
    let releaseListError = null;
    try { releases = await releaseDirectories(spec); }
    catch (error) {
      releaseListError = typeof error?.code === 'string' ? error.code : 'static_publish_release_list_failed';
    }

    const releaseStates = [];
    if (!releaseListError) {
      for (const releasePath of releases) {
        const releaseId = path.posix.basename(releasePath);
        let satisfied = false;
        let reason = null;
        if (!identity.satisfied) {
          reason = identity.reason;
        } else if (!aclAvailable) {
          reason = 'static_publish_acl_package_missing';
        } else {
          try {
            await inspectRelease(releasePath, identity);
            satisfied = true;
          } catch (error) {
            reason = typeof error?.code === 'string' ? error.code : 'static_publish_release_inspection_failed';
          }
        }
        releaseStates.push(Object.freeze({
          releaseId,
          satisfied,
          reason,
        }));
      }
    }

    let current = Object.freeze({ present: false });
    try {
      const [target, info] = await Promise.all([readlinkFn(spec.currentPath), lstatFn(spec.currentPath)]);
      current = Object.freeze({
        present: true,
        symbolicLink: Boolean(info?.isSymbolicLink?.()),
        uid: Number.isSafeInteger(info?.uid) ? info.uid : null,
        gid: Number.isSafeInteger(info?.gid) ? info.gid : null,
        target: typeof target === 'string' ? target : null,
      });
    } catch (error) {
      if (!missing(error)) {
        current = Object.freeze({
          present: false,
          error: error?.code === 'EINVAL'
            ? 'static_publish_current_invalid'
            : 'static_publish_current_inspection_failed',
        });
      }
    }

    const differences = [];
    if (!identity.satisfied) differences.push(identity.reason);
    if (!aclAvailable) differences.push('static_publish_acl_package_missing');
    for (const [state, code] of [
      [publishRootState, 'static_publish_container_drift'],
      [releasesRootState, 'static_publish_container_drift'],
    ]) {
      if (!state.present) differences.push('static_publish_container_missing');
      else if (!state.directory || state.symbolicLink || state.uid !== 0 || state.gid !== 0 || state.mode !== '0711') {
        differences.push(code);
      }
    }
    if (releaseListError) differences.push(releaseListError);
    else if (releaseStates.length < 1) differences.push('static_publish_release_missing');
    for (const state of releaseStates) {
      if (!state.satisfied && state.reason) differences.push(state.reason);
    }
    if (!current.present) {
      differences.push(current.error ?? 'static_publish_current_missing');
    } else {
      const releaseId = releaseIdFromTarget(current.target);
      if (!current.symbolicLink || current.uid !== 0 || current.gid !== 0 || !releaseId) {
        differences.push('static_publish_current_drift');
      } else if (!releaseStates.some((entry) => entry.releaseId === releaseId)) {
        differences.push('static_publish_current_drift');
      }
    }

    const currentReleaseId = current.present && current.symbolicLink
      ? releaseIdFromTarget(current.target)
      : null;
    const uniqueDifferences = [...new Set(differences)];
    const safeMigrationCandidate = uniqueDifferences.length > 0
      && identity.satisfied === true
      && aclAvailable === true
      && publishRootState.present === true
      && publishRootState.directory === true
      && publishRootState.symbolicLink === false
      && releasesRootState.present === true
      && releasesRootState.directory === true
      && releasesRootState.symbolicLink === false
      && releaseListError === null
      && releaseStates.length > 0
      && releaseStates.every((entry) => entry.satisfied === true)
      && current.present === true
      && current.symbolicLink === true
      && currentReleaseId !== null
      && releaseStates.some((entry) => entry.releaseId === currentReleaseId)
      && uniqueDifferences.every((code) => (
        code === 'static_publish_container_drift' || code === 'static_publish_current_drift'
      ));

    return Object.freeze({
      version: 1,
      adapter: 'static-publish-isolation',
      satisfied: differences.length === 0,
      safeMigrationCandidate,
      current: Object.freeze({
        identity,
        aclToolsAvailable: aclAvailable,
        publishRoot: publishRootState,
        releasesRoot: releasesRootState,
        releases: Object.freeze(releaseStates),
        current,
      }),
      desired: Object.freeze({
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
        unixUser: spec.identity.unixUser,
        homeDirectory: spec.identity.paths.workspace.homeDirectory,
        publishRoot: spec.publishRoot,
        releasesRoot: spec.releasesRoot,
        currentPath: spec.currentPath,
        controlDirectoryMode: '0711',
        releaseDirectoryMode: '0750',
        releaseFileMode: '0640',
        nginxDirectoryAcl: 'user:www-data:r-x',
        nginxFileAcl: 'user:www-data:r--',
        aclPackage: ACL_PACKAGE,
      }),
      differences: Object.freeze(uniqueDifferences),
    });
  }

  async function inspect(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) return Object.freeze({ satisfied: false, reason: identity?.reason ?? 'static_publish_identity_unavailable' });
    if (!(await aclToolsAvailable())) return Object.freeze({ satisfied: false, reason: 'static_publish_acl_package_missing' });
    for (const target of [spec.publishRoot, spec.releasesRoot]) {
      const result = await assertControlDirectory(target);
      if (!result.satisfied) return result;
    }
    const releases = await releaseDirectories(spec);
    if (releases.length < 1) return Object.freeze({ satisfied: false, reason: 'static_publish_release_missing' });
    for (const release of releases) await inspectRelease(release, identity);

    let currentTarget;
    let currentInfo;
    try {
      [currentTarget, currentInfo] = await Promise.all([readlinkFn(spec.currentPath), lstatFn(spec.currentPath)]);
    } catch (error) {
      if (missing(error)) return Object.freeze({ satisfied: false, reason: 'static_publish_current_missing' });
      throw new StaticPublishIsolationError('static_publish_current_inspection_failed', 'Static publish current release could not be inspected');
    }
    if (!currentInfo?.isSymbolicLink?.() || currentInfo.uid !== 0 || currentInfo.gid !== 0
      || typeof currentTarget !== 'string' || !/^releases\/[0-9a-f-]{36}$/i.test(currentTarget)) {
      throw new StaticPublishIsolationError('static_publish_current_drift', 'Static publish current symlink has drifted');
    }
    const currentAbsolute = path.posix.join(spec.publishRoot, currentTarget);
    if (!releases.includes(currentAbsolute)) {
      throw new StaticPublishIsolationError('static_publish_current_drift', 'Static publish current symlink targets an unmanaged release');
    }

    return Object.freeze({
      satisfied: true,
      adapter: 'static-publish-isolation',
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      unixUser: spec.identity.unixUser,
      releaseCount: releases.length,
      currentRelease: currentAbsolute,
    });
  }

  async function migrationSnapshot(spec) {
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) {
      throw new StaticPublishIsolationError('static_publish_migration_identity_required', 'Static publish migration requires the canonical Website identity');
    }
    if (!(await aclToolsAvailable())) {
      throw new StaticPublishIsolationError('static_publish_migration_acl_unavailable', 'Static publish migration requires existing POSIX ACL tooling');
    }

    let publishInfo;
    let releasesInfo;
    let currentInfo;
    try {
      [publishInfo, releasesInfo, currentInfo] = await Promise.all([
        lstatFn(spec.publishRoot),
        lstatFn(spec.releasesRoot),
        lstatFn(spec.currentPath),
      ]);
    } catch (error) {
      if (missing(error)) {
        throw new StaticPublishIsolationError('static_publish_migration_path_missing', 'Static publish migration requires the existing publish tree');
      }
      throw new StaticPublishIsolationError('static_publish_migration_path_unavailable', 'Static publish migration paths could not be inspected');
    }
    if (!publishInfo?.isDirectory?.() || publishInfo.isSymbolicLink?.()
      || !releasesInfo?.isDirectory?.() || releasesInfo.isSymbolicLink?.()
      || !currentInfo?.isSymbolicLink?.()) {
      throw new StaticPublishIsolationError('static_publish_migration_path_type_drift', 'Static publish migration path types changed after preview');
    }

    const releases = await releaseDirectories(spec);
    if (releases.length < 1) {
      throw new StaticPublishIsolationError('static_publish_migration_release_missing', 'Static publish migration requires at least one managed release');
    }
    for (const release of releases) await inspectRelease(release, identity);

    let currentTarget;
    try { currentTarget = await readlinkFn(spec.currentPath); }
    catch {
      throw new StaticPublishIsolationError('static_publish_migration_current_unavailable', 'Static publish migration current release could not be read');
    }
    const releaseId = releaseIdFromTarget(currentTarget);
    const currentAbsolute = releaseId ? path.posix.join(spec.releasesRoot, releaseId) : null;
    if (!releaseId || !currentAbsolute || !releases.includes(currentAbsolute)) {
      throw new StaticPublishIsolationError('static_publish_migration_current_drift', 'Static publish migration current release target is unmanaged');
    }

    return Object.freeze({
      publishRoot: Object.freeze({ uid: publishInfo.uid, gid: publishInfo.gid, mode: modeOf(publishInfo) }),
      releasesRoot: Object.freeze({ uid: releasesInfo.uid, gid: releasesInfo.gid, mode: modeOf(releasesInfo) }),
      current: Object.freeze({ uid: currentInfo.uid, gid: currentInfo.gid }),
      currentTarget,
    });
  }

  function metadataMatches(current, expected, { symlink = false } = {}) {
    return current.uid === expected.uid && current.gid === expected.gid && (symlink || current.mode === expected.mode);
  }

  function desiredMigrationMetadata() {
    return Object.freeze({
      publishRoot: Object.freeze({ uid: 0, gid: 0, mode: 0o711 }),
      releasesRoot: Object.freeze({ uid: 0, gid: 0, mode: 0o711 }),
      current: Object.freeze({ uid: 0, gid: 0 }),
    });
  }

  function assertReceiptCompatibleSnapshot(snapshot, receipt) {
    if (snapshot.currentTarget !== receipt.currentTarget) {
      throw new StaticPublishIsolationError('static_publish_migration_current_drift', 'Static publish current release changed after the migration receipt checkpoint');
    }
    const desired = desiredMigrationMetadata();
    for (const name of ['publishRoot', 'releasesRoot']) {
      if (!metadataMatches(snapshot[name], receipt.previous[name]) && !metadataMatches(snapshot[name], desired[name])) {
        throw new StaticPublishIsolationError('static_publish_migration_drift', 'Static publish control metadata changed after the migration receipt checkpoint');
      }
    }
    if (!metadataMatches(snapshot.current, receipt.previous.current, { symlink: true })
      && !metadataMatches(snapshot.current, desired.current, { symlink: true })) {
      throw new StaticPublishIsolationError('static_publish_migration_drift', 'Static publish current symlink ownership changed after the migration receipt checkpoint');
    }
  }

  async function inspectMigrationOperation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadMigrationReceipt(operationId, spec);
    if (!receipt) return Object.freeze({ satisfied: false, reason: 'static_publish_migration_receipt_missing' });
    if (receipt.state === 'compensated') {
      return Object.freeze({ satisfied: false, reason: 'static_publish_migration_compensated' });
    }

    const snapshot = await migrationSnapshot(spec);
    assertReceiptCompatibleSnapshot(snapshot, receipt);
    const desired = desiredMigrationMetadata();
    const satisfied = metadataMatches(snapshot.publishRoot, desired.publishRoot)
      && metadataMatches(snapshot.releasesRoot, desired.releasesRoot)
      && metadataMatches(snapshot.current, desired.current, { symlink: true });
    if (!satisfied) {
      return Object.freeze({ satisfied: false, reason: 'static_publish_migration_incomplete' });
    }
    if (receipt.state !== 'active') {
      receipt = await persistMigrationReceipt(operationId, spec, { ...receipt, state: 'active' });
    }
    return Object.freeze({
      satisfied: true,
      staticControlReceiptVersion: MIGRATION_RECEIPT_VERSION,
      migratedStaticControlMetadata: true,
      receiptState: receipt.state,
    });
  }

  async function applyMigration(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadMigrationReceipt(operationId, spec);
    if (receipt?.state === 'compensated') {
      throw new StaticPublishIsolationError('static_publish_migration_compensated', 'Compensated static publish migration cannot be re-applied');
    }
    if (!receipt) {
      const preview = await previewMigration(rawIntent);
      if (preview.satisfied === true) {
        throw new StaticPublishIsolationError('static_publish_migration_not_operation_owned', 'Canonical static control metadata is not owned by this migration operation');
      }
      if (preview.safeMigrationCandidate !== true) {
        throw new StaticPublishIsolationError('static_publish_migration_not_safe', 'Static publish migration is limited to exact non-recursive control-plane metadata repair');
      }
      receipt = await persistMigrationReceipt(operationId, spec, {
        currentTarget: preview.current.current.target,
        previous: {
          publishRoot: {
            uid: preview.current.publishRoot.uid,
            gid: preview.current.publishRoot.gid,
            mode: Number.parseInt(preview.current.publishRoot.mode, 8),
          },
          releasesRoot: {
            uid: preview.current.releasesRoot.uid,
            gid: preview.current.releasesRoot.gid,
            mode: Number.parseInt(preview.current.releasesRoot.mode, 8),
          },
          current: {
            uid: preview.current.current.uid,
            gid: preview.current.current.gid,
          },
        },
        state: 'prepared',
      });
    }

    const snapshot = await migrationSnapshot(spec);
    assertReceiptCompatibleSnapshot(snapshot, receipt);
    const desired = desiredMigrationMetadata();
    try {
      if (snapshot.publishRoot.uid !== desired.publishRoot.uid || snapshot.publishRoot.gid !== desired.publishRoot.gid) {
        await run(CHOWN_PATH, ['root:root', spec.publishRoot], { timeout: 10_000 });
      }
      if (snapshot.publishRoot.mode !== desired.publishRoot.mode) await chmodFn(spec.publishRoot, 0o711);
      if (snapshot.releasesRoot.uid !== desired.releasesRoot.uid || snapshot.releasesRoot.gid !== desired.releasesRoot.gid) {
        await run(CHOWN_PATH, ['root:root', spec.releasesRoot], { timeout: 10_000 });
      }
      if (snapshot.releasesRoot.mode !== desired.releasesRoot.mode) await chmodFn(spec.releasesRoot, 0o711);
      if (!metadataMatches(snapshot.current, desired.current, { symlink: true })) {
        await run(CHOWN_PATH, ['-h', 'root:root', spec.currentPath], { timeout: 10_000 });
      }
    } catch {
      throw new StaticPublishIsolationError('static_publish_migration_apply_failed', 'Static publish control metadata could not be applied');
    }

    const verified = await inspectMigrationOperation(rawIntent, { operationId });
    if (!verified.satisfied) {
      throw new StaticPublishIsolationError('static_publish_migration_unverified', 'Static publish control metadata could not be verified');
    }
    return verified;
  }

  async function inspectMigrationCompensation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadMigrationReceipt(operationId, spec);
    if (!receipt) return Object.freeze({ satisfied: false, reason: 'static_publish_migration_receipt_missing' });

    const snapshot = await migrationSnapshot(spec);
    if (snapshot.currentTarget !== receipt.currentTarget) {
      return Object.freeze({ satisfied: false, reason: 'static_publish_migration_compensation_drift' });
    }
    const desired = desiredMigrationMetadata();
    for (const name of ['publishRoot', 'releasesRoot']) {
      if (!metadataMatches(snapshot[name], receipt.previous[name]) && !metadataMatches(snapshot[name], desired[name])) {
        return Object.freeze({ satisfied: false, reason: 'static_publish_migration_compensation_drift' });
      }
    }
    if (!metadataMatches(snapshot.current, receipt.previous.current, { symlink: true })
      && !metadataMatches(snapshot.current, desired.current, { symlink: true })) {
      return Object.freeze({ satisfied: false, reason: 'static_publish_migration_compensation_drift' });
    }
    const restored = metadataMatches(snapshot.publishRoot, receipt.previous.publishRoot)
      && metadataMatches(snapshot.releasesRoot, receipt.previous.releasesRoot)
      && metadataMatches(snapshot.current, receipt.previous.current, { symlink: true });
    return Object.freeze({
      satisfied: restored,
      restoredStaticControlMetadata: restored,
      receiptState: receipt.state,
      ...(restored ? {} : { reason: 'static_publish_migration_compensation_pending' }),
    });
  }

  async function compensateMigration(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadMigrationReceipt(operationId, spec);
    if (!receipt) {
      throw new StaticPublishIsolationError('static_publish_migration_receipt_missing', 'Static publish migration receipt is required for rollback');
    }
    if (receipt.state === 'compensated') return inspectMigrationCompensation(rawIntent, { operationId });

    const before = await inspectMigrationCompensation(rawIntent, { operationId });
    if (before.reason === 'static_publish_migration_compensation_drift') {
      throw new StaticPublishIsolationError('static_publish_migration_compensation_drift', 'Static publish metadata changed after migration and cannot be safely restored');
    }
    if (!before.satisfied) {
      const snapshot = await migrationSnapshot(spec);
      const desired = desiredMigrationMetadata();
      try {
        if (!metadataMatches(snapshot.current, receipt.previous.current, { symlink: true })) {
          if (!metadataMatches(snapshot.current, desired.current, { symlink: true })) {
            throw new StaticPublishIsolationError('static_publish_migration_compensation_drift', 'Static current symlink ownership changed after migration');
          }
          await run(CHOWN_PATH, ['-h', `${receipt.previous.current.uid}:${receipt.previous.current.gid}`, spec.currentPath], { timeout: 10_000 });
        }
        for (const [name, target] of [
          ['releasesRoot', spec.releasesRoot],
          ['publishRoot', spec.publishRoot],
        ]) {
          if (!metadataMatches(snapshot[name], receipt.previous[name])) {
            if (!metadataMatches(snapshot[name], desired[name])) {
              throw new StaticPublishIsolationError('static_publish_migration_compensation_drift', 'Static publish control metadata changed after migration');
            }
            await run(CHOWN_PATH, [`${receipt.previous[name].uid}:${receipt.previous[name].gid}`, target], { timeout: 10_000 });
            await chmodFn(target, receipt.previous[name].mode);
          }
        }
      } catch (error) {
        if (error instanceof StaticPublishIsolationError) throw error;
        throw new StaticPublishIsolationError('static_publish_migration_compensation_failed', 'Static publish control metadata could not be restored');
      }
    }

    let after = await inspectMigrationCompensation(rawIntent, { operationId });
    if (!after.satisfied) {
      throw new StaticPublishIsolationError('static_publish_migration_compensation_unverified', 'Static publish migration rollback could not be verified');
    }
    receipt = await persistMigrationReceipt(operationId, spec, { ...receipt, state: 'compensated' });
    after = await inspectMigrationCompensation(rawIntent, { operationId });
    return Object.freeze({ ...after, receiptState: receipt.state });
  }

  async function secureRelease(target, identity) {
    await walk(target, async (entryPath, _info, type) => {
      await chownFn(entryPath, identity.uid, identity.gid);
      await chmodFn(entryPath, type === 'directory' ? 0o750 : 0o640);
    });
    try { await run(SETFACL_PATH, ['-R', '-m', 'u:www-data:r-X', target], { timeout: 60_000 }); }
    catch { throw new StaticPublishIsolationError('static_publish_acl_apply_failed', 'Static publish Nginx ACL could not be applied'); }
  }

  async function apply(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) {
      throw new StaticPublishIsolationError('static_publish_identity_required', 'Website Unix identity must be ready before static publish isolation');
    }
    await ensureAclTools();
    for (const target of [spec.publishRoot, spec.releasesRoot]) {
      let info;
      try { info = await lstatFn(target); }
      catch (error) {
        if (missing(error)) throw new StaticPublishIsolationError('static_publish_container_missing', 'Static publish container must exist before isolation');
        throw error;
      }
      if (!info?.isDirectory?.() || info.isSymbolicLink?.()) {
        throw new StaticPublishIsolationError('static_publish_container_drift', 'Static publish container is invalid');
      }
      if (info.uid !== 0 || info.gid !== 0) {
        try { await run(CHOWN_PATH, ['root:root', target], { timeout: 10_000 }); }
        catch { throw new StaticPublishIsolationError('static_publish_container_ownership_failed', 'Static publish container ownership could not be secured'); }
      }
      await chmodFn(target, 0o711);
    }
    const releases = await releaseDirectories(spec);
    if (releases.length < 1) throw new StaticPublishIsolationError('static_publish_release_missing', 'Static publish release must exist before isolation');
    for (const release of releases) await secureRelease(release, identity);
    try { await run(CHOWN_PATH, ['-h', 'root:root', spec.currentPath], { timeout: 10_000 }); }
    catch { throw new StaticPublishIsolationError('static_publish_current_ownership_failed', 'Static publish current symlink ownership could not be secured'); }

    const verified = await inspect(rawIntent);
    if (!verified.satisfied) throw new StaticPublishIsolationError('static_publish_isolation_unverified', 'Static publish isolation could not be verified');
    return verified;
  }

  return Object.freeze({
    inspect,
    previewMigration,
    previewReleaseMigration,
    inspectReleaseMigrationOperation,
    applyReleaseMigration,
    inspectReleaseMigrationCompensation,
    compensateReleaseMigration,
    inspectMigrationOperation,
    applyMigration,
    inspectMigrationCompensation,
    compensateMigration,
    apply,
  });
}

export const staticPublishIsolationInternals = Object.freeze({
  normalizeIntent,
  aclHas,
  releaseIdFromTarget,
  modeOf,
  migrationSpecDigest,
  normalizeMigrationReceipt,
  canonicalAcl,
  modeAdjustedReleaseAcl,
  desiredReleaseAcl,
  releaseSnapshotDigest,
  normalizeReleaseMigrationReceipt,
  aclPackage: ACL_PACKAGE,
  migrationReceiptVersion: MIGRATION_RECEIPT_VERSION,
  maxReleasePreviewEntries: MAX_RELEASE_PREVIEW_ENTRIES,
  maxReleaseReceiptAclBytes: MAX_RELEASE_RECEIPT_ACL_BYTES,
  paths: Object.freeze({ MIGRATION_RECEIPT_ROOT, RELEASE_MIGRATION_RECEIPT_ROOT }),
});
