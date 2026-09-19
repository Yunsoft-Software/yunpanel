import { execFile } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApplicationIdentity } from './application-identity.js';
import { createPassengerManager } from './passenger-manager.js';
import { createWebsiteIdentityManager } from './website-identity-manager.js';
import { websitePathContractInternals } from './website-path-contract.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = websitePathContractInternals.roots.application;
const MANAGED_NODE_ROOT = '/opt/yunpanel/node-runtimes';
const NOLOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]{1,240}$/;

export class PassengerSiteManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PassengerSiteManagerError';
    this.code = code;
  }
}

function nodeMajor(value) {
  if (!Number.isInteger(value) || value < 20 || value > 40) {
    throw new PassengerSiteManagerError('passenger_site_node_major_invalid', 'Passenger Website Node major is invalid');
  }
  return value;
}

function relativePath(value, field) {
  if (typeof value !== 'string' || !SAFE_RELATIVE_PATH.test(value) || value.startsWith('/')) {
    throw new PassengerSiteManagerError('passenger_site_path_invalid', `${field} must be a safe relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.split('/').includes('..')) {
    throw new PassengerSiteManagerError('passenger_site_path_invalid', `${field} contains unsafe path segments`);
  }
  return value;
}

function absoluteWithin(value, root, field) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new PassengerSiteManagerError('passenger_site_path_invalid', `${field} must be an absolute managed path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || (normalized !== root && !normalized.startsWith(`${root}/`))) {
    throw new PassengerSiteManagerError('passenger_site_path_invalid', `${field} must stay inside the managed application root`);
  }
  return normalized;
}

function parseNodeVersion(stdout, expectedMajor) {
  const value = String(stdout ?? '').trim();
  const match = value.match(/^v(\d{1,2})\.\d+\.\d+$/);
  if (!match || Number.parseInt(match[1], 10) !== expectedMajor) return null;
  return value;
}

function normalizedIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'passenger') {
    throw new PassengerSiteManagerError('passenger_site_intent_invalid', 'Passenger Website runtime intent is invalid');
  }
  let identity;
  try { identity = createApplicationIdentity(intent.applicationId); }
  catch { throw new PassengerSiteManagerError('passenger_site_application_invalid', 'Passenger Website Application identity is invalid'); }
  const applicationId = identity.applicationId;
  const major = nodeMajor(intent.nodeMajor);
  const currentRoot = identity.paths.runtime.currentRelease;
  const appRoot = absoluteWithin(intent.appRoot, currentRoot, 'appRoot');
  const documentRoot = absoluteWithin(intent.documentRoot, appRoot, 'documentRoot');
  const startupFile = relativePath(intent.startupFile, 'startupFile');
  const startupExt = path.posix.extname(startupFile);
  if (!['.js', '.mjs', '.cjs'].includes(startupExt)) {
    throw new PassengerSiteManagerError('passenger_site_startup_extension_invalid', 'Passenger Website startup file must have a .js, .mjs, or .cjs extension');
  }
  let appLogFile = null;
  if (intent.appLogFile !== undefined && intent.appLogFile !== null) {
    appLogFile = absoluteWithin(intent.appLogFile, identity.paths.workspace.logDirectory, 'appLogFile');
  }
  const expectedUser = identity.unixUser;
  if (intent.unixUser !== expectedUser) {
    throw new PassengerSiteManagerError('passenger_site_identity_mismatch', 'Passenger Website Unix identity does not match the Application');
  }
  if (!Array.isArray(intent.nodeCandidates) || intent.nodeCandidates.length < 1 || intent.nodeCandidates.length > 3) {
    throw new PassengerSiteManagerError('passenger_site_node_candidates_invalid', 'Passenger Website Node candidates are invalid');
  }
  const allowed = new Set([
    path.posix.join(MANAGED_NODE_ROOT, `v${major}`, 'bin', 'node'),
    '/usr/bin/node',
  ]);
  const nodeCandidates = [...new Set(intent.nodeCandidates)];
  if (nodeCandidates.length !== intent.nodeCandidates.length || nodeCandidates.some((candidate) => !allowed.has(candidate))) {
    throw new PassengerSiteManagerError('passenger_site_node_candidates_invalid', 'Passenger Website Node candidates contain an unsupported path');
  }
  return Object.freeze({
    applicationId,
    nodeMajor: major,
    currentRoot,
    releasesDirectory: identity.paths.runtime.releasesDirectory,
    homeDirectory: identity.paths.workspace.homeDirectory,
    logDirectory: identity.paths.workspace.logDirectory,
    appRoot,
    documentRoot,
    startupFile,
    appLogFile,
    unixUser: expectedUser,
    nodeCandidates: Object.freeze(nodeCandidates),
  });
}

