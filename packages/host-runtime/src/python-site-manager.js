import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  pythonApplicationUser,
  pythonServiceName,
  pythonSocketPath,
  renderPythonEnvironmentFile,
  renderPythonSystemdUnit,
} from '@yunpanel/config-templates';
import { normalizePythonRuntimeConfig } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/python-sites';
const RECEIPT_VERSION = 1;
const RETIREMENT_CHECKPOINT_VERSION = 1;
const SYSTEMD_DIR = '/etc/systemd/system';
const RUN_ROOT = '/run/yunpanel';
const DATA_ROOT = '/var/lib/yunpanel/data';
const ENV_ROOT = '/etc/yunpanel/apps';
const INSTALL_PATH = '/usr/bin/install';
const RUNUSER_PATH = '/usr/sbin/runuser';
const GETENT_PATH = '/usr/bin/getent';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const PYTHON3_PATHS = Object.freeze(['/usr/bin/python3', 'python3']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MASKED_UNIT_FILE_STATES = new Set(['masked', 'masked-runtime']);
const NON_DISABLEABLE_UNIT_FILE_STATES = new Set(['', 'disabled', 'not-found', 'static', 'masked', 'masked-runtime']);

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

function isNotFound(error) {
  return error?.code === 'ENOENT';
}

function parseProperties(output, { strictPid = false } = {}) {
  const values = {};
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const rawPid = values.MainPID;
  const parsedPid = rawPid === undefined ? (strictPid ? Number.NaN : 0) : Number.parseInt(rawPid, 10);
  if (strictPid && (!/^\d+$/.test(String(rawPid ?? '')) || !Number.isSafeInteger(parsedPid) || parsedPid < 0)) {
    throw new PythonSiteManagerError('python_retirement_inspection_invalid', 'Managed Python service PID state is invalid');
  }
  return {
    loadState: values.LoadState || 'unknown',
    activeState: values.ActiveState || 'unknown',
    subState: values.SubState || 'unknown',
    unitFileState: values.UnitFileState ?? '',
    fragmentPath: values.FragmentPath ?? '',
    mainPid: Number.isSafeInteger(parsedPid) && parsedPid >= 0 ? parsedPid : 0,
  };
}

function parsePasswdUid(output, expectedUser) {
  const line = String(output ?? '').trim();
  const fields = line.split(':');
  if (fields.length !== 7 || fields[0] !== expectedUser) return null;
  const uid = Number.parseInt(fields[2], 10);
  if (!Number.isSafeInteger(uid) || uid < 1) return null;
  return uid;
}

function safePythonBuildEnvironment(homeDirectory, venvBin = null) {
  return {
    PATH: venvBin ? `${venvBin}:/usr/local/bin:/usr/bin:/bin` : '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDirectory,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONUNBUFFERED: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
}

export function requestPythonHealth({ port = null, socketPath = null, healthPath = '/', timeoutMs = 2_000 }) {
  if (!port && !socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    const requestOptions = {
      ...(port ? { host: '127.0.0.1', port } : { socketPath }),
      path: healthPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: { host: 'localhost', connection: 'close' },
    };
    const request = http.request(requestOptions, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

export async function defaultWaitForPythonHealth({
  port = null,
  socketPath = null,
  healthPath = '/',
  timeoutSeconds = 15,
}) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  do {
    if (await requestPythonHealth({ port, socketPath, healthPath })) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);
  return false;
}

export function createPythonSiteManager({
  receiptRoot = RECEIPT_ROOT,
  systemdDir = SYSTEMD_DIR,
  runRoot = RUN_ROOT,
  dataRoot = DATA_ROOT,
  envRoot = ENV_ROOT,
  systemctlPaths = SYSTEMCTL_PATHS,
  python3Paths = PYTHON3_PATHS,
  installPath = INSTALL_PATH,
  runuserPath = RUNUSER_PATH,
  getentPath = GETENT_PATH,
  expectedConfigUid = typeof process.getuid === 'function' ? process.getuid() : 0,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
  waitForHealth = defaultWaitForPythonHealth,
} = {}) {
  if (
    typeof run !== 'function'
    || typeof chmodFn !== 'function'
    || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function'
    || typeof renameFn !== 'function'
    || typeof rmFn !== 'function'
    || typeof writeFileFn !== 'function'
    || typeof waitForHealth !== 'function'
  ) {
    throw new PythonSiteManagerError('python_dependencies_invalid', 'Python site manager dependencies are invalid');
  }

  function managedSocketPath(applicationId) {
    return runRoot === RUN_ROOT
      ? pythonSocketPath(applicationId)
      : path.posix.join(runRoot, `python-${applicationId}.sock`);
  }

  function normalizeRetirementIntent(input = {}, { requireOperationId = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new PythonSiteManagerError('python_retirement_intent_invalid', 'Python retirement intent is invalid');
    }
    if (typeof input.websiteId !== 'string' || !UUID_PATTERN.test(input.websiteId)) {
      throw new PythonSiteManagerError('python_retirement_intent_invalid', 'Website ID is invalid');
    }
    if (typeof input.applicationId !== 'string' || !UUID_PATTERN.test(input.applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }
    const websiteId = input.websiteId.toLowerCase();
    const applicationId = input.applicationId.toLowerCase();
    const expectedUser = pythonApplicationUser(applicationId);
    if (input.unixUser !== expectedUser) {
      throw new PythonSiteManagerError('python_site_identity_mismatch', 'Unix user does not match the managed application identity');
    }
    let runtime;
    try {
      runtime = normalizePythonRuntimeConfig(input.runtime);
    } catch {
      throw new PythonSiteManagerError('python_retirement_intent_invalid', 'Python runtime intent is invalid');
    }
    let operationId = null;
    if (requireOperationId || input.operationId !== undefined && input.operationId !== null) {
      if (typeof input.operationId !== 'string' || !UUID_PATTERN.test(input.operationId)) {
        throw new PythonSiteManagerError('python_operation_invalid', 'Operation ID is invalid');
      }
      operationId = input.operationId.toLowerCase();
    }
    return Object.freeze({
      websiteId,
      applicationId,
      unixUser: expectedUser,
      runtime,
      operationId,
    });
  }

  async function pathExists(targetPath) {
    try {
      await lstatFn(targetPath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async function readOptionalFile(targetPath) {
    try {
      return await readFileFn(targetPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function removeIfPresent(targetPath, options = {}) {
    try {
      await rmFn(targetPath, { ...options, force: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async function ensureSharedRoot(rootPath) {
    try {
      const info = await lstatFn(rootPath);
      if (!info.isDirectory() || info.isSymbolicLink?.()) {
        throw new PythonSiteManagerError('python_shared_root_invalid', `Managed root is not a real directory: ${rootPath}`);
      }
      return;
    } catch (error) {
      if (error instanceof PythonSiteManagerError) throw error;
      if (!isNotFound(error)) throw error;
    }
    await mkdirFn(rootPath, { recursive: true, mode: 0o755 });
    await chmodFn(rootPath, 0o755);
  }

  async function ensureRunRoot() {
    let info = null;
    try {
      info = await lstatFn(runRoot);
      if (!info.isDirectory() || info.isSymbolicLink?.()) {
        throw new PythonSiteManagerError('python_run_root_invalid', `Managed runtime socket root is not a real directory: ${runRoot}`);
      }
    } catch (error) {
      if (error instanceof PythonSiteManagerError) throw error;
      if (!isNotFound(error)) throw error;
      await mkdirFn(runRoot, { recursive: true, mode: 0o1777 });
    }
    if (!info || (typeof info.mode === 'number' && (info.mode & 0o7777) !== 0o1777)) {
      await chmodFn(runRoot, 0o1777);
    }
  }

  async function writeManagedFile(targetPath, content, mode = 0o644) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
      await chmodFn(temporaryPath, mode);
      await renameFn(temporaryPath, targetPath);
    } catch (error) {
      try {
        await removeIfPresent(temporaryPath);
      } catch {
        // Preserve the original write/chmod/rename error.
      }
      throw error;
    }
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

  async function readSystemdServiceState(systemctl, serviceName, { strictPid = false } = {}) {
    const args = [
      'show',
      serviceName,
      '--property=MainPID,ActiveState,SubState,LoadState,UnitFileState,FragmentPath',
      '--no-pager',
    ];
    try {
      const out = await run(systemctl, args, { timeout: 10_000 });
      return parseProperties(out?.stdout ?? out, { strictPid });
    } catch (error) {
      if (typeof error?.stdout === 'string' && error.stdout.includes('LoadState=')) {
        return parseProperties(error.stdout, { strictPid });
      }
      throw new PythonSiteManagerError('python_retirement_inspection_failed', `Failed to inspect Python systemd service state: ${error.message}`);
    }
  }

  async function lookupSiteUid(unixUser) {
    let result;
    try {
      result = await run(getentPath, ['passwd', unixUser], { timeout: 5_000 });
    } catch {
      return null;
    }
    return parsePasswdUid(result?.stdout ?? result, unixUser);
  }

  async function inspectOwnedUnitFile(unitFilePath, spec) {
    let info;
    try {
      info = await lstatFn(unitFilePath);
    } catch (error) {
      if (isNotFound(error)) return Object.freeze({ present: false });
      throw error;
    }
    if (!info.isFile?.() || info.isSymbolicLink?.() || info.uid !== expectedConfigUid) {
      throw new PythonSiteManagerError('python_retirement_unit_unsafe', 'Managed Python systemd unit is not a regular owned file');
    }
    const content = await readFileFn(unitFilePath, 'utf8');
    const lines = String(content).split(/\r?\n/);
    const expectedWorkdirPrefix = `/var/lib/yunpanel/apps/${spec.applicationId}/current`;
    const expectedVenvBinPrefix = `/var/lib/yunpanel/data/${spec.applicationId}/venv/bin/`;
    const workdirLine = lines.find((line) => line.startsWith('WorkingDirectory='));
    const envLine = lines.find((line) => line.startsWith('EnvironmentFile=-'));
    const execStartLine = lines.find((line) => line.startsWith('ExecStart='));
    const hasValidWorkdir = Boolean(
      workdirLine
      && (workdirLine === `WorkingDirectory=${expectedWorkdirPrefix}`
        || workdirLine.startsWith(`WorkingDirectory=${expectedWorkdirPrefix}/`)),
    );
    const expectedEnvPath = path.posix.join(envRoot, `${spec.applicationId}.env`);
    const hasValidEnv = envLine === `EnvironmentFile=-${expectedEnvPath}`;
    const hasValidExecStart = Boolean(
      execStartLine && execStartLine.startsWith(`ExecStart=${expectedVenvBinPrefix}`),
    );
    if (
      !lines.includes(`Description=YunPanel Python application ${spec.applicationId}`)
      || !lines.includes(`User=${spec.unixUser}`)
      || !lines.includes(`Group=${spec.unixUser}`)
      || !hasValidWorkdir
      || !hasValidEnv
      || !hasValidExecStart
    ) {
      throw new PythonSiteManagerError('python_retirement_unit_ownership_mismatch', 'Managed Python systemd unit does not match the Website provisioning identity');
    }
    return Object.freeze({ present: true, sha256: sha256(content) });
  }

  async function inspectOwnedEnvFile(envFilePath, spec) {
    let info;
    try {
      info = await lstatFn(envFilePath);
    } catch (error) {
      if (isNotFound(error)) return Object.freeze({ present: false });
      throw error;
    }
    if (!info.isFile?.() || info.isSymbolicLink?.() || info.uid !== expectedConfigUid) {
      throw new PythonSiteManagerError('python_retirement_env_unsafe', 'Managed Python environment file is not a regular owned file');
    }
    const content = await readFileFn(envFilePath, 'utf8');
    const lines = String(content).split(/\r?\n/);
    if (!lines.includes(`YUNPANEL_APPLICATION_ID="${spec.applicationId}"`)) {
      throw new PythonSiteManagerError('python_retirement_env_ownership_mismatch', 'Managed Python environment file does not match the Application identity');
    }
    return Object.freeze({ present: true });
  }

  async function inspectOwnedSocketFile(socketPath, spec) {
    let info;
    try {
      info = await lstatFn(socketPath);
    } catch (error) {
      if (isNotFound(error)) return Object.freeze({ present: false });
      throw error;
    }
    if (!info.isSocket?.() || info.isSymbolicLink?.()) {
      throw new PythonSiteManagerError('python_retirement_socket_unsafe', 'Managed Python socket path is not a Unix domain socket');
    }
    const siteUid = await lookupSiteUid(spec.unixUser);
    if (siteUid === null || info.uid !== siteUid) {
      throw new PythonSiteManagerError('python_retirement_socket_ownership_mismatch', 'Managed Python socket UID does not match the Website Unix user');
    }
    return Object.freeze({ present: true, uid: info.uid });
  }

  function validateProvisioningReceipt(raw, spec, serviceName, unitFilePath) {
    if (raw === null) {
      throw new PythonSiteManagerError('python_retirement_not_owned', 'The provisioning receipt does not prove exclusive ownership of this Python service');
    }
    let receipt;
    try {
      receipt = JSON.parse(raw);
    } catch {
      throw new PythonSiteManagerError('python_retirement_not_owned', 'Python provisioning receipt is invalid');
    }
    if (
      !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.version !== RECEIPT_VERSION
      || String(receipt.operationId ?? '').toLowerCase() !== spec.operationId
      || String(receipt.websiteId ?? '').toLowerCase() !== spec.websiteId
      || String(receipt.applicationId ?? '').toLowerCase() !== spec.applicationId
      || receipt.unixUser !== spec.unixUser
      || receipt.serviceName !== serviceName
      || receipt.unitFilePath !== unitFilePath
      || receipt.mutated !== true
      || receipt.previousUnit !== null
      || typeof receipt.unitSha256 !== 'string'
      || !SHA256_PATTERN.test(receipt.unitSha256)
      || !['prepared', 'active', 'compensated'].includes(receipt.state)
    ) {
      throw new PythonSiteManagerError('python_retirement_not_owned', 'The provisioning receipt does not prove exclusive ownership of this Python service');
    }
    return Object.freeze(receipt);
  }

  function validateRetirementCheckpoint(raw, expected) {
    if (raw === null) return null;
    let checkpoint;
    try {
      checkpoint = JSON.parse(raw);
    } catch {
      throw new PythonSiteManagerError('python_retirement_checkpoint_invalid', 'Python retirement checkpoint is invalid');
    }
    if (
      !checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)
      || Object.keys(checkpoint).length !== Object.keys(expected).length + 1
      || Object.entries(expected).some(([key, value]) => checkpoint[key] !== value)
      || !['prepared', 'retired'].includes(checkpoint.state)
    ) {
      throw new PythonSiteManagerError('python_retirement_checkpoint_invalid', 'Python retirement checkpoint does not match the removal identity');
    }
    return Object.freeze(checkpoint);
  }

  async function ensurePrerequisites() {
    const python3 = await findBinary(python3Paths);
    if (!python3) {
      throw new PythonSiteManagerError('python_prerequisites_missing', 'Python 3 binary not found on host');
    }

    try {
      await run(python3, ['-m', 'venv', '--help'], { timeout: 5_000 });
      await run(python3, ['-c', 'import ensurepip'], { timeout: 5_000 });
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

    const group = unixGroup ?? unixUser;
    const dataDir = path.posix.join(dataRoot, applicationId);
    const venvPath = path.posix.join(dataDir, 'venv');
    const pythonBin = path.posix.join(venvPath, 'bin', 'python');

    const venvExists = await pathExists(pythonBin);
    if (!venvExists) {
      const python3 = await findBinary(python3Paths);
      if (!python3) {
        throw new PythonSiteManagerError('python_prerequisites_missing', 'Python 3 binary not found');
      }

      await ensureSharedRoot(dataRoot);
      try {
        await run(installPath, ['-d', '-o', unixUser, '-g', group, '-m', '0750', dataDir], { timeout: 10_000 });
      } catch (error) {
        throw new PythonSiteManagerError('python_virtualenv_failed', `Failed to prepare Python data directory: ${error.message}`);
      }

      try {
        await run(runuserPath, ['-u', unixUser, '--', python3, '-m', 'venv', venvPath], {
          cwd: dataDir,
          env: safePythonBuildEnvironment(dataDir),
          timeout: 120_000,
        });
      } catch (error) {
        throw new PythonSiteManagerError('python_virtualenv_failed', `Failed to create virtual environment: ${error.message}`);
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
    const expectedUser = pythonApplicationUser(applicationId);
    if (unixUser !== expectedUser) {
      throw new PythonSiteManagerError('python_site_identity_mismatch', 'Unix user does not match the managed application identity');
    }

    const dataDir = path.posix.join(dataRoot, applicationId);
    const venvPath = path.posix.join(dataDir, 'venv');
    const venvBin = path.posix.join(venvPath, 'bin');
    const pipBin = path.posix.join(venvBin, 'pip');
    const requirementsPath = path.posix.join(releasePath, requirementsFile);

    if (!(await pathExists(requirementsPath))) {
      return { installed: false, reason: 'requirements_file_not_found', requirementsPath };
    }

    try {
      await run(runuserPath, ['-u', unixUser, '--', pipBin, 'install', '--no-input', '--no-cache-dir', '-r', requirementsPath], {
        cwd: releasePath,
        env: safePythonBuildEnvironment(dataDir, venvBin),
        timeout: 300_000,
      });
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
    const socketPath = managedSocketPath(applicationId);

    const previousUnit = await readOptionalFile(unitFilePath);

    const unitContent = renderPythonSystemdUnit({
      applicationId,
      user: unixUser,
      group: unixGroup,
      runtime: normalizedRuntime,
      environmentFile,
    });

    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    if (!normalizedRuntime.port) {
      await ensureRunRoot();
    }

    const receiptPath = path.posix.join(receiptRoot, `${operationId}.json`);
    const receipt = {
      version: RECEIPT_VERSION,
      operationId: operationId.toLowerCase(),
      websiteId: typeof websiteId === 'string' ? websiteId.toLowerCase() : websiteId,
      applicationId: applicationId.toLowerCase(),
      unixUser,
      serviceName,
      unitFilePath,
      socketPath,
      state: 'prepared',
      previousUnit,
      unitSha256: sha256(unitContent),
      mutated: true,
      timestamp: new Date().toISOString(),
    };

    await writeManagedFile(receiptPath, JSON.stringify(receipt, null, 2), 0o600);

    await writeManagedFile(unitFilePath, unitContent, 0o644);

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

    let properties = { activeState: 'unknown', mainPid: 0 };
    try {
      properties = await readSystemdServiceState(systemctl, serviceName);
    } catch {
      // Continue if show fails
    }

    receipt.state = 'active';
    await writeManagedFile(receiptPath, JSON.stringify(receipt, null, 2), 0o600);

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
    const socketPath = managedSocketPath(applicationId);
    const systemctl = await findBinary(systemctlPaths);

    let properties = { activeState: 'inactive', subState: 'dead', loadState: 'not-found', mainPid: 0 };
    if (systemctl) {
      try {
        properties = await readSystemdServiceState(systemctl, serviceName);
      } catch {
        // service may not exist
      }
    }

    const socketExists = await pathExists(socketPath);
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

  async function restart({ applicationId, releaseId = null, runtime = null, environment = null }) {
    if (!applicationId || !UUID_PATTERN.test(applicationId)) {
      throw new PythonSiteManagerError('python_site_application_invalid', 'Application ID is invalid');
    }

    const normalizedRuntime = runtime ? normalizePythonRuntimeConfig(runtime) : null;
    if (normalizedRuntime && environment && typeof environment === 'object' && !Array.isArray(environment)) {
      const envContent = renderPythonEnvironmentFile({
        applicationId,
        runtime: normalizedRuntime,
        environment,
      });
      await mkdirFn(envRoot, { recursive: true, mode: 0o700 });
      await writeManagedFile(path.posix.join(envRoot, `${applicationId}.env`), envContent, 0o600);
    }

    const serviceName = pythonServiceName(applicationId);
    const socketPath = managedSocketPath(applicationId);
    const systemctl = await findBinary(systemctlPaths);
    if (!systemctl) {
      throw new PythonSiteManagerError('python_systemctl_missing', 'systemctl binary not found');
    }

    await run(systemctl, ['restart', serviceName]);

    if (normalizedRuntime) {
      const healthy = await waitForHealth({
        port: normalizedRuntime.port ?? null,
        socketPath: normalizedRuntime.port ? null : socketPath,
        healthPath: normalizedRuntime.healthPath,
        timeoutSeconds: normalizedRuntime.healthTimeoutSeconds,
      });
      const inspected = await inspect({ applicationId, releaseId });
      if (!healthy || !inspected.active) {
        throw new PythonSiteManagerError('python_service_unhealthy', 'Python application did not pass health check after restart');
      }
      return {
        ...inspected,
        restarted: true,
        healthy: true,
      };
    }

    const inspected = await inspect({ applicationId, releaseId });
    if (!inspected.active) {
      throw new PythonSiteManagerError('python_service_unhealthy', 'Python application service is not active after restart');
    }
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

  async function inspectRetirement(rawIntent) {
    const spec = normalizeRetirementIntent(rawIntent);
    const serviceName = pythonServiceName(spec.applicationId);
    const unitFilePath = path.posix.join(systemdDir, serviceName);
    const socketPath = managedSocketPath(spec.applicationId);
    const envFilePath = path.posix.join(envRoot, `${spec.applicationId}.env`);

    const unitFileRemoved = !(await pathExists(unitFilePath));
    const socketRemoved = !(await pathExists(socketPath));
    const envFileRemoved = !(await pathExists(envFilePath));

    const systemctl = await findBinary(systemctlPaths);
    if (!systemctl) {
      throw new PythonSiteManagerError('python_systemctl_missing', 'systemctl binary not found');
    }

    const serviceProps = await readSystemdServiceState(systemctl, serviceName, { strictPid: true });
    const serviceMasked = serviceProps.loadState === 'masked' || MASKED_UNIT_FILE_STATES.has(serviceProps.unitFileState);
    const serviceInactive = serviceProps.activeState === 'inactive';
    const serviceUnloaded = serviceProps.loadState === 'not-found';
    const unitFileStateAbsent = serviceProps.unitFileState === '' || serviceProps.unitFileState === 'not-found';
    const fragmentAbsent = serviceProps.fragmentPath === '';
    const mainPidZero = serviceProps.mainPid === 0;

    const satisfied = unitFileRemoved
      && socketRemoved
      && envFileRemoved
      && !serviceMasked
      && serviceInactive
      && serviceUnloaded
      && unitFileStateAbsent
      && fragmentAbsent
      && mainPidZero;

    return Object.freeze({
      satisfied,
      ...(serviceMasked ? { reason: 'python_service_masked' } : {}),
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      unixUser: spec.unixUser,
      serviceName,
      unitFileRemoved,
      socketRemoved,
      envFileRemoved,
      serviceInactive,
      serviceUnloaded,
      serviceMasked,
      mainPid: serviceProps.mainPid,
      serviceLoadState: serviceProps.loadState,
      serviceActiveState: serviceProps.activeState,
      unitFileState: serviceProps.unitFileState,
      fragmentPath: serviceProps.fragmentPath,
    });
  }

  async function retire(rawIntent) {
    const spec = normalizeRetirementIntent(rawIntent, { requireOperationId: true });
    const serviceName = pythonServiceName(spec.applicationId);
    const unitFilePath = path.posix.join(systemdDir, serviceName);
    const socketPath = managedSocketPath(spec.applicationId);
    const envFilePath = path.posix.join(envRoot, `${spec.applicationId}.env`);
    const receiptPath = path.posix.join(receiptRoot, `${spec.operationId}.json`);
    const checkpointPath = path.posix.join(receiptRoot, `${spec.operationId}.retirement.json`);

    const receipt = validateProvisioningReceipt(
      await readOptionalFile(receiptPath),
      spec,
      serviceName,
      unitFilePath,
    );

    const expectedCheckpoint = Object.freeze({
      version: RETIREMENT_CHECKPOINT_VERSION,
      operationId: spec.operationId,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      unixUser: spec.unixUser,
      serviceName,
      unitFilePath,
    });
    let checkpoint = validateRetirementCheckpoint(await readOptionalFile(checkpointPath), expectedCheckpoint);

    const systemctl = await findBinary(systemctlPaths);
    if (!systemctl) {
      throw new PythonSiteManagerError('python_systemctl_missing', 'systemctl binary not found');
    }

    const beforeService = await readSystemdServiceState(systemctl, serviceName, { strictPid: true });
    const beforeMasked = beforeService.loadState === 'masked' || MASKED_UNIT_FILE_STATES.has(beforeService.unitFileState);
    if (beforeMasked) {
      throw new PythonSiteManagerError('python_retirement_service_masked', 'Managed Python systemd service is masked and cannot be retired automatically');
    }
    if (beforeService.mainPid !== 0 && beforeService.activeState === 'inactive') {
      throw new PythonSiteManagerError('python_retirement_inspection_invalid', 'Managed Python service process state is inconsistent');
    }
    if (beforeService.loadState !== 'not-found' && beforeService.fragmentPath !== unitFilePath) {
      throw new PythonSiteManagerError('python_retirement_fragment_mismatch', 'Loaded Python systemd unit FragmentPath does not match the managed unit path');
    }

    const unitInfo = await inspectOwnedUnitFile(unitFilePath, spec);
    const envInfo = await inspectOwnedEnvFile(envFilePath, spec);
    const socketInfo = await inspectOwnedSocketFile(socketPath, spec);

    const anyHostPresence = unitInfo.present
      || envInfo.present
      || socketInfo.present
      || beforeService.loadState !== 'not-found'
      || beforeService.activeState !== 'inactive'
      || beforeService.mainPid !== 0
      || beforeService.fragmentPath !== ''
      || (beforeService.unitFileState !== '' && beforeService.unitFileState !== 'not-found');

    if (checkpoint?.state === 'retired' || receipt.state === 'compensated') {
      if (anyHostPresence) {
        throw new PythonSiteManagerError('python_retirement_drift', 'A Python runtime artifact or service reappeared after its ownership was retired');
      }
      const verified = await inspectRetirement(spec);
      if (!verified.satisfied) {
        throw new PythonSiteManagerError('python_retirement_unverified', 'Python runtime retirement absence could not be verified');
      }
      return verified;
    }

    if (!checkpoint) {
      await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
      checkpoint = Object.freeze({ ...expectedCheckpoint, state: 'prepared' });
      await writeManagedFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 0o600);
    }

    if (beforeService.activeState !== 'inactive' || beforeService.mainPid !== 0) {
      await run(systemctl, ['stop', serviceName]);
      let stoppedState = await readSystemdServiceState(systemctl, serviceName, { strictPid: true });
      if (stoppedState.activeState === 'failed' && stoppedState.mainPid === 0) {
        await run(systemctl, ['reset-failed', serviceName]);
        stoppedState = await readSystemdServiceState(systemctl, serviceName, { strictPid: true });
      }
      if (stoppedState.activeState !== 'inactive' || stoppedState.mainPid !== 0) {
        throw new PythonSiteManagerError('python_retirement_stop_unconfirmed', 'Managed Python service remained active after stop');
      }
    }

    if (!NON_DISABLEABLE_UNIT_FILE_STATES.has(beforeService.unitFileState)) {
      await run(systemctl, ['disable', serviceName]);
    }

    if (unitInfo.present) await removeIfPresent(unitFilePath);
    if (socketInfo.present) await removeIfPresent(socketPath);
    if (envInfo.present) await removeIfPresent(envFilePath);

    if (anyHostPresence) {
      await run(systemctl, ['daemon-reload']);
      try { await run(systemctl, ['reset-failed', serviceName]); } catch { /* not-loaded is expected */ }
    }

    const after = await inspectRetirement(spec);
    if (!after.satisfied) {
      throw new PythonSiteManagerError('python_retirement_unverified', 'Python runtime unit, socket, environment file, or systemd state is still present');
    }

    await writeManagedFile(
      checkpointPath,
      `${JSON.stringify({ ...expectedCheckpoint, state: 'retired' }, null, 2)}\n`,
      0o600,
    );

    return after;
  }

  async function compensate({ operationId, applicationId }) {
    if (!operationId || !UUID_PATTERN.test(operationId)) {
      throw new PythonSiteManagerError('python_operation_invalid', 'Operation ID is invalid');
    }

    const receiptPath = path.posix.join(receiptRoot, `${operationId}.json`);
    const receiptContent = await readOptionalFile(receiptPath);
    if (receiptContent === null) {
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
      const socketPath = receipt.socketPath ?? (applicationId && UUID_PATTERN.test(applicationId) ? managedSocketPath(applicationId) : null);

      if (receipt.previousUnit !== null) {
        await writeManagedFile(unitFilePath, receipt.previousUnit, 0o644);
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
          try { await run(systemctl, ['stop', serviceName]); } catch { /* best effort stop */ }
          try { await run(systemctl, ['disable', serviceName]); } catch { /* best effort disable */ }
        }
        await removeIfPresent(unitFilePath);
        if (socketPath) {
          await removeIfPresent(socketPath);
        }
        if (systemctl) {
          await run(systemctl, ['daemon-reload']);
          try { await run(systemctl, ['reset-failed', serviceName]); } catch { /* not-loaded is expected */ }
        }
      }
    }

    receipt.state = 'compensated';
    await writeManagedFile(receiptPath, JSON.stringify(receipt, null, 2), 0o600);

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
    retire,
    inspectRetirement,
    compensate,
  });
}

export const pythonSiteManagerInternals = Object.freeze({
  RECEIPT_ROOT,
  RECEIPT_VERSION,
  RETIREMENT_CHECKPOINT_VERSION,
  SYSTEMD_DIR,
  RUN_ROOT,
  DATA_ROOT,
  ENV_ROOT,
  INSTALL_PATH,
  RUNUSER_PATH,
  GETENT_PATH,
  parseProperties,
  parsePasswdUid,
  safePythonBuildEnvironment,
  requestPythonHealth,
  defaultWaitForPythonHealth,
});
