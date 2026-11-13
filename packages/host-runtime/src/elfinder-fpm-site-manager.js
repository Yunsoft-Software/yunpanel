import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  elFinderFpmPoolPath,
  elFinderFpmSocketPath,
  elFinderFpmTemplatePolicy,
  previewElFinderFpmPool,
  renderElFinderFpmPool,
  resolveElFinderFpmRuntime,
} from '@yunpanel/config-templates';
import { createApplicationIdentity } from './application-identity.js';
import { resolvePhpFpmBinaryPath, resolvePhpFpmPackageName } from './os-platform.js';
import { createWebsiteIdentityPathManager } from './website-identity-path-manager.js';

const execFileAsync = promisify(execFile);
const DPKG_QUERY_PATH = '/usr/bin/dpkg-query';
const APT_GET_PATH = '/usr/bin/apt-get';
const PHP_FPM_BINARY = '/usr/sbin/php-fpm8.3';
const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const SS_PATH = '/usr/bin/ss';
const ID_PATH = '/usr/bin/id';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/elfinder-fpm-sites';
const PACKAGE_NAME = 'php8.3-fpm';
const RECEIPT_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_STATES = new Set(['prepared', 'active', 'compensated']);
const RETIREMENT_STATES = new Set(['prepared', 'reload_started', 'retired']);
const MAX_RETIREMENT_BYTES = 1024 * 1024;
const RETIREMENT_TIMEOUT_MS = 60_000;

export class ElFinderFpmSiteManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElFinderFpmSiteManagerError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function normalizeOperationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_operation_invalid',
      'elFinder FPM operation id is invalid',
    );
  }
  return value.toLowerCase();
}

function normalizeIntent(value, defaultRuntimeOptions = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['websiteId', 'applicationId', 'unixUser', 'phpVersion', 'osPlatform'].includes(key))
    || typeof value.websiteId !== 'string' || !UUID_PATTERN.test(value.websiteId)) {
    throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_site_intent_invalid',
      'elFinder FPM Website intent is invalid',
    );
  }

  let identity;
  try { identity = createApplicationIdentity(value.applicationId); }
  catch {
    throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_application_invalid',
      'elFinder FPM Application identity is invalid',
    );
  }
  if (value.unixUser !== identity.unixUser) {
    throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_identity_mismatch',
      'elFinder FPM Website Unix identity does not match the Application',
    );
  }

  const effectivePhpVersion = value.phpVersion ?? defaultRuntimeOptions.phpVersion;
  const effectiveOsPlatform = value.osPlatform ?? defaultRuntimeOptions.osPlatform;
  const runtime = resolveElFinderFpmRuntime({
    phpVersion: effectivePhpVersion,
    osPlatform: effectiveOsPlatform,
  });

  const templateInput = Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    applicationId: identity.applicationId,
    unixUser: identity.unixUser,
    unixGroup: identity.unixUser,
    homeDirectory: identity.paths.workspace.homeDirectory,
    temporaryDirectory: identity.paths.workspace.temporaryDirectory,
    ...(effectivePhpVersion === undefined ? {} : { phpVersion: effectivePhpVersion }),
    ...(effectiveOsPlatform === undefined ? {} : { osPlatform: effectiveOsPlatform }),
  });
  let preview;
  try { preview = previewElFinderFpmPool(templateInput); }
  catch {
    throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_policy_invalid',
      'elFinder FPM Website policy is invalid',
    );
  }
  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    applicationId: identity.applicationId,
    unixUser: identity.unixUser,
    identity,
    runtime,
    templateInput,
    preview,
  });
}

function specDigest(spec) {
  return sha256(JSON.stringify({
    version: 1,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    unixUser: spec.unixUser,
    configSha256: spec.preview.sha256,
    socketPath: spec.preview.socketPath,
  }));
}

function normalizeReceipt(value, { operationId, spec } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== RECEIPT_VERSION
    || value.operationId !== operationId
    || value.websiteId !== spec.websiteId
    || value.applicationId !== spec.applicationId
    || value.unixUser !== spec.unixUser
    || value.specDigest !== specDigest(spec)
    || value.configSha256 !== spec.preview.sha256
    || typeof value.mutated !== 'boolean'
    || (value.previousConfig !== null && typeof value.previousConfig !== 'string')
    || !RECEIPT_STATES.has(value.state)) {
    throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_receipt_invalid',
      'elFinder FPM operation receipt is invalid',
    );
  }
  return Object.freeze({
    version: RECEIPT_VERSION,
    operationId,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    unixUser: spec.unixUser,
    specDigest: value.specDigest,
    configSha256: value.configSha256,
    mutated: value.mutated,
    previousConfig: value.previousConfig,
    state: value.state,
  });
}

function listenerMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4
    || typeof value.path !== 'string' || value.path.length > 4096
    || !/^\/[A-Za-z0-9._/-]+$/.test(value.path) || value.path === '/'
    || path.posix.normalize(value.path) !== value.path
    || !['uid', 'gid', 'mode'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.mode > 0o777) {
    throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_invalid',
      'The shared FPM listener checkpoint is invalid');
  }
  return Object.freeze({ path: value.path, uid: value.uid, gid: value.gid, mode: value.mode });
}

function retirementBinding(operationId, spec) {
  return { version: 1, operationId, websiteId: spec.websiteId, applicationId: spec.applicationId,
    unixUser: spec.unixUser, specDigest: specDigest(spec), configSha256: spec.preview.sha256,
    serviceUnit: spec.runtime.serviceUnit, socketPath: spec.preview.socketPath };
}

