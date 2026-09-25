import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertUuid } from '@yunpanel/shared';
import { nodeApplicationUser, nodeServiceName } from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const ENV_ROOT = '/etc/yunpanel/apps';
const SYSTEMD_ROOT = '/etc/systemd/system';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);

export class NodeServiceRemovalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeServiceRemovalError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new NodeServiceRemovalError(code, message);
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { fail('node_service_cleanup_identity_invalid', `${field} is invalid`); }
}

function parseProperties(value) {
  const properties = {};
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    properties[line.slice(0, index)] = line.slice(index + 1);
  }
  const pid = Number.parseInt(properties.MainPID ?? '0', 10);
  if (!Number.isSafeInteger(pid) || pid < 0) {
    fail('node_service_cleanup_inspection_invalid', 'Managed Node service PID state is invalid');
  }
  return Object.freeze({
    loadState: properties.LoadState ?? 'unknown',
    activeState: properties.ActiveState ?? 'unknown',
    subState: properties.SubState ?? 'unknown',
    unitFileState: properties.UnitFileState ?? 'unknown',
    mainPid: pid,
  });
}

function normalizeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('node_service_cleanup_identity_invalid', 'Managed Node cleanup identity is invalid');
  }
  const applicationId = uuid(value.applicationId, 'applicationId');
  const releaseId = value.releaseId == null ? null : uuid(value.releaseId, 'releaseId');
  const expectedServiceName = nodeServiceName(applicationId);
  const serviceName = value.serviceName ?? null;
  if ((releaseId === null && serviceName !== null)
    || (releaseId !== null && serviceName !== expectedServiceName)) {
    fail('node_service_cleanup_identity_invalid', 'Managed Node service identity does not match the Application release');
  }
  return Object.freeze({
    applicationId,
    releaseId,
    serviceName: expectedServiceName,
    account: nodeApplicationUser(applicationId),
  });
}

async function inspectOwnedFile(target, kind, applicationId, account, {
  lstatFn,
  readFileFn,
  envPath,
} = {}) {
  let metadata;
  try { metadata = await lstatFn(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ present: false, target });
    fail('node_service_cleanup_artifact_inspection_failed', 'Managed Node service artifact could not be inspected');
  }
  if (metadata.isSymbolicLink?.() || !metadata.isFile?.()) {
    fail('node_service_cleanup_artifact_unsafe', 'Managed Node service artifact is not a regular owned file');
  }
  let content;
  try { content = await readFileFn(target, 'utf8'); }
  catch { fail('node_service_cleanup_artifact_inspection_failed', 'Managed Node service artifact could not be read'); }

  if (kind === 'unit') {
    const required = [
      `Description=YunPanel Node application ${applicationId}`,
      `User=${account}`,
      `Group=${account}`,
      `EnvironmentFile=${envPath}`,
    ];
    if (required.some((line) => !String(content).split(/\r?\n/).includes(line))) {
      fail('node_service_cleanup_artifact_ownership_mismatch', 'Managed Node systemd unit does not match the Application identity');
    }
  } else {
    const marker = `YUNPANEL_APPLICATION_ID="${applicationId}"`;
    if (!String(content).split(/\r?\n/).includes(marker)) {
      fail('node_service_cleanup_artifact_ownership_mismatch', 'Managed Node environment file does not match the Application identity');
    }
  }
  return Object.freeze({ present: true, target });
}

