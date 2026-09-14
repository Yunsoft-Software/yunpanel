import { execFile } from 'node:child_process';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertUuid, normalizeStaticApplicationSpec } from '@yunpanel/shared';
import { createApplicationIdentity } from './application-identity.js';
import { createStaticDeploymentManager } from './static-deployment-manager.js';
import { createStaticRollbackManager } from './static-rollback-manager.js';

const execFileAsync = promisify(execFile);
const GETENT_PATH = '/usr/bin/getent';
const USERADD_PATH = '/usr/sbin/useradd';
const RUNUSER_PATH = '/usr/sbin/runuser';
const NOLOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WebsiteStaticDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteStaticDeploymentError';
    this.code = code;
  }
}

function parsePasswd(stdout, expectedUser) {
  const fields = String(stdout ?? '').trim().split(':');
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (fields.length !== 7 || fields[0] !== expectedUser
    || !Number.isSafeInteger(uid) || uid < 1
    || !Number.isSafeInteger(gid) || gid < 1) {
    throw new WebsiteStaticDeploymentError('website_static_identity_invalid', 'Website static Unix identity inspection returned invalid data');
  }
  return Object.freeze({ user: fields[0], uid, gid, homeDirectory: fields[5], shell: fields[6] });
}

function parseGroup(stdout, expectedGroup) {
  const fields = String(stdout ?? '').trim().split(':');
  const gid = Number.parseInt(fields[2], 10);
  if (fields.length !== 4 || fields[0] !== expectedGroup || !Number.isSafeInteger(gid) || gid < 1) {
    throw new WebsiteStaticDeploymentError('website_static_identity_invalid', 'Website static Unix group inspection returned invalid data');
  }
  const members = fields[3] ? fields[3].split(',').filter(Boolean) : [];
  return Object.freeze({ group: fields[0], gid, members: Object.freeze(members) });
}

function missingGetent(error) {
  return Number.isInteger(error?.code) && error.code === 2;
}

function releaseIdFromTarget(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

function missingPath(error) {
  return error?.code === 'ENOENT';
}

function normalizeCompensationTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteStaticDeploymentError('website_static_compensation_invalid', 'Website static compensation target is invalid');
  }
  let applicationId;
  let deploymentId;
  let previousReleaseId;
  try {
    applicationId = assertUuid(value.applicationId, 'applicationId');
    deploymentId = assertUuid(value.deploymentId, 'deploymentId');
    previousReleaseId = value.previousReleaseId == null
      ? null
      : assertUuid(value.previousReleaseId, 'previousReleaseId');
  } catch {
    throw new WebsiteStaticDeploymentError('website_static_compensation_invalid', 'Website static compensation target is invalid');
  }
  if (previousReleaseId === deploymentId) {
    throw new WebsiteStaticDeploymentError('website_static_compensation_invalid', 'Previous static release cannot equal the operation-owned release');
  }
  return Object.freeze({ applicationId, deploymentId, previousReleaseId });
}

