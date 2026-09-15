import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApplicationIdentity } from './application-identity.js';
import { createWebsiteIdentityPathManager } from './website-identity-path-manager.js';

const execFileAsync = promisify(execFile);
const DPKG_QUERY_PATH = '/usr/bin/dpkg-query';
const APT_GET_PATH = '/usr/bin/apt-get';
const INSTALL_PATH = '/usr/bin/install';
const CHOWN_PATH = '/usr/bin/chown';
const CHMOD_PATH = '/usr/bin/chmod';
const SETFACL_PATH = '/usr/bin/setfacl';
const GETFACL_PATH = '/usr/bin/getfacl';
const ACL_PACKAGE = 'acl';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/php-sites';
const RECEIPT_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOTSTRAP_INDEX = `<?php\ndeclare(strict_types=1);\n?><!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YunPanel</title></head>\n<body><h1>Website ready</h1></body>\n</html>\n`;

export class PhpSiteBootstrapManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpSiteBootstrapManagerError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PhpSiteBootstrapManagerError('php_site_identity_invalid', `${field} is invalid`);
  }
  return value.toLowerCase();
}

function normalizeIntent(value, operationId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['websiteId', 'applicationId', 'unixUser', 'documentRoot'].includes(key))) {
    throw new PhpSiteBootstrapManagerError('php_site_intent_invalid', 'PHP Website bootstrap intent is invalid');
  }
  const websiteId = uuid(value.websiteId, 'websiteId');
  const normalizedOperationId = uuid(operationId, 'operationId');
  let identity;
  try { identity = createApplicationIdentity(value.applicationId); }
  catch { throw new PhpSiteBootstrapManagerError('php_site_application_invalid', 'PHP Website Application identity is invalid'); }
  if (value.unixUser !== identity.unixUser) {
    throw new PhpSiteBootstrapManagerError('php_site_identity_mismatch', 'PHP Website Unix identity does not match the Application');
  }
  const expectedDocumentRoot = path.posix.join(identity.paths.runtime.currentRelease, 'public');
  if (value.documentRoot !== expectedDocumentRoot) {
    throw new PhpSiteBootstrapManagerError('php_site_document_root_invalid', 'PHP Website document root must use the canonical current/public path');
  }
  const releaseDirectory = path.posix.join(identity.paths.runtime.releasesDirectory, normalizedOperationId);
  return Object.freeze({
    websiteId,
    operationId: normalizedOperationId,
    applicationId: identity.applicationId,
    unixUser: identity.unixUser,
    identity,
    applicationRoot: identity.paths.runtime.applicationRoot,
    releasesDirectory: identity.paths.runtime.releasesDirectory,
    releaseDirectory,
    releaseDocumentRoot: path.posix.join(releaseDirectory, 'public'),
    currentRelease: identity.paths.runtime.currentRelease,
    documentRoot: expectedDocumentRoot,
    indexPath: path.posix.join(releaseDirectory, 'public', 'index.php'),
  });
}

function aclHas(output, entry) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).includes(entry);
}

function directChildren(entries) {
  return [...entries].sort((left, right) => left.localeCompare(right));
}

function receiptCore(spec, state) {
  return {
    version: RECEIPT_VERSION,
    operationId: spec.operationId,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    unixUser: spec.unixUser,
    releaseDirectory: spec.releaseDirectory,
    currentRelease: spec.currentRelease,
    indexSha256: sha256(BOOTSTRAP_INDEX),
    state,
  };
}

function normalizeReceipt(value, spec) {
  const expected = receiptCore(spec, value?.state);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['prepared', 'active', 'compensated'].includes(value.state)
    || Object.keys(expected).some((key) => value[key] !== expected[key])) {
    throw new PhpSiteBootstrapManagerError('php_site_receipt_invalid', 'PHP Website bootstrap receipt is invalid');
  }
  return Object.freeze({ ...expected });
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function packageMissing(error) {
  return Number.isInteger(error?.code) && error.code === 1;
}

