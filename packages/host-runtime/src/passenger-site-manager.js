import { execFile } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { nodeApplicationUser } from '@yunpanel/config-templates';
import { assertUuid } from '@yunpanel/shared';
import { createPassengerManager } from './passenger-manager.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const MANAGED_NODE_ROOT = '/opt/yunpanel/node-runtimes';
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
  let applicationId;
  try { applicationId = assertUuid(intent.applicationId, 'applicationId'); }
  catch { throw new PassengerSiteManagerError('passenger_site_application_invalid', 'Passenger Website Application identity is invalid'); }
  const major = nodeMajor(intent.nodeMajor);
  const currentRoot = path.posix.join(APP_ROOT, applicationId, 'current');
  const appRoot = absoluteWithin(intent.appRoot, currentRoot, 'appRoot');
  const documentRoot = absoluteWithin(intent.documentRoot, appRoot, 'documentRoot');
  const startupFile = relativePath(intent.startupFile, 'startupFile');
  const expectedUser = nodeApplicationUser(applicationId);
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
    appRoot,
    documentRoot,
    startupFile,
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
    const expectedReleaseRoot = path.posix.join(APP_ROOT, spec.applicationId, 'releases', releaseId);

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
      unixUser: spec.unixUser,
      passengerVersion: passenger.installedVersion ?? null,
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

  return Object.freeze({ inspect, apply });
}

export const passengerSiteManagerInternals = Object.freeze({
  normalizedIntent,
  parseNodeVersion,
  releaseIdFromTarget,
  APP_ROOT,
  MANAGED_NODE_ROOT,
});