export function createWebsiteStaticDeploymentManager({
  buildRoot = '/var/lib/yunpanel/build',
  webRoot = '/var/www/yunpanel/apps',
  dataRoot = '/var/lib/yunpanel/data',
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
  lstatFn = lstat,
  readlinkFn = readlink,
  createDeploymentManager = createStaticDeploymentManager,
  rollbackManager = null,
  recordLog = null,
} = {}) {
  if (typeof run !== 'function' || typeof lstatFn !== 'function' || typeof readlinkFn !== 'function'
    || typeof createDeploymentManager !== 'function'
    || (recordLog !== null && typeof recordLog !== 'function')) {
    throw new WebsiteStaticDeploymentError('website_static_dependencies_invalid', 'Website static deployment dependencies are invalid');
  }
  const resolvedRollbackManager = rollbackManager ?? createStaticRollbackManager({ webRoot, lstatFn, readlinkFn });
  if (!resolvedRollbackManager || typeof resolvedRollbackManager.rollbackStatic !== 'function') {
    throw new WebsiteStaticDeploymentError('website_static_dependencies_invalid', 'Website static rollback dependency is invalid');
  }

  const deploymentLocks = new Map();

  async function inspectIdentity(identity) {
    let passwdResult;
    try { passwdResult = await run(GETENT_PATH, ['passwd', identity.unixUser], { timeout: 5_000 }); }
    catch (error) {
      if (missingGetent(error)) {
        throw new WebsiteStaticDeploymentError('website_static_identity_missing', 'Website static Unix identity must be provisioned before deployment');
      }
      throw new WebsiteStaticDeploymentError('website_static_identity_inspection_failed', 'Website static Unix identity inspection failed');
    }
    const account = parsePasswd(passwdResult?.stdout, identity.unixUser);
    if (account.homeDirectory !== identity.paths.workspace.homeDirectory || !NOLOGIN_SHELLS.has(account.shell)) {
      throw new WebsiteStaticDeploymentError('website_static_identity_drift', 'Website static Unix identity does not match the canonical path contract');
    }

    let groupResult;
    try { groupResult = await run(GETENT_PATH, ['group', identity.unixUser], { timeout: 5_000 }); }
    catch (error) {
      if (missingGetent(error)) {
        throw new WebsiteStaticDeploymentError('website_static_identity_drift', 'Website static Unix group is missing');
      }
      throw new WebsiteStaticDeploymentError('website_static_identity_inspection_failed', 'Website static Unix group inspection failed');
    }
    const group = parseGroup(groupResult?.stdout, identity.unixUser);
    if (group.gid !== account.gid || group.members.length !== 0) {
      throw new WebsiteStaticDeploymentError('website_static_identity_drift', 'Website static Unix group does not match the canonical identity');
    }
    return Object.freeze({ account, group });
  }

  function identityFor(applicationId) {
    return createApplicationIdentity(applicationId, {
      dataRoot,
      staticBuildRoot: buildRoot,
      staticPublishRoot: webRoot,
    });
  }

  async function inspectCurrent({ applicationId } = {}) {
    let identity;
    try { identity = identityFor(applicationId); }
    catch {
      throw new WebsiteStaticDeploymentError('invalid_static_deployment', 'Static deployment Application identity is invalid');
    }
    await inspectIdentity(identity);

    const currentPath = path.posix.join(identity.paths.static.publishRoot, 'current');
    let target;
    try { target = await readlinkFn(currentPath); }
    catch (error) {
      if (missingPath(error)) {
        return Object.freeze({
          satisfied: false,
          reason: 'website_static_current_missing',
          adapter: 'static',
          applicationId: identity.applicationId,
        });
      }
      if (error?.code === 'EINVAL') {
        return Object.freeze({
          satisfied: false,
          reason: 'website_static_current_invalid',
          adapter: 'static',
          applicationId: identity.applicationId,
        });
      }
      throw new WebsiteStaticDeploymentError('website_static_release_inspection_failed', 'Website static current release could not be inspected');
    }
    const releaseId = releaseIdFromTarget(target);
    if (!releaseId) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_static_current_invalid',
        adapter: 'static',
        applicationId: identity.applicationId,
      });
    }

    const releasePath = path.posix.join(identity.paths.static.publishRoot, 'releases', releaseId);
    let info;
    try { info = await lstatFn(releasePath); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return Object.freeze({
          satisfied: false,
          reason: 'website_static_release_missing',
          adapter: 'static',
          applicationId: identity.applicationId,
          releaseId,
        });
      }
      throw new WebsiteStaticDeploymentError('website_static_release_inspection_failed', 'Website static release could not be inspected');
    }
    if (!info?.isDirectory?.() || info.isSymbolicLink?.()) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_static_release_invalid',
        adapter: 'static',
        applicationId: identity.applicationId,
        releaseId,
      });
    }

    return Object.freeze({
      satisfied: true,
      adapter: 'static',
      applicationId: identity.applicationId,
      releaseId,
      currentRelease: currentPath,
      unixUser: identity.unixUser,
      homeDirectory: identity.paths.workspace.homeDirectory,
    });
  }

  async function inspectDeployment(rawSpec) {
    let spec;
    try { spec = normalizeStaticApplicationSpec(rawSpec); }
    catch {
      throw new WebsiteStaticDeploymentError('invalid_static_deployment', 'Static deployment specification is invalid');
    }
    const current = await inspectCurrent({ applicationId: spec.applicationId });
    if (current.satisfied !== true || current.releaseId !== spec.deploymentId) {
      return Object.freeze({
        ...current,
        satisfied: false,
        reason: current.satisfied === true ? 'website_static_release_not_current' : current.reason,
        deploymentId: spec.deploymentId,
      });
    }
    return Object.freeze({ ...current, deploymentId: spec.deploymentId });
  }

  async function inspectCompensation(rawTarget) {
    const target = normalizeCompensationTarget(rawTarget);
    const current = await inspectCurrent({ applicationId: target.applicationId });

    if (target.previousReleaseId === null) {
      if (current.satisfied === false && current.reason === 'website_static_current_missing') {
        return Object.freeze({
          satisfied: true,
          adapter: 'static',
          applicationId: target.applicationId,
          deploymentId: target.deploymentId,
          previousReleaseId: null,
          restoredPrevious: false,
        });
      }
      return Object.freeze({
        satisfied: false,
        reason: current.satisfied === true && current.releaseId !== target.deploymentId
          ? 'website_static_compensation_drift'
          : 'website_static_compensation_requires_manual_cleanup',
        adapter: 'static',
        applicationId: target.applicationId,
        deploymentId: target.deploymentId,
        previousReleaseId: null,
      });
    }

    if (current.satisfied !== true) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_static_compensation_drift',
        adapter: 'static',
        applicationId: target.applicationId,
        deploymentId: target.deploymentId,
        previousReleaseId: target.previousReleaseId,
      });
    }
    if (current.releaseId === target.previousReleaseId) {
      return Object.freeze({
        satisfied: true,
        adapter: 'static',
        applicationId: target.applicationId,
        deploymentId: target.deploymentId,
        previousReleaseId: target.previousReleaseId,
        releaseId: current.releaseId,
        restoredPrevious: true,
      });
    }
    return Object.freeze({
      satisfied: false,
      reason: current.releaseId === target.deploymentId
        ? 'website_static_compensation_pending'
        : 'website_static_compensation_drift',
      adapter: 'static',
      applicationId: target.applicationId,
      deploymentId: target.deploymentId,
      previousReleaseId: target.previousReleaseId,
      releaseId: current.releaseId,
    });
  }

  async function compensateDeployment(rawTarget) {
    const target = normalizeCompensationTarget(rawTarget);
    const before = await inspectCompensation(target);
    if (before.satisfied === true || target.previousReleaseId === null) return before;
    if (before.reason !== 'website_static_compensation_pending') return before;

    await resolvedRollbackManager.rollbackStatic({
      applicationId: target.applicationId,
      releaseId: target.previousReleaseId,
      currentReleaseId: target.deploymentId,
    });
    const after = await inspectCompensation(target);
    if (after.satisfied !== true) {
      throw new WebsiteStaticDeploymentError(
        'website_static_compensation_unverified',
        'Website static rollback did not restore the expected previous release',
      );
    }
    return after;
  }

  function deploymentManagerFor(identity) {
    const homeDirectory = identity.paths.workspace.homeDirectory;
    const guardedRun = async (file, args, options = {}) => {
      if (file === USERADD_PATH) {
        throw new WebsiteStaticDeploymentError(
          'website_static_identity_create_forbidden',
          'Website static deployment cannot create Unix identities outside provisioning',
        );
      }
      if (file === RUNUSER_PATH) {
        return run(file, args, {
          ...options,
          env: { ...(options.env ?? {}), HOME: homeDirectory },
        });
      }
      return run(file, args, options);
    };
    const manager = createDeploymentManager({
      buildRoot,
      webRoot,
      run: guardedRun,
      recordLog,
    });
    if (!manager || typeof manager.deployStatic !== 'function') {
      throw new WebsiteStaticDeploymentError('website_static_dependencies_invalid', 'Website static deployment manager is invalid');
    }
    return manager;
  }

  async function deployUnlocked(spec, options) {
    const identity = identityFor(spec.applicationId);
    await inspectIdentity(identity);
    return deploymentManagerFor(identity).deployStatic(spec, options);
  }

  function deployStatic(rawSpec, options = {}) {
    let spec;
    try { spec = normalizeStaticApplicationSpec(rawSpec); }
    catch {
      return Promise.reject(new WebsiteStaticDeploymentError('invalid_static_deployment', 'Static deployment specification is invalid'));
    }
    const key = spec.applicationId;
    const previous = deploymentLocks.get(key) ?? Promise.resolve();
    const runDeployment = previous.catch(() => {}).then(() => deployUnlocked(spec, options));
    let tracked;
    tracked = runDeployment.finally(() => {
      if (deploymentLocks.get(key) === tracked) deploymentLocks.delete(key);
    });
    deploymentLocks.set(key, tracked);
    return tracked;
  }

  return Object.freeze({
    deployStatic,
    inspectIdentity,
    inspectCurrent,
    inspectDeployment,
    compensateDeployment,
    inspectCompensation,
  });
}

export const websiteStaticDeploymentInternals = Object.freeze({
  parsePasswd,
  parseGroup,
  missingGetent,
  releaseIdFromTarget,
  missingPath,
  normalizeCompensationTarget,
  paths: Object.freeze({ GETENT_PATH, USERADD_PATH, RUNUSER_PATH }),
});