function normalizeRetirementCheckpoint(value, { operationId, spec } = {}) {
  const expected = retirementBinding(operationId, spec);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== Object.keys(expected).length + 7
    || Object.entries(expected).some(([key, entry]) => value[key] !== entry)
    || !RETIREMENT_STATES.has(value.state) || typeof value.wasActive !== 'boolean'
    || typeof value.reloadAttempted !== 'boolean'
    || !['socketUid', 'socketGid', 'mainPid'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || (value.wasActive ? value.mainPid < 1 : value.mainPid !== 0)
    || (value.state === 'prepared' && value.reloadAttempted)
    || (value.state === 'reload_started' && !value.reloadAttempted)
    || (value.reloadAttempted && !value.wasActive)
    || !Array.isArray(value.protectedListeners) || value.protectedListeners.length > 4096
    || (!value.wasActive && value.protectedListeners.length !== 0)) {
    throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_invalid',
      'FPM retirement no longer matches its durable deletion checkpoint');
  }
  const listeners = value.protectedListeners.map(listenerMetadata);
  if (listeners.some(entry => entry.path === spec.preview.socketPath)
    || new Set(listeners.map(entry => entry.path)).size !== listeners.length
    || listeners.some((entry, index) => index > 0 && entry.path <= listeners[index - 1].path)) {
    throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_invalid',
      'FPM retirement requires an exact distinct sibling listener checkpoint');
  }
  return Object.freeze({ ...expected, state: value.state, wasActive: value.wasActive,
    reloadAttempted: value.reloadAttempted, mainPid: value.mainPid,
    socketUid: value.socketUid, socketGid: value.socketGid,
    protectedListeners: Object.freeze(listeners) });
}

function missingPath(error) {
  return error?.code === 'ENOENT';
}

function missingPackage(error) {
  return Number.isInteger(error?.code) && error.code === 1;
}