function releaseIdFromTarget(target) {
  if (typeof target !== 'string') return null;
  const match = target.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

export function createPassengerSiteManager({
  passengerManager = createPassengerManager(),
  websiteIdentityManager = createWebsiteIdentityManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 5_000,
    maxBuffer: 1024 * 1024,
  }),
  lstatFn = lstat,
  readlinkFn = readlink,
  realpathFn = realpath,
} = {}) {
  if (!passengerManager || typeof passengerManager.inspect !== 'function' || typeof passengerManager.apply !== 'function'
    || !websiteIdentityManager || typeof websiteIdentityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function' || typeof readlinkFn !== 'function' || typeof realpathFn !== 'function') {
    throw new PassengerSiteManagerError('passenger_site_dependencies_invalid', 'Passenger Website runtime dependencies are invalid');
  }

  async function resolveNode(spec) {
    for (const candidate of spec.nodeCandidates) {
      try {
        const result = await run(candidate, ['--version'], { timeout: 5_000 });
        const version = parseNodeVersion(result?.stdout, spec.nodeMajor);
        if (version) return Object.freeze({ path: candidate, version });
      } catch {
        // Continue through the bounded candidate list.
      }
    }
    return null;
  }

  async function releaseEvidence(spec) {
    let linkTarget;
    try { linkTarget = await readlinkFn(spec.currentRoot); }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EINVAL') return null;
      throw new PassengerSiteManagerError('passenger_site_release_inspection_failed', 'Passenger Website current release could not be inspected');
    }
    const releaseId = releaseIdFromTarget(linkTarget);
    if (!releaseId) return null;
    const expectedReleaseRoot = path.posix.join(spec.releasesDirectory, releaseId);

    let resolvedCurrent;
    let resolvedAppRoot;
    let resolvedDocumentRoot;
    try {
      [resolvedCurrent, resolvedAppRoot, resolvedDocumentRoot] = await Promise.all([
        realpathFn(spec.currentRoot),
        realpathFn(spec.appRoot),
        realpathFn(spec.documentRoot),
      ]);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new PassengerSiteManagerError('passenger_site_release_inspection_failed', 'Passenger Website release paths could not be resolved');
    }
    if (resolvedCurrent !== expectedReleaseRoot
      || (resolvedAppRoot !== expectedReleaseRoot && !resolvedAppRoot.startsWith(`${expectedReleaseRoot}/`))
      || (resolvedDocumentRoot !== resolvedAppRoot && !resolvedDocumentRoot.startsWith(`${resolvedAppRoot}/`))) {
      throw new PassengerSiteManagerError('passenger_site_release_escape', 'Passenger Website release resolves outside managed storage');
    }

    const startupPath = path.posix.join(spec.appRoot, spec.startupFile);
    let resolvedStartup;
    let startupInfo;
    try {
      startupInfo = await lstatFn(startupPath);
      if (startupInfo.isSymbolicLink()) {
        throw new PassengerSiteManagerError('passenger_site_startup_invalid', 'Passenger Website startup file must not be a symbolic link');
      }
      resolvedStartup = await realpathFn(startupPath);
    } catch (error) {
      if (error instanceof PassengerSiteManagerError) throw error;
      if (error?.code === 'ENOENT') return null;
      throw new PassengerSiteManagerError('passenger_site_startup_inspection_failed', 'Passenger Website startup file could not be inspected');
    }
    if (!resolvedStartup.startsWith(`${resolvedAppRoot}/`) || !startupInfo.isFile()) {
      throw new PassengerSiteManagerError('passenger_site_startup_invalid', 'Passenger Website startup file must be a real file inside the active app root');
    }
    return Object.freeze({ releaseId, resolvedAppRoot, resolvedDocumentRoot, resolvedStartup });
  }

  async function identityEvidence(spec) {
    const identity = await websiteIdentityManager.inspect({
      user: spec.unixUser,
      homeDirectory: spec.homeDirectory,
    });
    if (!identity?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: identity?.reason ?? 'website_identity_unverified',
      });
    }
    if (identity.user !== spec.unixUser
      || identity.homeDirectory !== spec.homeDirectory
      || !Number.isSafeInteger(identity.uid) || identity.uid < 1
      || !Number.isSafeInteger(identity.gid) || identity.gid < 1
      || !NOLOGIN_SHELLS.has(identity.shell)
      || identity.homeMode !== 0o750) {
      throw new PassengerSiteManagerError('passenger_site_identity_drift', 'Passenger Website identity evidence does not match canonical managed state');
    }
    return identity;
  }

  async function inspectSpec(spec) {
    const passenger = await passengerManager.inspect();
    if (!passenger?.healthy) {
      return Object.freeze({
        satisfied: false,
        reason: 'passenger_runtime_unavailable',
        adapter: 'passenger',
        applicationId: spec.applicationId,
      });
    }
    const identity = await identityEvidence(spec);
    if (!identity.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'passenger_identity_unavailable',
        identityReason: identity.reason,
        adapter: 'passenger',
        applicationId: spec.applicationId,
        unixUser: spec.unixUser,
        homeDirectory: spec.homeDirectory,
      });
    }
    const node = await resolveNode(spec);
    if (!node) {
      return Object.freeze({
        satisfied: false,
        reason: 'passenger_node_unavailable',
        adapter: 'passenger',
        applicationId: spec.applicationId,
        nodeMajor: spec.nodeMajor,
      });
    }
    const release = await releaseEvidence(spec);
    if (!release) {
      return Object.freeze({
        satisfied: false,
        reason: 'passenger_release_unavailable',
        adapter: 'passenger',
        applicationId: spec.applicationId,
        nodeMajor: spec.nodeMajor,
        nodeBinary: node.path,
        nodeVersion: node.version,
      });
    }
    return Object.freeze({
      satisfied: true,
      adapter: 'passenger',
      applicationId: spec.applicationId,
      releaseId: release.releaseId,
      nodeMajor: spec.nodeMajor,
      nodeBinary: node.path,
      nodeVersion: node.version,
      appRoot: spec.appRoot,
      documentRoot: spec.documentRoot,
      startupFile: spec.startupFile,
      appLogFile: spec.appLogFile,
      unixUser: spec.unixUser,
      unixUid: identity.uid,
      unixGid: identity.gid,
      homeDirectory: identity.homeDirectory,
      homeMode: identity.homeMode,
      passengerVersion: passenger.installedVersion ?? null,
    });
  }

  async function previewMigration(intent) {
    const spec = normalizedIntent(intent);
    let passenger;
    try {
      const value = await passengerManager.inspect();
      passenger = Object.freeze({
        healthy: value?.healthy === true,
        installedVersion: typeof value?.installedVersion === 'string' ? value.installedVersion : null,
      });
    } catch {
      passenger = Object.freeze({ healthy: false, installedVersion: null });
    }

    let identity;
    try {
      const value = await identityEvidence(spec);
      identity = value?.satisfied === true
        ? Object.freeze({
          satisfied: true,
          uid: value.uid,
          gid: value.gid,
          homeDirectory: value.homeDirectory,
          shell: value.shell,
          homeMode: value.homeMode.toString(8).padStart(4, '0'),
        })
        : Object.freeze({
          satisfied: false,
          reason: value?.reason ?? 'website_identity_unverified',
        });
    } catch (error) {
      identity = Object.freeze({
        satisfied: false,
        reason: typeof error?.code === 'string' ? error.code : 'passenger_site_identity_inspection_failed',
      });
    }

    const nodeCandidates = [];
    for (const candidate of spec.nodeCandidates) {
      try {
        const result = await run(candidate, ['--version'], { timeout: 5_000 });
        const rawVersion = String(result?.stdout ?? '').trim();
        const version = parseNodeVersion(rawVersion, spec.nodeMajor);
        nodeCandidates.push(Object.freeze({
          path: candidate,
          available: true,
          version: /^v\d{1,2}\.\d+\.\d+$/.test(rawVersion) ? rawVersion : null,
          matchesRequestedMajor: version !== null,
        }));
      } catch {
        nodeCandidates.push(Object.freeze({
          path: candidate,
          available: false,
          version: null,
          matchesRequestedMajor: false,
        }));
      }
    }

    let currentReleaseTarget = null;
    let currentReleaseTargetError = null;
    try { currentReleaseTarget = await readlinkFn(spec.currentRoot); }
    catch (error) {
      currentReleaseTargetError = error?.code === 'ENOENT' || error?.code === 'EINVAL'
        ? 'passenger_release_unavailable'
        : 'passenger_site_release_inspection_failed';
    }

    let release = null;
    let releaseError = null;
    try {
      const value = await releaseEvidence(spec);
      if (value) {
        release = Object.freeze({
          releaseId: value.releaseId,
          resolvedAppRoot: value.resolvedAppRoot,
          resolvedDocumentRoot: value.resolvedDocumentRoot,
          resolvedStartup: value.resolvedStartup,
        });
      } else {
        releaseError = 'passenger_release_unavailable';
      }
    } catch (error) {
      releaseError = typeof error?.code === 'string' ? error.code : 'passenger_site_release_inspection_failed';
    }

    const differences = [];
    if (!passenger.healthy) differences.push('passenger_runtime_unavailable');
    if (!identity.satisfied) differences.push(identity.reason);
    if (!nodeCandidates.some((candidate) => candidate.matchesRequestedMajor)) differences.push('passenger_node_unavailable');
    if (!release) differences.push(releaseError ?? currentReleaseTargetError ?? 'passenger_release_unavailable');

    return Object.freeze({
      version: 1,
      adapter: 'passenger',
      satisfied: differences.length === 0,
      automaticMigration: false,
      migrationBlockedReason: 'passenger_legacy_runtime_not_operation_owned',
      current: Object.freeze({
        passenger,
        identity,
        nodeCandidates: Object.freeze(nodeCandidates),
        currentReleaseTarget,
        currentReleaseTargetError,
        release,
      }),
      desired: Object.freeze({
        applicationId: spec.applicationId,
        nodeMajor: spec.nodeMajor,
        nodeCandidates: spec.nodeCandidates,
        currentRoot: spec.currentRoot,
        releasesDirectory: spec.releasesDirectory,
        homeDirectory: spec.homeDirectory,
        appRoot: spec.appRoot,
        documentRoot: spec.documentRoot,
        startupFile: spec.startupFile,
        unixUser: spec.unixUser,
      }),
      differences: Object.freeze([...new Set(differences)]),
    });
  }

  async function inspect(intent) {
    return inspectSpec(normalizedIntent(intent));
  }

  async function apply(intent) {
    const spec = normalizedIntent(intent);
    await passengerManager.apply();
    return inspectSpec(spec);
  }

  return Object.freeze({ inspect, previewMigration, apply });
}

export function validatePassengerSetup({ nodeMajor: major, startupFile: rawStartupFile, appRoot, unixUser }) {
  nodeMajor(major);
  relativePath(rawStartupFile, 'startupFile');
  const ext = path.posix.extname(rawStartupFile);
  if (!['.js', '.mjs', '.cjs'].includes(ext)) {
    throw new PassengerSiteManagerError('passenger_site_startup_extension_invalid', 'Passenger Website startup file must have a .js, .mjs, or .cjs extension');
  }
  if (typeof appRoot !== 'string' || !appRoot.startsWith('/')) {
    throw new PassengerSiteManagerError('passenger_site_path_invalid', 'appRoot must be an absolute path');
  }
  if (typeof unixUser !== 'string' || !/^yunapp-[a-f0-9]{12}$/.test(unixUser)) {
    throw new PassengerSiteManagerError('passenger_site_identity_mismatch', 'unixUser must be a valid yunapp-* identity');
  }
  return true;
}

export const passengerSiteManagerInternals = Object.freeze({
  normalizedIntent,
  parseNodeVersion,
  releaseIdFromTarget,
  APP_ROOT,
  MANAGED_NODE_ROOT,
});
