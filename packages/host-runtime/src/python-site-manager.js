import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  pythonApplicationUser,
  pythonServiceName,
  pythonSocketPath,
  renderPythonSystemdUnit,
} from '@yunpanel/config-templates';
import { normalizePythonRuntimeConfig } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/python-sites';
const RECEIPT_VERSION = 1;
const SYSTEMD_DIR = '/etc/systemd/system';
const RUN_ROOT = '/run/yunpanel';
const DATA_ROOT = '/var/lib/yunpanel/data';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const PYTHON3_PATHS = Object.freeze(['/usr/bin/python3', 'python3']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_STATES = new Set(['prepared', 'active', 'compensated']);

export class PythonSiteManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PythonSiteManagerError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseProperties(output) {
  const values = {};
  for (const line of String(output ?? '').split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const mainPid = Number.parseInt(values.MainPID ?? '0', 10);
  return {
    loadState: values.LoadState || 'unknown',
    activeState: values.ActiveState || 'unknown',
    subState: values.SubState || 'unknown',
    unitFileState: values.UnitFileState || 'unknown',
    mainPid: Number.isSafeInteger(mainPid) && mainPid >= 0 ? mainPid : 0,
  };
}

export function createPythonSiteManager({
  receiptRoot = RECEIPT_ROOT,
  systemdDir = SYSTEMD_DIR,
  systemctlPaths = SYSTEMCTL_PATHS,
  python3Paths = PYTHON3_PATHS,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: 1024 * 1024,
    env: options.env,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (
    typeof run !== 'function'
    || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function'
    || typeof rmFn !== 'function'
    || typeof writeFileFn !== 'function'
  ) {
    throw new PythonSiteManagerError('python_dependencies_invalid', 'Python site manager dependencies are invalid');
  }

  async function findBinary(candidates, testArgs = ['--version']) {
    for (const candidate of candidates) {
      try {
        await run(candidate, testArgs, { timeout: 5_000 });
        return candidate;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  async function ensurePrerequisites() {
    const python3 = await findBinary(python3Paths);
    if (!python3) {
      throw new PythonSiteManagerError('python_prerequisites_missing', 'Python 3 binary not found on host');
    }

    try {
      await run(python3, ['-m', 'venv', '--help'], { timeout: 5_000 });
    } catch {
      throw new PythonSiteManagerError('python_prerequisites_missing', 'Python 3 venv module is not installed (python3-venv package required)');
    }

    const versionOutput = await run(python3, ['--version']);
    const versionString = String(versionOutput?.stdout ?? versionOutput ?? '').trim();

    return {
      python3Path: python3,
      version: versionString,
      venvAvailable: true,
    };
  }

  async function ensureVirtualenv({
    applicationId,
    unixUser,
    unixGroup = null,
  }) {
    if (!applicationId || !UUID_PATTERN.test(applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }
    const expectedUser = pythonApplicationUser(applicationId);
    if (unixUser !== expectedUser) {
      throw new PythonSiteManagerError('python_site_identity_mismatch', 'Unix user does not match the managed application identity');
    }

    const dataDir = path.posix.join(DATA_ROOT, applicationId);
    const venvPath = path.posix.join(dataDir, 'venv');
    const pythonBin = path.posix.join(venvPath, 'bin', 'python');

    let venvExists = false;
    try {
      await lstatFn(pythonBin);
      venvExists = true;
    } catch {
      venvExists = false;
    }

    if (!venvExists) {
      const python3 = await findBinary(python3Paths);
      if (!python3) {
        throw new PythonSiteManagerError('python_prerequisites_missing', 'Python 3 binary not found');
      }

      await mkdirFn(dataDir, { recursive: true, mode: 0o750 });
      try {
        await run(python3, ['-m', 'venv', venvPath]);
      } catch (error) {
        throw new PythonSiteManagerError('python_virtualenv_failed', `Failed to create virtual environment: ${error.message}`);
      }

      // Fix permissions
      const group = unixGroup ?? unixUser;
      try {
        await run('/usr/bin/chown', ['-R', `${unixUser}:${group}`, dataDir]);
      } catch {
        // Allow in testing or if chown fails due to non-root
      }

      return { venvPath, created: true };
    }

    return { venvPath, created: false };
  }

  async function installRequirements({
    applicationId,
    releasePath,
    requirementsFile = 'requirements.txt',
    unixUser,
  }) {
    if (!applicationId || !UUID_PATTERN.test(applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }

    const venvPath = path.posix.join(DATA_ROOT, applicationId, 'venv');
    const pipBin = path.posix.join(venvPath, 'bin', 'pip');
    const requirementsPath = path.posix.join(releasePath, requirementsFile);

    let exists = false;
    try {
      await lstatFn(requirementsPath);
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) {
      return { installed: false, reason: 'requirements_file_not_found', requirementsPath };
    }

    try {
      await run(pipBin, ['install', '--no-input', '-r', requirementsPath], { timeout: 300_000 });
      return { installed: true, requirementsPath };
    } catch (error) {
      throw new PythonSiteManagerError('python_requirements_failed', `Failed to install requirements: ${error.message}`);
    }
  }

  async function apply({
    operationId,
    websiteId,
    applicationId,
    unixUser,
    unixGroup = null,
    runtime,
    environmentFile = null,
  }) {
    if (!operationId || !UUID_PATTERN.test(operationId)) {
      throw new PythonSiteManagerError('python_operation_invalid', 'Operation ID is invalid');
    }
    if (!applicationId || !UUID_PATTERN.test(applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }
    const expectedUser = pythonApplicationUser(applicationId);
    if (unixUser !== expectedUser) {
      throw new PythonSiteManagerError('python_site_identity_mismatch', 'Unix user does not match the managed application identity');
    }

    const normalizedRuntime = normalizePythonRuntimeConfig(runtime);
    const serviceName = pythonServiceName(applicationId);
    const unitFilePath = path.posix.join(systemdDir, serviceName);
    const socketPath = pythonSocketPath(applicationId);

    // Read previous unit if exists
    let previousUnit = null;
    try {
      previousUnit = await readFileFn(unitFilePath, 'utf8');
    } catch {
      previousUnit = null;
    }

    const unitContent = renderPythonSystemdUnit({
      applicationId,
      user: unixUser,
      group: unixGroup,
      runtime: normalizedRuntime,
      environmentFile,
    });

    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    await mkdirFn(RUN_ROOT, { recursive: true, mode: 0o755 });

    const receiptPath = path.posix.join(receiptRoot, `${operationId}.json`);
    const receipt = {
      version: RECEIPT_VERSION,
      operationId,
      websiteId,
      applicationId,
      unixUser,
      serviceName,
      unitFilePath,
      state: 'prepared',
      previousUnit,
      unitSha256: sha256(unitContent),
      mutated: false,
      timestamp: new Date().toISOString(),
    };

    await writeFileFn(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

    // Write systemd unit file
    await writeFileFn(unitFilePath, unitContent, 'utf8');
    receipt.mutated = true;

    const systemctl = await findBinary(systemctlPaths);
    if (!systemctl) {
      throw new PythonSiteManagerError('python_systemctl_missing', 'systemctl binary not found');
    }

    try {
      await run(systemctl, ['daemon-reload']);
      await run(systemctl, ['enable', serviceName]);
      await run(systemctl, ['restart', serviceName]);
    } catch (error) {
      throw new PythonSiteManagerError('python_service_failed', `Failed to start Python systemd service: ${error.message}`);
    }

    // Inspect service
    let properties = { activeState: 'unknown', mainPid: 0 };
    try {
      const showOut = await run(systemctl, ['show', serviceName, '--property=MainPID,ActiveState,SubState,LoadState']);
      properties = parseProperties(showOut?.stdout ?? showOut);
    } catch {
      // Continue if show fails
    }

    receipt.state = 'active';
    await writeFileFn(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

    return {
      serviceName,
      socketPath,
      port: normalizedRuntime.port ?? null,
      active: properties.activeState === 'active',
      activeState: properties.activeState,
      pid: properties.mainPid,
    };
  }

  async function inspect({ applicationId, releaseId = null }) {
    if (!applicationId || !UUID_PATTERN.test(applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }

    const serviceName = pythonServiceName(applicationId);
    const socketPath = pythonSocketPath(applicationId);
    const systemctl = await findBinary(systemctlPaths);

    let properties = { activeState: 'inactive', subState: 'dead', loadState: 'not-found', mainPid: 0 };
    if (systemctl) {
      try {
        const showOut = await run(systemctl, ['show', serviceName, '--property=MainPID,ActiveState,SubState,LoadState']);
        properties = parseProperties(showOut?.stdout ?? showOut);
      } catch {
        // service may not exist
      }
    }

    let socketExists = false;
    try {
      await lstatFn(socketPath);
      socketExists = true;
    } catch {
      socketExists = false;
    }

    const active = properties.activeState === 'active';
    return {
      releaseId,
      serviceName,
      socketPath,
      active,
      activeState: properties.activeState,
      subState: properties.subState,
      loadState: properties.loadState,
      mainPid: properties.mainPid,
      socketExists,
      healthy: active,
      inspectionError: false,
    };
  }

  async function restart({ applicationId, releaseId = null }) {
    if (!applicationId || !UUID_PATTERN.test(applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }

    const serviceName = pythonServiceName(applicationId);
    const systemctl = await findBinary(systemctlPaths);
    if (!systemctl) {
      throw new PythonSiteManagerError('python_systemctl_missing', 'systemctl binary not found');
    }

    await run(systemctl, ['restart', serviceName]);
    const inspected = await inspect({ applicationId, releaseId });
    return {
      ...inspected,
      restarted: true,
      healthy: true,
    };
  }

  async function stop({ applicationId }) {
    if (!applicationId || !UUID_PATTERN.test(applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }

    const serviceName = pythonServiceName(applicationId);
    const systemctl = await findBinary(systemctlPaths);
    if (!systemctl) {
      throw new PythonSiteManagerError('python_systemctl_missing', 'systemctl binary not found');
    }

    await run(systemctl, ['stop', serviceName]);
    return inspect({ applicationId });
  }

  async function compensate({ operationId, applicationId }) {
    if (!operationId || !UUID_PATTERN.test(operationId)) {
      throw new PythonSiteManagerError('python_operation_invalid', 'Operation ID is invalid');
    }

    const receiptPath = path.posix.join(receiptRoot, `${operationId}.json`);
    let receiptContent;
    try {
      receiptContent = await readFileFn(receiptPath, 'utf8');
    } catch {
      throw new PythonSiteManagerError('python_receipt_not_found', 'Python site staging receipt not found');
    }

    const receipt = JSON.parse(receiptContent);
    if (receipt.state === 'compensated') {
      return { compensated: true, state: 'already_compensated' };
    }

    const systemctl = await findBinary(systemctlPaths);

    if (receipt.mutated) {
      const unitFilePath = receipt.unitFilePath;
      const serviceName = receipt.serviceName;

      if (receipt.previousUnit !== null) {
        await writeFileFn(unitFilePath, receipt.previousUnit, 'utf8');
        if (systemctl) {
          try {
            await run(systemctl, ['daemon-reload']);
            await run(systemctl, ['restart', serviceName]);
          } catch {
            // best effort restart
          }
        }
      } else {
        if (systemctl) {
          try {
            await run(systemctl, ['stop', serviceName]);
            await run(systemctl, ['disable', serviceName]);
          } catch {
            // best effort stop
          }
        }
        try {
          await rmFn(unitFilePath, { force: true });
        } catch {
          // ignore removal error
        }
        if (systemctl) {
          try {
            await run(systemctl, ['daemon-reload']);
          } catch {
            // ignore
          }
        }
      }
    }

    receipt.state = 'compensated';
    await writeFileFn(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

    return { compensated: true };
  }

  return Object.freeze({
    ensurePrerequisites,
    ensureVirtualenv,
    installRequirements,
    apply,
    inspect,
    restart,
    stop,
    compensate,
  });
}

export const pythonSiteManagerInternals = Object.freeze({
  RECEIPT_ROOT,
  RECEIPT_VERSION,
  SYSTEMD_DIR,
  RUN_ROOT,
  DATA_ROOT,
  parseProperties,
});