export function createElFinderFpmSiteManager({
  receiptRoot = RECEIPT_ROOT,
  identityManager = createWebsiteIdentityPathManager(),
  phpVersion,
  osPlatform,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: 1024 * 1024,
    env: options.env,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (!identityManager || typeof identityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function'
    || typeof renameFn !== 'function' || typeof rmFn !== 'function'
    || typeof writeFileFn !== 'function') {
    throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_dependencies_invalid',
      'elFinder FPM manager dependencies are invalid',
    );
  }

  const defaultRuntimeOptions = Object.freeze({ phpVersion, osPlatform });
  const defaultRuntime = resolveElFinderFpmRuntime(defaultRuntimeOptions);

  function receiptPath(operationId) {
    return path.posix.join(receiptRoot, `${operationId}.json`);
  }

  async function atomicWrite(targetPath, value, mode) {
    const temporary = `${targetPath}.${process.pid}.tmp`;
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, value, { encoding: 'utf8', mode });
      await renameFn(temporary, targetPath);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function readOptional(target) {
    try { return await readFileFn(target, 'utf8'); }
    catch (error) {
      if (missingPath(error)) return null;
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_config_unavailable',
        'elFinder FPM pool configuration could not be read',
      );
    }
  }

  async function loadReceipt(operationId, spec) {
    let raw;
    try { raw = await readFileFn(receiptPath(operationId), 'utf8'); }
    catch (error) {
      if (missingPath(error)) return null;
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_receipt_unavailable',
        'elFinder FPM operation receipt could not be read',
      );
    }
    try { return normalizeReceipt(JSON.parse(raw), { operationId, spec }); }
    catch (error) {
      if (error instanceof ElFinderFpmSiteManagerError) throw error;
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_receipt_invalid',
        'elFinder FPM operation receipt is invalid',
      );
    }
  }

  async function persistReceipt(operationId, spec, value) {
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    const receipt = {
      version: RECEIPT_VERSION,
      operationId,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      unixUser: spec.unixUser,
      specDigest: specDigest(spec),
      configSha256: spec.preview.sha256,
      mutated: value.mutated,
      previousConfig: value.previousConfig,
      state: value.state,
    };
    await atomicWrite(receiptPath(operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return normalizeReceipt(receipt, { operationId, spec });
  }

  function packageNameFor(runtime = defaultRuntime) {
    return resolvePhpFpmPackageName(runtime.phpVersion, { family: runtime.family });
  }

  function binaryPathFor(runtime = defaultRuntime) {
    return resolvePhpFpmBinaryPath(runtime.phpVersion, { family: runtime.family });
  }

  async function inspectPackage(runtime = defaultRuntime) {
    const pkg = packageNameFor(runtime);
    try {
      const result = await run(DPKG_QUERY_PATH, ['-W', '-f=${Status}\t${Version}', pkg], {
        timeout: 10_000,
      });
      const output = String(result?.stdout ?? '').trim();
      const match = output.match(/^install ok installed\t([^\s]+)$/);
      return Object.freeze({ installed: Boolean(match), version: match?.[1] ?? null });
    } catch (error) {
      if (missingPackage(error)) return Object.freeze({ installed: false, version: null });
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_package_inspection_failed',
        'elFinder PHP-FPM package state could not be inspected',
      );
    }
  }

  async function ensurePackage(runtime = defaultRuntime) {
    const before = await inspectPackage(runtime);
    if (before.installed) return before;
    const pkg = packageNameFor(runtime);
    try {
      await run(APT_GET_PATH, ['install', '--yes', '--no-install-recommends', pkg], {
        timeout: 10 * 60_000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_package_install_failed',
        'elFinder PHP-FPM package could not be installed',
      );
    }
    const after = await inspectPackage(runtime);
    if (!after.installed) {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_package_install_unverified',
        'elFinder PHP-FPM package installation could not be verified',
      );
    }
    return after;
  }

  async function configTest(runtime = defaultRuntime, timeout = 30_000) {
    try { await run(binaryPathFor(runtime), ['--test'], { timeout }); }
    catch {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_config_test_failed',
        'elFinder PHP-FPM configuration test failed',
      );
    }
  }

  async function serviceActive(runtime = defaultRuntime) {
    try {
      await run(SYSTEMCTL_PATH, ['is-active', '--quiet', runtime.serviceUnit], {
        timeout: 10_000,
      });
      return true;
    } catch { return false; }
  }

  async function activateService(runtime = defaultRuntime) {
    try {
      await run(SYSTEMCTL_PATH, ['enable', '--now', runtime.serviceUnit], {
        timeout: 60_000,
      });
      await run(SYSTEMCTL_PATH, ['reload', runtime.serviceUnit], {
        timeout: 30_000,
      });
    } catch {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_service_activation_failed',
        'PHP-FPM could not activate the elFinder Website pool',
      );
    }
  }

  async function reloadServiceIfActive(runtime = defaultRuntime) {
    if (!(await serviceActive(runtime))) return;
    try {
      await run(SYSTEMCTL_PATH, ['reload', runtime.serviceUnit], {
        timeout: 30_000,
      });
    } catch {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_service_reload_failed',
        'PHP-FPM could not reload restored elFinder configuration',
      );
    }
  }

  async function inspectIdentity(spec) {
    const result = await identityManager.inspect({
      user: spec.unixUser,
      homeDirectory: spec.identity.paths.workspace.homeDirectory,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
    });
    if (!result?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: result?.reason ?? 'website_identity_unverified',
      });
    }
    if (result.user !== spec.unixUser
      || result.homeDirectory !== spec.identity.paths.workspace.homeDirectory
      || !Number.isSafeInteger(result.uid) || result.uid < 1
      || !Number.isSafeInteger(result.gid) || result.gid < 1
      || result.homeMode !== 0o750) {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_identity_drift',
        'elFinder FPM Website identity does not match canonical managed state',
      );
    }
    return result;
  }

  async function inspect(rawIntent) {
    const spec = normalizeIntent(rawIntent, defaultRuntimeOptions);
    const identity = await inspectIdentity(spec);
    if (!identity.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'elfinder_fpm_identity_unavailable',
        identityReason: identity.reason,
        adapter: 'elfinder-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }

    const packageState = await inspectPackage(spec.runtime);
    if (!packageState.installed) {
      return Object.freeze({
        satisfied: false,
        reason: 'elfinder_fpm_package_missing',
        adapter: 'elfinder-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }

    const configPath = spec.preview.artifact.path;
    let configInfo;
    let config;
    try {
      [configInfo, config] = await Promise.all([
        lstatFn(configPath),
        readFileFn(configPath, 'utf8'),
      ]);
    } catch (error) {
      if (missingPath(error)) {
        return Object.freeze({
          satisfied: false,
          reason: 'elfinder_fpm_pool_missing',
          adapter: 'elfinder-fpm',
          websiteId: spec.websiteId,
          applicationId: spec.applicationId,
          configPath,
        });
      }
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_config_unavailable',
        'elFinder FPM pool could not be inspected',
      );
    }
    if (!configInfo?.isFile?.() || configInfo.isSymbolicLink?.()
      || configInfo.uid !== 0 || configInfo.gid !== 0
      || modeOf(configInfo) !== elFinderFpmTemplatePolicy.poolMode) {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_pool_drift',
        'elFinder FPM pool ownership or mode has drifted',
      );
    }
    if (sha256(config) !== spec.preview.sha256) {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_pool_drift',
        'elFinder FPM pool content has drifted',
      );
    }

    try { await configTest(spec.runtime); }
    catch {
      return Object.freeze({
        satisfied: false,
        reason: 'elfinder_fpm_config_invalid',
        adapter: 'elfinder-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }
    if (!(await serviceActive(spec.runtime))) {
      return Object.freeze({
        satisfied: false,
        reason: 'elfinder_fpm_service_inactive',
        adapter: 'elfinder-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }

    const socketPath = spec.preview.socketPath;
    let socketInfo;
    try { socketInfo = await lstatFn(socketPath); }
    catch (error) {
      if (missingPath(error)) {
        return Object.freeze({
          satisfied: false,
          reason: 'elfinder_fpm_socket_missing',
          adapter: 'elfinder-fpm',
          websiteId: spec.websiteId,
          applicationId: spec.applicationId,
          socketPath,
        });
      }
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_socket_unavailable',
        'elFinder FPM socket could not be inspected',
      );
    }
    if (!socketInfo?.isSocket?.() || modeOf(socketInfo) !== 0o660) {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_socket_drift',
        'elFinder FPM socket type or mode has drifted',
      );
    }

    return Object.freeze({
      satisfied: true,
      adapter: 'elfinder-fpm',
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      phpVersion: spec.runtime.phpVersion,
      packageVersion: packageState.version,
      unixUser: spec.unixUser,
      unixUid: identity.uid,
      unixGid: identity.gid,
      root: spec.preview.root,
      configPath,
      configSha256: spec.preview.sha256,
      socketPath,
      serviceUnit: spec.runtime.serviceUnit,
      connectorPath: elFinderFpmTemplatePolicy.connectorPath,
    });
  }

  async function restoreConfig(spec, receipt) {
    if (!receipt.mutated) return;
    const configPath = spec.preview.artifact.path;
    if (receipt.previousConfig === null) {
      await rmFn(configPath, { force: true });
    } else {
      await atomicWrite(configPath, receipt.previousConfig, elFinderFpmTemplatePolicy.poolMode);
    }
    await configTest(spec.runtime);
    await reloadServiceIfActive(spec.runtime);
  }

  async function apply(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent, defaultRuntimeOptions);
    const operationId = normalizeOperationId(rawOperationId);
    const identity = await inspectIdentity(spec);
    if (!identity.satisfied) {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_identity_required',
        'Website Unix identity and workspace must be ready before elFinder FPM provisioning',
      );
    }

    await ensurePackage(spec.runtime);
    await mkdirFn(spec.runtime.poolDirectory, { recursive: true, mode: 0o755 });
    const configPath = spec.preview.artifact.path;
    const desired = renderElFinderFpmPool(spec.templateInput);
    let receipt = await loadReceipt(operationId, spec);
    const current = await readOptional(configPath);

    if (receipt?.state === 'compensated') {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_operation_compensated',
        'Compensated elFinder FPM operation cannot be re-applied',
      );
    }

    if (!receipt) {
      if (current !== null && sha256(current) !== spec.preview.sha256) {
        throw new ElFinderFpmSiteManagerError(
          'elfinder_fpm_pool_conflict',
          'Existing elFinder FPM pool is not owned by this operation',
        );
      }
      receipt = await persistReceipt(operationId, spec, {
        mutated: current === null,
        previousConfig: current,
        state: current === null ? 'prepared' : 'active',
      });
    }

    if (receipt.state === 'active') {
      const existing = await inspect(rawIntent);
      if (existing.satisfied) return Object.freeze({ ...existing, created: receipt.mutated });
    }

    const currentAfterReceipt = await readOptional(configPath);
    if (receipt.mutated) {
      const acceptable = currentAfterReceipt === null
        || sha256(currentAfterReceipt) === receipt.configSha256;
      if (!acceptable) {
        throw new ElFinderFpmSiteManagerError(
          'elfinder_fpm_pool_drift',
          'elFinder FPM pool changed after durable operation checkpoint',
        );
      }
      await atomicWrite(configPath, desired, elFinderFpmTemplatePolicy.poolMode);
    }

    try {
      await configTest(spec.runtime);
      await activateService(spec.runtime);
      const verified = await inspect(rawIntent);
      if (!verified.satisfied) {
        throw new ElFinderFpmSiteManagerError(
          'elfinder_fpm_apply_unverified',
          'elFinder FPM pool activation could not be verified',
        );
      }
      receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'active' });
      return Object.freeze({ ...verified, created: receipt.mutated });
    } catch (error) {
      if (receipt.mutated) {
        try { await restoreConfig(spec, receipt); } catch { /* keep primary failure */ }
      }
      if (error instanceof ElFinderFpmSiteManagerError) throw error;
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_apply_failed',
        'elFinder FPM pool activation failed',
      );
    }
  }

  async function inspectCompensation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent, defaultRuntimeOptions);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReceipt(operationId, spec);
    if (!receipt || !receipt.mutated) {
      return Object.freeze({
        satisfied: true,
        restoredPrevious: false,
        preservedExisting: true,
      });
    }
    if (receipt.state === 'compensated') {
      return Object.freeze({
        satisfied: true,
        restoredPrevious: receipt.previousConfig !== null,
        preservedExisting: false,
      });
    }
    const current = await readOptional(spec.preview.artifact.path);
    if (receipt.previousConfig === null && current === null) {
      return Object.freeze({
        satisfied: true,
        restoredPrevious: false,
        preservedExisting: false,
      });
    }
    if (receipt.previousConfig !== null && current !== null && current === receipt.previousConfig) {
      return Object.freeze({
        satisfied: true,
        restoredPrevious: true,
        preservedExisting: false,
      });
    }
    return Object.freeze({
      satisfied: false,
      reason: current !== null && sha256(current) !== receipt.configSha256
        ? 'elfinder_fpm_compensation_drift'
        : 'elfinder_fpm_compensation_pending',
      restoredPrevious: false,
      preservedExisting: false,
    });
  }

  async function compensate(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent, defaultRuntimeOptions);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadReceipt(operationId, spec);
    if (!receipt || !receipt.mutated) {
      return Object.freeze({
        satisfied: true,
        restoredPrevious: false,
        preservedExisting: true,
      });
    }
    if (receipt.state === 'compensated') {
      return inspectCompensation(rawIntent, { operationId });
    }

    const before = await inspectCompensation(rawIntent, { operationId });
    if (before.satisfied) {
      receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'compensated' });
      return Object.freeze({ ...before, receiptState: receipt.state });
    }
    if (before.reason === 'elfinder_fpm_compensation_drift') {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_compensation_drift',
        'elFinder FPM pool changed after the operation and cannot be safely restored',
      );
    }

    await restoreConfig(spec, receipt);
    receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'compensated' });
    const after = await inspectCompensation(rawIntent, { operationId });
    if (!after.satisfied) {
      throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_compensation_unverified',
        'elFinder FPM compensation could not be verified',
      );
    }
    return Object.freeze({ ...after, receiptState: receipt.state });
  }

  function retirementDeadline() {
    const started = performance.now(), end = started + RETIREMENT_TIMEOUT_MS;
    return { started,
      left(maximum = 10_000) {
        const remaining = Math.ceil(end - performance.now());
        if (remaining <= 0) throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_timeout',
          'FPM retirement could not verify listener readiness within its deadline');
        return Math.min(maximum, remaining);
      } };
  }

  async function trustedRetirementRoot({ allowMissing = false } = {}) {
    if (typeof receiptRoot !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(receiptRoot)
      || path.posix.normalize(receiptRoot) !== receiptRoot || receiptRoot === '/') {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_invalid',
        'FPM retirement requires its private canonical receipt directory');
    }
    try {
      const ancestors = [];
      for (let current = receiptRoot; ; current = path.posix.dirname(current)) {
        ancestors.unshift(current); if (current === '/') break;
      }
      for (const current of ancestors) {
        let metadata;
        try { metadata = await lstat(current); }
        catch (error) { if (allowMissing && missingPath(error)) return false; throw error; }
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0
          || metadata.gid !== 0 || (modeOf(metadata) & 0o022) !== 0
          || await realpath(current) !== current) throw new Error('directory');
      }
      return true;
    } catch {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_invalid',
        'FPM retirement receipt directory ownership could not be verified');
    }
  }

  async function loadRetirementCheckpoint(operationId, spec, deadline) {
    deadline.left(); const exists = await trustedRetirementRoot({ allowMissing: true }); deadline.left();
    if (!exists) return null;
    const target = path.posix.join(receiptRoot, `${operationId}.retirement.json`);
    let handle, primaryError = null;
    try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (missingPath(error)) return null;
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_invalid',
        'FPM retirement checkpoint could not be safely opened');
    }
    try {
      const before = await handle.stat({ bigint: true });
      const same = (other) => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
        .every(key => before[key] === other[key]);
      if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n
        || modeOf(before) !== 0o600 || before.size > BigInt(MAX_RETIREMENT_BYTES)) throw new Error('metadata');
      const buffer = Buffer.alloc(MAX_RETIREMENT_BYTES + 1); let bytes = 0;
      while (bytes < buffer.length) {
        deadline.left(); const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
      }
      if (bytes > MAX_RETIREMENT_BYTES || BigInt(bytes) !== before.size
        || !same(await handle.stat({ bigint: true })) || !same(await lstat(target, { bigint: true }))) throw new Error('identity');
      deadline.left();
      return normalizeRetirementCheckpoint(JSON.parse(buffer.subarray(0, bytes).toString('utf8')), { operationId, spec });
    } catch (error) {
      primaryError = error instanceof ElFinderFpmSiteManagerError ? error
        : new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_invalid', 'FPM retirement checkpoint is invalid or changed during its bounded read');
      throw primaryError;
    } finally {
      try { await handle.close(); }
      catch { if (!primaryError) throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_unavailable', 'The FPM retirement checkpoint descriptor could not be closed'); }
    }
  }

  async function persistRetirementCheckpoint(operationId, spec, value, deadline) {
    deadline.left(); await trustedRetirementRoot();
    const normalized = normalizeRetirementCheckpoint(value, { operationId, spec });
    const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`), target = path.posix.join(receiptRoot, `${operationId}.retirement.json`);
    if (bytes.length > MAX_RETIREMENT_BYTES) throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_retirement_checkpoint_invalid', 'The FPM retirement checkpoint exceeds its bound');
    const temporary = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    let directory, handle, renamed = false, primaryError = null;
    try {
      deadline.left(); directory = await open(receiptRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const parent = await directory.stat({ bigint: true });
      if (!parent.isDirectory() || parent.uid !== 0n || parent.gid !== 0n || (modeOf(parent) & 0o022) !== 0) throw new Error('directory');
      deadline.left(); handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.uid !== 0n || metadata.gid !== 0n || metadata.nlink !== 1n || modeOf(metadata) !== 0o600) throw new Error('metadata');
      deadline.left(); await handle.writeFile(bytes); deadline.left(); await handle.sync();
      metadata = await handle.stat({ bigint: true });
      if (metadata.size !== BigInt(bytes.length) || metadata.nlink !== 1n || metadata.uid !== 0n || metadata.gid !== 0n || modeOf(metadata) !== 0o600) throw new Error('written');
      const currentParent = await lstat(receiptRoot, { bigint: true });
      if (!currentParent.isDirectory() || currentParent.isSymbolicLink() || currentParent.dev !== parent.dev
        || currentParent.ino !== parent.ino || currentParent.uid !== parent.uid || currentParent.gid !== parent.gid
        || currentParent.mode !== parent.mode) throw new Error('directory identity');
      deadline.left(); await rename(temporary, target); renamed = true;
      const current = await lstat(target, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino
        || current.uid !== metadata.uid || current.gid !== metadata.gid || current.mode !== metadata.mode
        || current.size !== metadata.size || current.nlink !== 1n) throw new Error('renamed identity');
      deadline.left(); await directory.sync();
      const finalParent = await lstat(receiptRoot, { bigint: true });
      if (!finalParent.isDirectory() || finalParent.isSymbolicLink() || finalParent.dev !== parent.dev
        || finalParent.ino !== parent.ino || finalParent.uid !== parent.uid || finalParent.gid !== parent.gid
        || finalParent.mode !== parent.mode) throw new Error('directory identity after sync');
      deadline.left();
      return normalized;
    } catch (error) {
      primaryError = error instanceof ElFinderFpmSiteManagerError ? error
        : new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_checkpoint_unavailable', 'The FPM retirement checkpoint could not be durably written');
      throw primaryError;
    } finally {
      const closed = await Promise.allSettled([handle?.close(), directory?.close()]);
      if (!renamed) await rm(temporary, { force: true }).catch(() => {});
      if (!primaryError && closed.some(result => result.status === 'rejected')) throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_retirement_checkpoint_unavailable', 'The FPM retirement checkpoint descriptors could not be closed');
    }
  }

  async function serviceState(runtime, deadline) {
    let output;
    try { output = String((await run(SYSTEMCTL_PATH,
      ['show', runtime.serviceUnit, '--property=ActiveState', '--property=MainPID'], { timeout: deadline.left() })).stdout ?? ''); }
    catch (error) {
      if (error instanceof ElFinderFpmSiteManagerError) throw error;
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_inventory_unverified',
        'The shared FPM service identity could not be read');
    }
    const fields = output.trim().split('\n').map(line => line.split('='));
    if (Buffer.byteLength(output) > 1024 || fields.length !== 2 || new Set(fields.map(row => row[0])).size !== 2
      || !fields.every(row => row.length === 2 && ['ActiveState', 'MainPID'].includes(row[0]))) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_inventory_unverified', 'The shared FPM service identity is ambiguous');
    }
    const values = Object.fromEntries(fields), mainPid = Number(values.MainPID);
    if (!/^(?:0|[1-9][0-9]*)$/.test(values.MainPID) || !Number.isSafeInteger(mainPid)
      || !['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'].includes(values.ActiveState)) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_inventory_unverified', 'The shared FPM service identity is invalid');
    }
    return { active: values.ActiveState === 'active', mainPid,
      stable: values.ActiveState === 'active' ? mainPid > 0 : ['inactive', 'failed'].includes(values.ActiveState) && mainPid === 0 };
  }

  async function listenerInventory(runtime, deadline) {
    const before = await serviceState(runtime, deadline); let unix, tcp;
    try {
      unix = String((await run(SS_PATH, ['-H', '-xlpn'], { timeout: deadline.left() })).stdout ?? '');
      tcp = String((await run(SS_PATH, ['-H', '-lntp'], { timeout: deadline.left() })).stdout ?? '');
    } catch (error) {
      if (error instanceof ElFinderFpmSiteManagerError) throw error;
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_inventory_unverified', 'Shared FPM listeners could not be read');
    }
    if ([unix, tcp].some(value => Buffer.byteLength(value) > MAX_RETIREMENT_BYTES)) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_inventory_unverified', 'Shared FPM listener inventory exceeded its bound');
    }
    const pid = new RegExp(`\\bpid=${before.mainPid},`), listeners = new Map(), allUnixPaths = new Set();
    if (before.mainPid > 0 && tcp.split('\n').some(line => pid.test(line))) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_inventory_unsupported',
        'FPM retirement requires supported same-service Unix listener verification');
    }
    let stable = before.stable;
    for (const line of unix.split('\n').filter(Boolean)) {
      const fields = line.trim().split(/\s+/);
      if (!fields.includes('LISTEN')) continue;
      for (const value of fields) if (value.startsWith('/')) allUnixPaths.add(value);
      if (before.mainPid < 1 || !pid.test(line)) continue;
      const names = fields.filter(value => value.startsWith('/'));
      if (names.length !== 1) throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_inventory_unsupported',
        'A shared FPM listener cannot be safely identified');
      let metadata;
      try { metadata = await lstatFn(names[0]); }
      catch (error) { if (missingPath(error)) { stable = false; continue; } throw error; }
      if (!metadata.isSocket?.() || metadata.isSymbolicLink?.()) throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_retirement_listener_drift', 'A shared FPM listener path has changed type');
      const value = listenerMetadata({ path: names[0], uid: metadata.uid, gid: metadata.gid, mode: modeOf(metadata) });
      listeners.set(value.path, value);
    }
    const after = await serviceState(runtime, deadline);
    return { active: after.active, mainPid: after.mainPid,
      stable: stable && after.stable && before.active === after.active && before.mainPid === after.mainPid,
      listeners: [...listeners.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), allUnixPaths };
  }

  async function connectListener(socketPath, deadline) {
    const timeout = deadline.left(1000);
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: socketPath }); let settled = false;
      const finish = (error, ready) => {
        if (settled) return; settled = true; socket.destroy();
        if (error) reject(error); else resolve(ready);
      };
      socket.once('connect', () => finish(null, true));
      socket.once('timeout', () => finish(null, false));
      socket.once('error', error => finish(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EAGAIN', 'EWOULDBLOCK'].includes(error.code)
        ? null : new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_listener_unverified', 'A shared FPM listener could not be connected'), false));
      socket.setTimeout(timeout);
    });
  }

  async function stableInventory(runtime, deadline) {
    for (;;) {
      const observed = await listenerInventory(runtime, deadline);
      if (observed.stable) return observed;
      await new Promise(resolve => setTimeout(resolve, deadline.left(100)));
    }
  }

  async function protectedReady(checkpoint, inventory, deadline) {
    if (!inventory.stable || (checkpoint.wasActive && !inventory.active)) return false;
    for (const expected of checkpoint.protectedListeners) {
      const current = inventory.listeners.find(value => value.path === expected.path);
      if (!current || ['uid', 'gid', 'mode'].some(key => current[key] !== expected[key])
        || !await connectListener(expected.path, deadline)) return false;
    }
    return true;
  }

  async function ownedPool(spec) {
    let metadata;
    try { metadata = await lstatFn(spec.preview.artifact.path); }
    catch (error) { if (missingPath(error)) return null; throw error; }
    const content = await readOptional(spec.preview.artifact.path);
    if (!metadata.isFile?.() || metadata.isSymbolicLink?.() || metadata.uid !== 0 || metadata.gid !== 0
      || modeOf(metadata) !== elFinderFpmTemplatePolicy.poolMode || content === null || sha256(content) !== spec.preview.sha256) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_pool_drift', 'The file manager pool is no longer the exact owned configuration');
    }
    return content;
  }

  async function socketOwner(runtime, deadline) {
    const values = [];
    for (const [flag, name] of [['-u', runtime.socketOwner], ['-g', runtime.socketGroup]]) {
      let value;
      try { value = String((await run(ID_PATH, [flag, '--', name], { timeout: deadline.left() })).stdout ?? '').trim(); }
      catch (error) {
        if (error instanceof ElFinderFpmSiteManagerError) throw error;
        throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_listener_unverified', 'The FPM socket identity could not be verified');
      }
      if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_retirement_listener_unverified', 'The FPM socket identity is invalid');
      values.push(Number(value));
    }
    return { socketUid: values[0], socketGid: values[1] };
  }

  async function ownedSocket(spec, owner, listenerObserved = false) {
    let metadata;
    try { metadata = await lstatFn(spec.preview.socketPath); }
    catch (error) {
      if (!missingPath(error)) throw error;
      if (!listenerObserved) return null;
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_listener_drift', 'The listening file manager socket lost its canonical path');
    }
    if (!metadata.isSocket?.() || metadata.isSymbolicLink?.() || modeOf(metadata) !== 0o660
      || metadata.uid !== owner.socketUid || metadata.gid !== owner.socketGid) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_listener_drift', 'The file manager socket ownership has changed');
    }
    return metadata;
  }

  async function releaseRetiredSocket(spec, checkpoint, inventory, deadline) {
    if (inventory.allUnixPaths.has(spec.preview.socketPath)) return false;
    const metadata = await ownedSocket(spec, checkpoint);
    if (metadata === null) return true;
    if (await ownedPool(spec) !== null) throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_retirement_blocked', 'The file manager pool reappeared before socket cleanup');
    const current = await ownedSocket(spec, checkpoint);
    if (current === null) return true;
    if (current.dev !== metadata.dev || current.ino !== metadata.ino) throw new ElFinderFpmSiteManagerError(
      'elfinder_fpm_retirement_listener_drift', 'The retired FPM socket changed before unlink');
    const latest = await listenerInventory(spec.runtime, deadline);
    if (!latest.stable || latest.allUnixPaths.has(spec.preview.socketPath)) return false;
    deadline.left();
    await rmFn(spec.preview.socketPath, { force: true }); return true;
  }

  async function waitForRetirement(spec, checkpoint, deadline) {
    let attempts = 0;
    for (;;) {
      const observed = await listenerInventory(spec.runtime, deadline); attempts += 1;
      if (await ownedPool(spec) !== null) throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_retirement_blocked', 'The file manager pool reappeared after retirement started');
      if (await protectedReady(checkpoint, observed, deadline)
        && await releaseRetiredSocket(spec, checkpoint, observed, deadline)) {
        return { attempts, elapsedMs: Math.ceil(performance.now() - deadline.started),
          protectedListenerCount: checkpoint.protectedListeners.length, ownListenerAbsent: true };
      }
      await new Promise(resolve => setTimeout(resolve, deadline.left(100)));
    }
  }

  async function inspectRetirement(rawIntent, { operationId: rawOperationId, deadline = retirementDeadline() } = {}) {
    const spec = normalizeIntent(rawIntent, defaultRuntimeOptions);
    const operationId = normalizeOperationId(rawOperationId), receipt = await loadReceipt(operationId, spec);
    const checkpoint = await loadRetirementCheckpoint(operationId, spec, deadline);
    if ((receipt && (!receipt.mutated || receipt.previousConfig !== null)) || (!receipt && checkpoint)) {
      return Object.freeze({ satisfied: false, reason: 'elfinder_fpm_retirement_ownership_unverified',
        websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser });
    }
    if (receipt && (!checkpoint || checkpoint.state !== 'retired' || receipt.state !== 'compensated')) {
      return Object.freeze({ satisfied: false, reason: 'elfinder_fpm_retirement_checkpoint_pending',
        websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser });
    }
    if (checkpoint) await configTest(spec.runtime, deadline.left(30_000));
    const paths = [spec.preview.artifact.path, spec.preview.socketPath];
    for (const target of paths) {
      deadline.left();
      try {
        await lstatFn(target);
        return Object.freeze({ satisfied: false, reason: 'elfinder_fpm_retirement_pending',
          websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser });
      } catch (error) {
        if (!missingPath(error)) throw new ElFinderFpmSiteManagerError(
          'elfinder_fpm_retirement_unavailable', 'The Website file manager pool could not be inspected');
      }
    }
    const observed = await listenerInventory(spec.runtime, deadline);
    if (!observed.stable || observed.allUnixPaths.has(spec.preview.socketPath)) {
      return Object.freeze({ satisfied: false, reason: 'elfinder_fpm_retirement_listener_pending',
        websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser });
    }
    if (checkpoint) {
      if (!await protectedReady(checkpoint, observed, deadline)) return Object.freeze({ satisfied: false,
        reason: 'elfinder_fpm_retirement_sibling_pending', websiteId: spec.websiteId,
        applicationId: spec.applicationId, unixUser: spec.unixUser });
    }
    deadline.left();
    return Object.freeze({ satisfied: true, poolRemoved: true, socketRemoved: true,
      websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser,
      retirementVerified: Boolean(checkpoint), neverCreatedAbsence: !receipt && !checkpoint });
  }

  async function retire(rawIntent, options = {}) {
    const spec = normalizeIntent(rawIntent, defaultRuntimeOptions);
    const operationId = normalizeOperationId(options.operationId), deadline = retirementDeadline();
    let receipt = await loadReceipt(operationId, spec), reloaded = false;
    if (!receipt || !receipt.mutated || receipt.previousConfig !== null) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_blocked',
        'The operation receipt does not prove exclusive ownership of the file manager pool');
    }
    let checkpoint = await loadRetirementCheckpoint(operationId, spec, deadline);
    const current = await ownedPool(spec), owner = await socketOwner(spec.runtime, deadline);
    if (current !== null && (receipt.state === 'compensated' || checkpoint?.reloadAttempted || checkpoint?.state === 'retired')) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_blocked',
        'The file manager pool reappeared after its ownership was retired');
    }
    if (checkpoint && (checkpoint.socketUid !== owner.socketUid || checkpoint.socketGid !== owner.socketGid)) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_listener_drift', 'The FPM socket identity changed after its checkpoint');
    }
    let observed = await stableInventory(spec.runtime, deadline);
    await ownedSocket(spec, owner, observed.allUnixPaths.has(spec.preview.socketPath));
    if (!checkpoint) {
      if (observed.allUnixPaths.has(spec.preview.socketPath)
        && !observed.listeners.some(value => value.path === spec.preview.socketPath)) {
        throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_listener_drift',
          'The file manager listener is not owned by the expected FPM service');
      }
      // This immutable inventory precedes the first unlink/reload. Later polls
      // never recapture a smaller list when a sibling has not become ready.
      checkpoint = await persistRetirementCheckpoint(operationId, spec, {
        ...retirementBinding(operationId, spec), ...owner, state: 'prepared',
        wasActive: observed.active, mainPid: observed.mainPid, reloadAttempted: false,
        protectedListeners: observed.listeners.filter(value => value.path !== spec.preview.socketPath),
      }, deadline);
    }
    while (!await protectedReady(checkpoint, observed, deadline)) {
      await new Promise(resolve => setTimeout(resolve, deadline.left(100)));
      observed = await listenerInventory(spec.runtime, deadline);
    }
    if (!checkpoint.reloadAttempted && checkpoint.state !== 'retired' && observed.active !== checkpoint.wasActive) {
      throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_service_changed', 'The shared FPM service changed after its deletion checkpoint');
    }
    const needsReload = current !== null || observed.allUnixPaths.has(spec.preview.socketPath);
    // Configuration ownership and socket metadata are checked before mutation;
    // actual stale socket unlink only happens later, after LISTEN absence.
    await ownedSocket(spec, owner, observed.allUnixPaths.has(spec.preview.socketPath));
    if (current !== null) {
      if (await ownedPool(spec) !== current) throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_retirement_pool_drift', 'The file manager pool changed before unlink');
      deadline.left(); await rmFn(spec.preview.artifact.path, { force: true });
    }
    try { await configTest(spec.runtime, deadline.left(30_000)); }
    catch (error) {
      // Configuration validation has not reloaded the service. Restore only our
      // exact unlinked pool; never overwrite a path that reappeared meanwhile.
      if (current !== null && await readOptional(spec.preview.artifact.path) === null) {
        try { deadline.left(); await atomicWrite(spec.preview.artifact.path, current, elFinderFpmTemplatePolicy.poolMode); }
        catch { /* The primary config-test failure remains visible. */ }
      }
      throw error;
    }
    if (needsReload && checkpoint.wasActive && !checkpoint.reloadAttempted && checkpoint.state !== 'retired') {
      observed = await stableInventory(spec.runtime, deadline);
      if (!await protectedReady(checkpoint, observed, deadline)) throw new ElFinderFpmSiteManagerError(
        'elfinder_fpm_retirement_listener_unverified', 'A shared FPM sibling changed before reload');
      checkpoint = await persistRetirementCheckpoint(operationId, spec,
        { ...checkpoint, state: 'reload_started', reloadAttempted: true }, deadline);
      // The durable marker is invocation intent, not success. An interrupted or
      // uncertain invocation is reconciled from actual listeners without replay.
      try { await run(SYSTEMCTL_PATH, ['reload', spec.runtime.serviceUnit], { timeout: deadline.left(30_000) }); reloaded = true; }
      catch (error) {
        if (error instanceof ElFinderFpmSiteManagerError) throw error;
        throw new ElFinderFpmSiteManagerError('elfinder_fpm_service_reload_failed', 'PHP-FPM could not reload retired file manager configuration');
      }
    }
    const readiness = await waitForRetirement(spec, checkpoint, deadline);
    if (receipt.state !== 'compensated') {
      deadline.left(); receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'compensated' });
    }
    if (checkpoint.state !== 'retired') await persistRetirementCheckpoint(operationId, spec, { ...checkpoint, state: 'retired' }, deadline);
    const result = await inspectRetirement(rawIntent, { operationId, deadline });
    if (!result.satisfied) throw new ElFinderFpmSiteManagerError('elfinder_fpm_retirement_unverified',
      'The Website file manager pool, socket or sibling readiness is not verified');
    deadline.left();
    return Object.freeze({ ...result, reloaded, readiness: Object.freeze(readiness) });
  }

  return Object.freeze({ inspect, apply, compensate, inspectCompensation, retire, inspectRetirement });
}

export const elFinderFpmSiteManagerInternals = Object.freeze({
  normalizeIntent,
  normalizeOperationId,
  normalizeReceipt,
  normalizeRetirementCheckpoint,
  retirementBinding,
  listenerMetadata,
  specDigest,
  modeOf,
  packageName: PACKAGE_NAME,
  paths: Object.freeze({
    DPKG_QUERY_PATH,
    APT_GET_PATH,
    PHP_FPM_BINARY,
    SYSTEMCTL_PATH,
    RECEIPT_ROOT,
  }),
});
