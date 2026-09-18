import { execFile } from 'node:child_process';
import { access, chmod, chown, lstat, readdir, readlink } from 'node:fs/promises';
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

function missing(error) {
  return error?.code === 'ENOENT';
}

function aclHas(output, entry) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).includes(entry);
}

export function createStaticPublishIsolationManager({
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
  readdirFn = readdir,
  readlinkFn = readlink,
} = {}) {
  if (!identityManager || typeof identityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof accessFn !== 'function'
    || typeof chmodFn !== 'function' || typeof chownFn !== 'function'
    || typeof lstatFn !== 'function' || typeof readdirFn !== 'function' || typeof readlinkFn !== 'function') {
    throw new StaticPublishIsolationError('static_publish_isolation_dependencies_invalid', 'Static publish isolation dependencies are invalid');
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
          error: typeof error?.code === 'string' ? error.code : 'static_publish_current_inspection_failed',
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

    return Object.freeze({
      version: 1,
      adapter: 'static-publish-isolation',
      satisfied: differences.length === 0,
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
      differences: Object.freeze([...new Set(differences)]),
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

  return Object.freeze({ inspect, previewMigration, apply });
}

export const staticPublishIsolationInternals = Object.freeze({
  normalizeIntent,
  aclHas,
  modeOf,
  aclPackage: ACL_PACKAGE,
});