export function createPhpSiteBootstrapManager({
  receiptRoot = RECEIPT_ROOT,
  identityManager = createWebsiteIdentityPathManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: 512 * 1024,
    env: options.env,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  readdirFn = readdir,
  readlinkFn = readlink,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
  writeFileFn = writeFile,
} = {}) {
  if (!identityManager || typeof identityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function' || typeof readdirFn !== 'function'
    || typeof readlinkFn !== 'function' || typeof renameFn !== 'function' || typeof rmFn !== 'function'
    || typeof symlinkFn !== 'function' || typeof writeFileFn !== 'function') {
    throw new PhpSiteBootstrapManagerError('php_site_dependencies_invalid', 'PHP Website bootstrap dependencies are invalid');
  }

  function receiptPath(operationId) {
    return path.posix.join(receiptRoot, `${operationId}.json`);
  }

  async function atomicWrite(target, content, mode = 0o600) {
    const temporary = `${target}.${process.pid}.tmp`;
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, content, { encoding: 'utf8', mode });
      await renameFn(temporary, target);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function loadReceipt(spec) {
    let raw;
    try { raw = await readFileFn(receiptPath(spec.operationId), 'utf8'); }
    catch (error) {
      if (missing(error)) return null;
      throw new PhpSiteBootstrapManagerError('php_site_receipt_unavailable', 'PHP Website bootstrap receipt could not be read');
    }
    try { return normalizeReceipt(JSON.parse(raw), spec); }
    catch (error) {
      if (error instanceof PhpSiteBootstrapManagerError) throw error;
      throw new PhpSiteBootstrapManagerError('php_site_receipt_invalid', 'PHP Website bootstrap receipt is invalid');
    }
  }

  async function persistReceipt(spec, state) {
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    const receipt = receiptCore(spec, state);
    await atomicWrite(receiptPath(spec.operationId), `${JSON.stringify(receipt)}\n`);
    return normalizeReceipt(receipt, spec);
  }

  async function inspectIdentity(spec) {
    const result = await identityManager.inspect({
      user: spec.unixUser,
      homeDirectory: spec.identity.paths.workspace.homeDirectory,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
    });
    if (!result?.satisfied) return result;
    if (result.user !== spec.unixUser || result.homeDirectory !== spec.identity.paths.workspace.homeDirectory
      || !Number.isSafeInteger(result.uid) || result.uid < 1 || !Number.isSafeInteger(result.gid) || result.gid < 1) {
      throw new PhpSiteBootstrapManagerError('php_site_identity_drift', 'PHP Website identity does not match canonical managed state');
    }
    return result;
  }

  async function inspectAclPackage() {
    try {
      const result = await run(DPKG_QUERY_PATH, ['-W', '-f=${Status}\t${Version}', ACL_PACKAGE], { timeout: 10_000 });
      const match = String(result?.stdout ?? '').trim().match(/^install ok installed\t([^\s]+)$/);
      return Object.freeze({ installed: Boolean(match), version: match?.[1] ?? null });
    } catch (error) {
      if (packageMissing(error)) return Object.freeze({ installed: false, version: null });
      throw new PhpSiteBootstrapManagerError('php_site_acl_package_inspection_failed', 'POSIX ACL package state could not be inspected');
    }
  }

  async function ensureAclPackage() {
    const before = await inspectAclPackage();
    if (before.installed) return before;
    try {
      await run(APT_GET_PATH, ['install', '--yes', '--no-install-recommends', ACL_PACKAGE], {
        timeout: 10 * 60_000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new PhpSiteBootstrapManagerError('php_site_acl_package_install_failed', 'POSIX ACL package could not be installed');
    }
    const after = await inspectAclPackage();
    if (!after.installed) {
      throw new PhpSiteBootstrapManagerError('php_site_acl_package_unverified', 'POSIX ACL package installation could not be verified');
    }
    return after;
  }

  async function statRequired(target, type, identity, expectedMode) {
    let info;
    try { info = await lstatFn(target); }
    catch (error) {
      if (missing(error)) return Object.freeze({ satisfied: false, reason: 'missing', target });
      throw new PhpSiteBootstrapManagerError('php_site_path_inspection_failed', 'PHP Website path could not be inspected');
    }
    const typeOk = type === 'directory' ? info?.isDirectory?.()
      : type === 'file' ? info?.isFile?.()
        : type === 'symlink' ? info?.isSymbolicLink?.() : false;
    if (!typeOk || info.uid !== identity.uid || info.gid !== identity.gid || (type !== 'symlink' && modeOf(info) !== expectedMode)) {
      throw new PhpSiteBootstrapManagerError('php_site_path_drift', 'PHP Website path ownership, type or mode has drifted');
    }
    return Object.freeze({ satisfied: true, info });
  }

  async function inspectAcl(target, requiredEntries) {
    let output;
    try { output = (await run(GETFACL_PATH, ['--absolute-names', '--omit-header', target], { timeout: 10_000 }))?.stdout ?? ''; }
    catch { throw new PhpSiteBootstrapManagerError('php_site_acl_inspection_failed', 'PHP Website ACL could not be inspected'); }
    if (requiredEntries.some((entry) => !aclHas(output, entry))) {
      throw new PhpSiteBootstrapManagerError('php_site_acl_drift', 'PHP Website Nginx ACL has drifted');
    }
  }

  async function inspect(rawIntent, { operationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) {
      return Object.freeze({ satisfied: false, reason: identity?.reason ?? 'php_site_identity_unavailable' });
    }
    const receipt = await loadReceipt(spec);
    if (!receipt || receipt.state === 'compensated') {
      return Object.freeze({ satisfied: false, reason: 'php_site_bootstrap_not_active' });
    }

    const packageState = await inspectAclPackage();
    if (!packageState.installed) return Object.freeze({ satisfied: false, reason: 'php_site_acl_package_missing' });

    for (const target of [spec.applicationRoot, spec.releasesDirectory, spec.releaseDirectory, spec.releaseDocumentRoot]) {
      const result = await statRequired(target, 'directory', identity, 0o750);
      if (!result.satisfied) return Object.freeze({ satisfied: false, reason: 'php_site_path_missing', target });
    }
    const index = await statRequired(spec.indexPath, 'file', identity, 0o640);
    if (!index.satisfied) return Object.freeze({ satisfied: false, reason: 'php_site_index_missing' });
    const link = await statRequired(spec.currentRelease, 'symlink', identity, null);
    if (!link.satisfied) return Object.freeze({ satisfied: false, reason: 'php_site_current_missing' });
    let linkTarget;
    try { linkTarget = await readlinkFn(spec.currentRelease); }
    catch { throw new PhpSiteBootstrapManagerError('php_site_current_unavailable', 'PHP Website current release could not be read'); }
    if (linkTarget !== spec.releaseDirectory) {
      throw new PhpSiteBootstrapManagerError('php_site_current_drift', 'PHP Website current release target has drifted');
    }
    const indexContent = await readFileFn(spec.indexPath, 'utf8');
    if (sha256(indexContent) !== sha256(BOOTSTRAP_INDEX)) {
      throw new PhpSiteBootstrapManagerError('php_site_bootstrap_content_drift', 'PHP Website bootstrap content has changed');
    }

    await inspectAcl(spec.applicationRoot, ['user:www-data:--x']);
    await inspectAcl(spec.releasesDirectory, ['user:www-data:--x']);
    await inspectAcl(spec.releaseDirectory, ['user:www-data:--x']);
    await inspectAcl(spec.releaseDocumentRoot, ['user:www-data:r-x', 'default:user:www-data:r-x']);
    await inspectAcl(spec.indexPath, ['user:www-data:r--']);

    return Object.freeze({
      satisfied: true,
      adapter: 'php-bootstrap',
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      unixUser: spec.unixUser,
      unixUid: identity.uid,
      unixGid: identity.gid,
      releaseId: spec.operationId,
      releaseDirectory: spec.releaseDirectory,
      currentRelease: spec.currentRelease,
      documentRoot: spec.documentRoot,
      aclPackageVersion: packageState.version,
      indexSha256: sha256(BOOTSTRAP_INDEX),
    });
  }

  async function prepareDirectory(target, identity) {
    try {
      await run(INSTALL_PATH, ['-d', '-o', identity.user, '-g', identity.user, '-m', '0750', target], { timeout: 10_000 });
    } catch { throw new PhpSiteBootstrapManagerError('php_site_directory_prepare_failed', 'PHP Website release directory could not be prepared'); }
  }

  async function setOwnerAndMode(target, identity, mode) {
    try {
      await run(CHOWN_PATH, [`${identity.user}:${identity.user}`, target], { timeout: 10_000 });
      await run(CHMOD_PATH, [mode, target], { timeout: 10_000 });
    } catch { throw new PhpSiteBootstrapManagerError('php_site_file_prepare_failed', 'PHP Website bootstrap file ownership could not be prepared'); }
  }

  async function applyAcl(spec) {
    const entries = [
      [spec.applicationRoot, 'u:www-data:--x'],
      [spec.releasesDirectory, 'u:www-data:--x'],
      [spec.releaseDirectory, 'u:www-data:--x'],
      [spec.releaseDocumentRoot, 'u:www-data:r-x,d:u:www-data:r-x'],
      [spec.indexPath, 'u:www-data:r--'],
    ];
    for (const [target, acl] of entries) {
      try { await run(SETFACL_PATH, ['-m', acl, target], { timeout: 10_000 }); }
      catch { throw new PhpSiteBootstrapManagerError('php_site_acl_apply_failed', 'PHP Website Nginx ACL could not be applied'); }
    }
  }

  async function anyManagedPathExists(spec) {
    for (const target of [spec.applicationRoot, spec.releasesDirectory, spec.releaseDirectory, spec.currentRelease]) {
      try { await lstatFn(target); return true; }
      catch (error) {
        if (!missing(error)) throw new PhpSiteBootstrapManagerError('php_site_path_inspection_failed', 'PHP Website bootstrap state could not be inspected');
      }
    }
    return false;
  }

  async function apply(rawIntent, { operationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) {
      throw new PhpSiteBootstrapManagerError('php_site_identity_required', 'Website Unix identity must be ready before PHP bootstrap');
    }
    let receipt = await loadReceipt(spec);
    if (receipt?.state === 'compensated') {
      throw new PhpSiteBootstrapManagerError('php_site_operation_compensated', 'Compensated PHP Website bootstrap cannot be re-applied');
    }
    if (receipt?.state === 'active') {
      const existing = await inspect(rawIntent, { operationId });
      if (existing.satisfied) return existing;
    }
    if (!receipt) {
      if (await anyManagedPathExists(spec)) {
        throw new PhpSiteBootstrapManagerError('php_site_bootstrap_conflict', 'Existing PHP Website runtime paths are not owned by this operation');
      }
      receipt = await persistReceipt(spec, 'prepared');
    }

    await ensureAclPackage();
    for (const target of [spec.applicationRoot, spec.releasesDirectory, spec.releaseDirectory, spec.releaseDocumentRoot]) {
      await prepareDirectory(target, identity);
    }

    let indexExists = false;
    try {
      const current = await readFileFn(spec.indexPath, 'utf8');
      indexExists = true;
      if (sha256(current) !== sha256(BOOTSTRAP_INDEX)) {
        throw new PhpSiteBootstrapManagerError('php_site_bootstrap_content_drift', 'PHP Website bootstrap content conflicts with operation state');
      }
    } catch (error) {
      if (error instanceof PhpSiteBootstrapManagerError) throw error;
      if (!missing(error)) throw new PhpSiteBootstrapManagerError('php_site_index_unavailable', 'PHP Website bootstrap file could not be read');
    }
    if (!indexExists) {
      await writeFileFn(spec.indexPath, BOOTSTRAP_INDEX, { encoding: 'utf8', mode: 0o640, flag: 'wx' });
      await setOwnerAndMode(spec.indexPath, identity, '0640');
    }

    try {
      const currentTarget = await readlinkFn(spec.currentRelease);
      if (currentTarget !== spec.releaseDirectory) {
        throw new PhpSiteBootstrapManagerError('php_site_current_drift', 'PHP Website current release conflicts with operation state');
      }
    } catch (error) {
      if (error instanceof PhpSiteBootstrapManagerError) throw error;
      if (!missing(error)) throw new PhpSiteBootstrapManagerError('php_site_current_unavailable', 'PHP Website current release could not be inspected');
      await symlinkFn(spec.releaseDirectory, spec.currentRelease);
      try { await run(CHOWN_PATH, ['-h', `${identity.user}:${identity.user}`, spec.currentRelease], { timeout: 10_000 }); }
      catch { throw new PhpSiteBootstrapManagerError('php_site_current_prepare_failed', 'PHP Website current release ownership could not be prepared'); }
    }

    await applyAcl(spec);
    receipt = await persistReceipt(spec, 'active');
    const verified = await inspect(rawIntent, { operationId });
    if (!verified.satisfied) {
      throw new PhpSiteBootstrapManagerError('php_site_bootstrap_unverified', 'PHP Website bootstrap could not be verified');
    }
    return Object.freeze({ ...verified, receiptState: receipt.state });
  }

  async function exactBootstrapTree(spec) {
    let appEntries;
    let releaseEntries;
    let publicEntries;
    try {
      appEntries = directChildren(await readdirFn(spec.applicationRoot));
      releaseEntries = directChildren(await readdirFn(spec.releaseDirectory));
      publicEntries = directChildren(await readdirFn(spec.releaseDocumentRoot));
    } catch (error) {
      if (missing(error)) return false;
      throw new PhpSiteBootstrapManagerError('php_site_compensation_inspection_failed', 'PHP Website bootstrap tree could not be inspected');
    }
    if (JSON.stringify(appEntries) !== JSON.stringify(['current', 'releases'])
      || JSON.stringify(releaseEntries) !== JSON.stringify(['public'])
      || JSON.stringify(publicEntries) !== JSON.stringify(['index.php'])) return false;
    const releases = directChildren(await readdirFn(spec.releasesDirectory));
    if (JSON.stringify(releases) !== JSON.stringify([spec.operationId])) return false;
    const content = await readFileFn(spec.indexPath, 'utf8');
    if (sha256(content) !== sha256(BOOTSTRAP_INDEX)) return false;
    try { return (await readlinkFn(spec.currentRelease)) === spec.releaseDirectory; }
    catch { return false; }
  }

  async function inspectCompensation(rawIntent, { operationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    const receipt = await loadReceipt(spec);
    if (!receipt) return Object.freeze({ satisfied: true, reason: 'php_site_receipt_absent' });
    if (receipt.state === 'compensated') return Object.freeze({ satisfied: true, removed: true });
    let exists;
    try { await lstatFn(spec.applicationRoot); exists = true; }
    catch (error) {
      if (!missing(error)) throw new PhpSiteBootstrapManagerError('php_site_compensation_inspection_failed', 'PHP Website bootstrap state could not be inspected');
      exists = false;
    }
    if (!exists) return Object.freeze({ satisfied: true, removed: true });
    if (!(await exactBootstrapTree(spec))) {
      return Object.freeze({ satisfied: false, reason: 'php_site_compensation_drift' });
    }
    return Object.freeze({ satisfied: false, reason: 'php_site_compensation_pending' });
  }

  async function compensate(rawIntent, { operationId } = {}) {
    const spec = normalizeIntent(rawIntent, operationId);
    let receipt = await loadReceipt(spec);
    if (!receipt) return Object.freeze({ satisfied: true, reason: 'php_site_receipt_absent' });
    if (receipt.state === 'compensated') return Object.freeze({ satisfied: true, removed: true });
    const before = await inspectCompensation(rawIntent, { operationId });
    if (before.satisfied) {
      receipt = await persistReceipt(spec, 'compensated');
      return Object.freeze({ ...before, receiptState: receipt.state });
    }
    if (before.reason === 'php_site_compensation_drift') {
      throw new PhpSiteBootstrapManagerError('php_site_compensation_drift', 'PHP Website bootstrap contains user changes and cannot be removed safely');
    }
    await rmFn(spec.currentRelease, { force: true });
    await rmFn(spec.releaseDirectory, { recursive: true, force: true });
    await rmFn(spec.releasesDirectory, { recursive: false, force: true });
    await rmFn(spec.applicationRoot, { recursive: false, force: true });
    receipt = await persistReceipt(spec, 'compensated');
    const after = await inspectCompensation(rawIntent, { operationId });
    if (!after.satisfied) {
      throw new PhpSiteBootstrapManagerError('php_site_compensation_unverified', 'PHP Website bootstrap compensation could not be verified');
    }
    return Object.freeze({ ...after, receiptState: receipt.state });
  }

  return Object.freeze({ inspect, apply, inspectCompensation, compensate });
}

export const phpSiteBootstrapManagerInternals = Object.freeze({
  normalizeIntent,
  aclHas,
  directChildren,
  receiptCore,
  normalizeReceipt,
  bootstrapIndex: BOOTSTRAP_INDEX,
  bootstrapIndexSha256: sha256(BOOTSTRAP_INDEX),
  paths: Object.freeze({
    DPKG_QUERY_PATH,
    APT_GET_PATH,
    INSTALL_PATH,
    CHOWN_PATH,
    CHMOD_PATH,
    SETFACL_PATH,
    GETFACL_PATH,
    RECEIPT_ROOT,
  }),
  aclPackage: ACL_PACKAGE,
});