export function createNodeServiceRemovalManager({
  appRoot = APP_ROOT,
  envRoot = ENV_ROOT,
  systemdRoot = SYSTEMD_ROOT,
  systemctlPaths = SYSTEMCTL_PATHS,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024,
  }),
  lstatFn = lstat,
  readFileFn = readFile,
  readlinkFn = readlink,
  rmFn = rm,
} = {}) {
  if (!Array.isArray(systemctlPaths) || systemctlPaths.length < 1
    || typeof run !== 'function' || typeof lstatFn !== 'function'
    || typeof readFileFn !== 'function' || typeof readlinkFn !== 'function'
    || typeof rmFn !== 'function') {
    throw new NodeServiceRemovalError('node_service_cleanup_dependencies_invalid', 'Managed Node service cleanup dependencies are invalid');
  }

  async function findSystemctl() {
    for (const candidate of systemctlPaths) {
      try {
        await run(candidate, ['--version'], { timeout: 5_000, maxBuffer: 16 * 1024 });
        return candidate;
      } catch { /* Continue through fixed allowlisted paths. */ }
    }
    fail('node_service_cleanup_systemd_unavailable', 'systemctl is unavailable for managed Node cleanup');
  }

  async function serviceState(systemctlPath, serviceName) {
    const args = [
      'show', serviceName,
      '--property=LoadState', '--property=ActiveState', '--property=SubState',
      '--property=UnitFileState', '--property=MainPID', '--no-pager',
    ];
    try {
      const result = await run(systemctlPath, args, { timeout: 10_000, maxBuffer: 32 * 1024 });
      return parseProperties(result?.stdout);
    } catch (error) {
      if (typeof error?.stdout === 'string' && error.stdout.includes('LoadState=')) {
        return parseProperties(error.stdout);
      }
      fail('node_service_cleanup_inspection_failed', 'Managed Node service state could not be inspected');
    }
  }

  async function currentRelease(spec) {
    const currentPath = path.join(appRoot, spec.applicationId, 'current');
    try {
      const target = await readlinkFn(currentPath);
      if (spec.releaseId === null || target !== `releases/${spec.releaseId}`) {
        fail('node_service_cleanup_release_drift', 'Managed Node current release does not match removal evidence');
      }
      return Object.freeze({ present: true, path: currentPath, target });
    } catch (error) {
      if (error instanceof NodeServiceRemovalError) throw error;
      if (error?.code === 'ENOENT') {
        if (spec.releaseId !== null) {
          fail('node_service_cleanup_release_drift', 'Managed Node current release is missing');
        }
        return Object.freeze({ present: false, path: currentPath, target: null });
      }
      fail('node_service_cleanup_release_inspection_failed', 'Managed Node current release could not be inspected');
    }
  }

  async function inspectRemoval(rawSpec) {
    const spec = normalizeSpec(rawSpec);
    const systemctlPath = await findSystemctl();
    const unitPath = path.join(systemdRoot, spec.serviceName);
    const environmentPath = path.join(envRoot, `${spec.applicationId}.env`);
    const [release, unit, environment, service] = await Promise.all([
      currentRelease(spec),
      inspectOwnedFile(unitPath, 'unit', spec.applicationId, spec.account, {
        lstatFn, readFileFn, envPath: environmentPath,
      }),
      inspectOwnedFile(environmentPath, 'environment', spec.applicationId, spec.account, {
        lstatFn, readFileFn, envPath: environmentPath,
      }),
      serviceState(systemctlPath, spec.serviceName),
    ]);

    if (spec.releaseId === null && (unit.present || environment.present
      || service.loadState !== 'not-found' || service.activeState !== 'inactive'
      || service.mainPid !== 0)) {
      fail('node_service_cleanup_evidence_unavailable', 'Undeployed Application has unmanaged direct-systemd host state');
    }
    if (service.mainPid !== 0 && service.activeState === 'inactive') {
      fail('node_service_cleanup_inspection_invalid', 'Managed Node service process state is inconsistent');
    }

    return Object.freeze({
      ready: true,
      applicationId: spec.applicationId,
      releaseId: spec.releaseId,
      serviceName: spec.serviceName,
      unitPath,
      environmentPath,
      currentReleasePresent: release.present,
      unitPresent: unit.present,
      environmentPresent: environment.present,
      loadState: service.loadState,
      activeState: service.activeState,
      subState: service.subState,
      unitFileState: service.unitFileState,
      mainPid: service.mainPid,
      systemctlPath,
    });
  }

  async function removeService(rawSpec) {
    const before = await inspectRemoval(rawSpec);
    const deployed = before.releaseId !== null;
    let stopped = false;
    let disabled = false;

    if (deployed && (before.activeState !== 'inactive' || before.mainPid !== 0)) {
      try { await run(before.systemctlPath, ['stop', before.serviceName], { timeout: 30_000, maxBuffer: 64 * 1024 }); }
      catch { fail('node_service_cleanup_stop_failed', 'Managed Node service could not be stopped'); }
      const stoppedState = await serviceState(before.systemctlPath, before.serviceName);
      if (stoppedState.activeState !== 'inactive' || stoppedState.mainPid !== 0) {
        fail('node_service_cleanup_stop_unconfirmed', 'Managed Node service remained active after stop');
      }
      stopped = true;
    }

    if (deployed && !['', 'disabled', 'not-found', 'static', 'masked'].includes(before.unitFileState)) {
      try { await run(before.systemctlPath, ['disable', before.serviceName], { timeout: 30_000, maxBuffer: 64 * 1024 }); }
      catch { fail('node_service_cleanup_disable_failed', 'Managed Node service could not be disabled'); }
      disabled = true;
    }

    try {
      if (before.unitPresent) await rmFn(before.unitPath, { force: true });
      if (before.environmentPresent) await rmFn(before.environmentPath, { force: true });
      if (deployed || before.unitPresent || before.environmentPresent || disabled) {
        await run(before.systemctlPath, ['daemon-reload'], { timeout: 30_000, maxBuffer: 64 * 1024 });
      }
    } catch (error) {
      if (error instanceof NodeServiceRemovalError) throw error;
      fail('node_service_cleanup_remove_failed', 'Managed Node service artifacts could not be removed');
    }

    const after = await inspectRemoval(rawSpec);
    if (after.unitPresent || after.environmentPresent
      || after.loadState !== 'not-found' || after.activeState !== 'inactive' || after.mainPid !== 0) {
      fail('node_service_cleanup_unverified', 'Managed Node service cleanup could not be verified');
    }

    return Object.freeze({
      applicationId: after.applicationId,
      releaseId: after.releaseId,
      serviceName: after.serviceName,
      directSystemdCleaned: true,
      serviceStopped: stopped,
      serviceDisabled: disabled,
      unitRemoved: before.unitPresent,
      environmentRemoved: before.environmentPresent,
      sideEffects: stopped || disabled || before.unitPresent || before.environmentPresent,
    });
  }

  return Object.freeze({ inspectRemoval, removeService });
}

export const nodeServiceRemovalInternals = Object.freeze({
  parseProperties,
  normalizeSpec,
  defaults: Object.freeze({
    appRoot: APP_ROOT,
    envRoot: ENV_ROOT,
    systemdRoot: SYSTEMD_ROOT,
    systemctlPaths: SYSTEMCTL_PATHS,
  }),
});
