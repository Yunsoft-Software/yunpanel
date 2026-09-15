import { execFile } from 'node:child_process';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApplicationIdentity } from './application-identity.js';
import { createWebsiteIdentityPathManager } from './website-identity-path-manager.js';

const execFileAsync = promisify(execFile);
const CHOWN_PATH = '/usr/bin/chown';
const CHMOD_PATH = '/usr/bin/chmod';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  identityManager = createWebsiteIdentityPathManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: 128 * 1024,
  }),
  lstatFn = lstat,
  readlinkFn = readlink,
} = {}) {
  if (!identityManager || typeof identityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function' || typeof readlinkFn !== 'function') {
    throw new PhpSiteContainerManagerError('php_site_container_dependencies_invalid', 'PHP Website container dependencies are invalid');
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

  return Object.freeze({ inspect, apply });
}

export const phpSiteContainerManagerInternals = Object.freeze({
  normalizeIntent,
  modeOf,
  paths: Object.freeze({ CHOWN_PATH, CHMOD_PATH }),
});
