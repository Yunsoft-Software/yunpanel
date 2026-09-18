import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  phpFpmPoolPath,
  phpFpmSocketPath,
  phpFpmTemplatePolicy,
  previewWebsitePhpFpmPool,
  renderWebsitePhpFpmPool,
} from '@yunpanel/config-templates';
import { createApplicationIdentity } from './application-identity.js';
import { createWebsiteIdentityPathManager } from './website-identity-path-manager.js';

const execFileAsync = promisify(execFile);
const DPKG_QUERY_PATH = '/usr/bin/dpkg-query';
const APT_GET_PATH = '/usr/bin/apt-get';
const PHP_FPM_BINARY = '/usr/sbin/php-fpm8.3';
const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/php-fpm-sites';
const PACKAGE_NAME = 'php8.3-fpm';
const RECEIPT_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_STATES = new Set(['prepared', 'active', 'compensated']);

export class PhpFpmSiteManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpFpmSiteManagerError';
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
    throw new PhpFpmSiteManagerError('php_fpm_operation_invalid', 'PHP-FPM Website operation id is invalid');
  }
  return value.toLowerCase();
}

function normalizeIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PhpFpmSiteManagerError('php_fpm_site_intent_invalid', 'PHP-FPM Website intent is invalid');
  }
  const allowed = new Set([
    'websiteId',
    'applicationId',
    'unixUser',
    'documentRoot',
    'maxChildren',
    'memoryLimitMb',
    'maxExecutionSeconds',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.websiteId !== 'string' || !UUID_PATTERN.test(value.websiteId)) {
    throw new PhpFpmSiteManagerError('php_fpm_site_intent_invalid', 'PHP-FPM Website intent is invalid');
  }

  let identity;
  try { identity = createApplicationIdentity(value.applicationId); }
  catch { throw new PhpFpmSiteManagerError('php_fpm_site_application_invalid', 'PHP-FPM Website Application identity is invalid'); }

  if (value.unixUser !== identity.unixUser) {
    throw new PhpFpmSiteManagerError('php_fpm_site_identity_mismatch', 'PHP-FPM Website Unix identity does not match the Application');
  }
  if (typeof value.documentRoot !== 'string' || !path.posix.isAbsolute(value.documentRoot)) {
    throw new PhpFpmSiteManagerError('php_fpm_site_document_root_invalid', 'PHP-FPM Website document root is invalid');
  }
  const documentRoot = path.posix.normalize(value.documentRoot);
  const applicationRoot = identity.paths.runtime.currentRelease;
  const relative = path.posix.relative(applicationRoot, documentRoot);
  if (documentRoot !== value.documentRoot || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
    throw new PhpFpmSiteManagerError('php_fpm_site_document_root_invalid', 'PHP-FPM Website document root must stay inside the canonical current release');
  }

  const templateInput = Object.freeze({
    unixUser: identity.unixUser,
    unixGroup: identity.unixUser,
    applicationRoot,
    documentRoot,
    homeDirectory: identity.paths.workspace.homeDirectory,
    temporaryDirectory: identity.paths.workspace.temporaryDirectory,
    logDirectory: identity.paths.workspace.logDirectory,
    ...(value.maxChildren === undefined ? {} : { maxChildren: value.maxChildren }),
    ...(value.memoryLimitMb === undefined ? {} : { memoryLimitMb: value.memoryLimitMb }),
    ...(value.maxExecutionSeconds === undefined ? {} : { maxExecutionSeconds: value.maxExecutionSeconds }),
  });

  let preview;
  try { preview = previewWebsitePhpFpmPool(templateInput); }
  catch {
    throw new PhpFpmSiteManagerError('php_fpm_site_policy_invalid', 'PHP-FPM Website policy is invalid');
  }

  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    applicationId: identity.applicationId,
    unixUser: identity.unixUser,
    identity,
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
    templateSha256: spec.preview.sha256,
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
    throw new PhpFpmSiteManagerError('php_fpm_receipt_invalid', 'PHP-FPM Website operation receipt is invalid');
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

function missingPath(error) {
  return error?.code === 'ENOENT';
}

function missingPackage(error) {
  return Number.isInteger(error?.code) && error.code === 1;
}

export function createPhpFpmSiteManager({
  receiptRoot = RECEIPT_ROOT,
  identityManager = createWebsiteIdentityPathManager(),
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
    throw new PhpFpmSiteManagerError('php_fpm_dependencies_invalid', 'PHP-FPM Website manager dependencies are invalid');
  }

  function receiptPath(operationId) {
    return path.posix.join(receiptRoot, `${operationId}.json`);
  }

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await rmFn(temporaryPath, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
      await renameFn(temporaryPath, targetPath);
    } finally {
      await rmFn(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function readOptional(file) {
    try { return await readFileFn(file, 'utf8'); }
    catch (error) {
      if (missingPath(error)) return null;
      throw new PhpFpmSiteManagerError('php_fpm_config_unavailable', 'PHP-FPM Website pool configuration could not be read');
    }
  }

  async function loadReceipt(operationId, spec) {
    let raw;
    try { raw = await readFileFn(receiptPath(operationId), 'utf8'); }
    catch (error) {
      if (missingPath(error)) return null;
      throw new PhpFpmSiteManagerError('php_fpm_receipt_unavailable', 'PHP-FPM Website operation receipt could not be read');
    }
    try { return normalizeReceipt(JSON.parse(raw), { operationId, spec }); }
    catch (error) {
      if (error instanceof PhpFpmSiteManagerError) throw error;
      throw new PhpFpmSiteManagerError('php_fpm_receipt_invalid', 'PHP-FPM Website operation receipt is invalid');
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

  async function inspectPackage() {
    try {
      const result = await run(DPKG_QUERY_PATH, ['-W', '-f=${Status}\t${Version}', PACKAGE_NAME], { timeout: 10_000 });
      const output = String(result?.stdout ?? '').trim();
      const match = output.match(/^install ok installed\t([^\s]+)$/);
      return Object.freeze({ installed: Boolean(match), version: match?.[1] ?? null });
    } catch (error) {
      if (missingPackage(error)) return Object.freeze({ installed: false, version: null });
      throw new PhpFpmSiteManagerError('php_fpm_package_inspection_failed', 'PHP-FPM package state could not be inspected');
    }
  }

  async function ensurePackage() {
    const before = await inspectPackage();
    if (before.installed) return before;
    try {
      await run(APT_GET_PATH, ['install', '--yes', '--no-install-recommends', PACKAGE_NAME], {
        timeout: 10 * 60_000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new PhpFpmSiteManagerError('php_fpm_package_install_failed', 'PHP-FPM package could not be installed');
    }
    const after = await inspectPackage();
    if (!after.installed) {
      throw new PhpFpmSiteManagerError('php_fpm_package_install_unverified', 'PHP-FPM package installation could not be verified');
    }
    return after;
  }

  async function configTest() {
    try { await run(PHP_FPM_BINARY, ['--test'], { timeout: 30_000 }); }
    catch { throw new PhpFpmSiteManagerError('php_fpm_config_test_failed', 'PHP-FPM configuration test failed'); }
  }

  async function serviceActive() {
    try {
      await run(SYSTEMCTL_PATH, ['is-active', '--quiet', phpFpmTemplatePolicy.serviceUnit], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }

  async function activateService() {
    try {
      await run(SYSTEMCTL_PATH, ['enable', '--now', phpFpmTemplatePolicy.serviceUnit], { timeout: 60_000 });
      await run(SYSTEMCTL_PATH, ['reload', phpFpmTemplatePolicy.serviceUnit], { timeout: 30_000 });
    } catch {
      throw new PhpFpmSiteManagerError('php_fpm_service_activation_failed', 'PHP-FPM service could not activate the Website pool');
    }
  }

  async function reloadServiceIfActive() {
    if (!(await serviceActive())) return;
    try { await run(SYSTEMCTL_PATH, ['reload', phpFpmTemplatePolicy.serviceUnit], { timeout: 30_000 }); }
    catch { throw new PhpFpmSiteManagerError('php_fpm_service_reload_failed', 'PHP-FPM service could not reload restored configuration'); }
  }

  async function inspectIdentity(spec) {
    const result = await identityManager.inspect({
      user: spec.unixUser,
      homeDirectory: spec.identity.paths.workspace.homeDirectory,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
    });
    if (!result?.satisfied) {
      return Object.freeze({ satisfied: false, reason: result?.reason ?? 'website_identity_unverified' });
    }
    if (result.user !== spec.unixUser
      || result.homeDirectory !== spec.identity.paths.workspace.homeDirectory
      || !Number.isSafeInteger(result.uid) || result.uid < 1
      || !Number.isSafeInteger(result.gid) || result.gid < 1
      || result.homeMode !== 0o750) {
      throw new PhpFpmSiteManagerError('php_fpm_identity_drift', 'PHP-FPM Website identity does not match canonical managed state');
    }
    return result;
  }

  async function inspectDocumentRoot(spec, identity) {
    let info;
    try { info = await lstatFn(spec.templateInput.documentRoot); }
    catch (error) {
      if (missingPath(error)) {
        return Object.freeze({ satisfied: false, reason: 'php_fpm_document_root_missing' });
      }
      throw new PhpFpmSiteManagerError('php_fpm_document_root_unavailable', 'PHP-FPM Website document root could not be inspected');
    }
    if (!info?.isDirectory?.() || info.isSymbolicLink?.()
      || info.uid !== identity.uid || info.gid !== identity.gid
      || (modeOf(info) & 0o007) !== 0 || (modeOf(info) & 0o500) !== 0o500) {
      throw new PhpFpmSiteManagerError('php_fpm_document_root_drift', 'PHP-FPM Website document root ownership or permissions have drifted');
    }
    return Object.freeze({ satisfied: true, mode: modeOf(info) });
  }

  async function previewMigration(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const configPath = phpFpmPoolPath(spec.unixUser);
    const socketPath = phpFpmSocketPath(spec.unixUser);

    let identity;
    try {
      const value = await inspectIdentity(spec);
      identity = value?.satisfied === true
        ? Object.freeze({
          satisfied: true,
          uid: value.uid,
          gid: value.gid,
          homeDirectory: value.homeDirectory,
          homeMode: Number(value.homeMode).toString(8).padStart(4, '0'),
        })
        : Object.freeze({
          satisfied: false,
          reason: value?.reason ?? 'website_identity_unverified',
        });
    } catch (error) {
      identity = Object.freeze({
        satisfied: false,
        reason: typeof error?.code === 'string' ? error.code : 'php_fpm_identity_inspection_failed',
      });
    }

    async function pathState(target) {
      try {
        const info = await lstatFn(target);
        return Object.freeze({
          present: true,
          file: Boolean(info?.isFile?.()),
          directory: Boolean(info?.isDirectory?.()),
          socket: Boolean(info?.isSocket?.()),
          symbolicLink: Boolean(info?.isSymbolicLink?.()),
          uid: Number.isSafeInteger(info?.uid) ? info.uid : null,
          gid: Number.isSafeInteger(info?.gid) ? info.gid : null,
          mode: modeOf(info).toString(8).padStart(4, '0'),
        });
      } catch (error) {
        if (missingPath(error)) return Object.freeze({ present: false });
        throw new PhpFpmSiteManagerError('php_fpm_path_inspection_failed', 'PHP-FPM Website path could not be inspected');
      }
    }

    const [documentRootState, packageState, configState, socketState] = await Promise.all([
      pathState(spec.templateInput.documentRoot),
      inspectPackage(),
      pathState(configPath),
      pathState(socketPath),
    ]);

    let configSha256 = null;
    let configReadError = null;
    if (configState.present) {
      try {
        const config = await readFileFn(configPath, 'utf8');
        configSha256 = sha256(config);
      } catch (error) {
        configReadError = missingPath(error) ? 'php_fpm_pool_missing' : 'php_fpm_config_unavailable';
      }
    }

    let receipt = null;
    let receiptError = null;
    try { receipt = await loadReceipt(operationId, spec); }
    catch (error) {
      receiptError = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
        ? error.code
        : 'php_fpm_receipt_invalid';
    }

    let configValid = null;
    if (packageState.installed) {
      try {
        await configTest();
        configValid = true;
      } catch {
        configValid = false;
      }
    }
    const active = await serviceActive();

    const differences = [];
    if (!identity.satisfied) differences.push(identity.reason);
    if (!documentRootState.present) {
      differences.push('php_fpm_document_root_missing');
    } else if (!identity.satisfied
      || documentRootState.directory !== true
      || documentRootState.symbolicLink !== false
      || documentRootState.uid !== identity.uid
      || documentRootState.gid !== identity.gid
      || (Number.parseInt(documentRootState.mode, 8) & 0o007) !== 0
      || (Number.parseInt(documentRootState.mode, 8) & 0o500) !== 0o500) {
      differences.push('php_fpm_document_root_drift');
    }
    if (!packageState.installed) differences.push('php_fpm_package_missing');
    if (receiptError) differences.push(receiptError);
    else if (!receipt) differences.push('php_fpm_receipt_missing');
    else if (receipt.state !== 'active') differences.push(`php_fpm_receipt_${receipt.state}`);
    if (!configState.present || configReadError === 'php_fpm_pool_missing') {
      differences.push('php_fpm_pool_missing');
    } else if (configReadError
      || configState.file !== true
      || configState.symbolicLink !== false
      || configState.uid !== 0
      || configState.gid !== 0
      || configState.mode !== phpFpmTemplatePolicy.poolMode.toString(8).padStart(4, '0')
      || configSha256 !== spec.preview.sha256) {
      differences.push(configReadError ?? 'php_fpm_pool_drift');
    }
    if (configValid === false) differences.push('php_fpm_config_invalid');
    if (!active) differences.push('php_fpm_service_inactive');
    if (!socketState.present) {
      differences.push('php_fpm_socket_missing');
    } else if (socketState.socket !== true || socketState.symbolicLink !== false || socketState.mode !== '0660') {
      differences.push('php_fpm_socket_drift');
    }

    return Object.freeze({
      version: 1,
      adapter: 'php-fpm',
      satisfied: differences.length === 0,
      current: Object.freeze({
        identity,
        documentRoot: documentRootState,
        package: packageState,
        receipt: Object.freeze({
          state: receipt?.state ?? null,
          mutated: receipt?.mutated ?? null,
          previousConfigSha256: receipt?.previousConfig === null || receipt?.previousConfig === undefined
            ? null
            : sha256(receipt.previousConfig),
          error: receiptError,
        }),
        pool: Object.freeze({
          ...configState,
          sha256: configSha256,
          matchesDesired: configSha256 === spec.preview.sha256,
          readError: configReadError,
        }),
        configValid,
        serviceActive: active,
        socket: socketState,
      }),
      desired: Object.freeze({
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
        unixUser: spec.unixUser,
        homeDirectory: spec.identity.paths.workspace.homeDirectory,
        documentRoot: spec.templateInput.documentRoot,
        packageName: PACKAGE_NAME,
        phpVersion: phpFpmTemplatePolicy.phpVersion,
        configPath,
        configSha256: spec.preview.sha256,
        configMode: phpFpmTemplatePolicy.poolMode.toString(8).padStart(4, '0'),
        socketPath,
        socketMode: '0660',
        serviceUnit: phpFpmTemplatePolicy.serviceUnit,
      }),
      differences: Object.freeze([...new Set(differences)]),
    });
  }

  async function inspect(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    const identity = await inspectIdentity(spec);
    if (!identity.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'php_fpm_identity_unavailable',
        identityReason: identity.reason,
        adapter: 'php-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }

    const documentRoot = await inspectDocumentRoot(spec, identity);
    if (!documentRoot.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: documentRoot.reason,
        adapter: 'php-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
        documentRoot: spec.templateInput.documentRoot,
      });
    }

    const packageState = await inspectPackage();
    if (!packageState.installed) {
      return Object.freeze({
        satisfied: false,
        reason: 'php_fpm_package_missing',
        adapter: 'php-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }

    const configPath = phpFpmPoolPath(spec.unixUser);
    let configInfo;
    let config;
    try {
      [configInfo, config] = await Promise.all([lstatFn(configPath), readFileFn(configPath, 'utf8')]);
    } catch (error) {
      if (missingPath(error)) {
        return Object.freeze({
          satisfied: false,
          reason: 'php_fpm_pool_missing',
          adapter: 'php-fpm',
          websiteId: spec.websiteId,
          applicationId: spec.applicationId,
          configPath,
        });
      }
      throw new PhpFpmSiteManagerError('php_fpm_config_unavailable', 'PHP-FPM Website pool configuration could not be inspected');
    }
    if (!configInfo?.isFile?.() || configInfo.isSymbolicLink?.()
      || configInfo.uid !== 0 || configInfo.gid !== 0 || modeOf(configInfo) !== phpFpmTemplatePolicy.poolMode) {
      throw new PhpFpmSiteManagerError('php_fpm_pool_drift', 'PHP-FPM Website pool file ownership or mode has drifted');
    }
    if (sha256(config) !== spec.preview.sha256) {
      throw new PhpFpmSiteManagerError('php_fpm_pool_drift', 'PHP-FPM Website pool content has drifted');
    }

    try { await configTest(); }
    catch {
      return Object.freeze({
        satisfied: false,
        reason: 'php_fpm_config_invalid',
        adapter: 'php-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }
    if (!(await serviceActive())) {
      return Object.freeze({
        satisfied: false,
        reason: 'php_fpm_service_inactive',
        adapter: 'php-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }

    const socketPath = phpFpmSocketPath(spec.unixUser);
    let socketInfo;
    try { socketInfo = await lstatFn(socketPath); }
    catch (error) {
      if (missingPath(error)) {
        return Object.freeze({
          satisfied: false,
          reason: 'php_fpm_socket_missing',
          adapter: 'php-fpm',
          websiteId: spec.websiteId,
          applicationId: spec.applicationId,
          socketPath,
        });
      }
      throw new PhpFpmSiteManagerError('php_fpm_socket_unavailable', 'PHP-FPM Website socket could not be inspected');
    }
    if (!socketInfo?.isSocket?.() || modeOf(socketInfo) !== 0o660) {
      throw new PhpFpmSiteManagerError('php_fpm_socket_drift', 'PHP-FPM Website socket type or mode has drifted');
    }

    return Object.freeze({
      satisfied: true,
      adapter: 'php-fpm',
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      phpVersion: phpFpmTemplatePolicy.phpVersion,
      packageVersion: packageState.version,
      unixUser: spec.unixUser,
      unixUid: identity.uid,
      unixGid: identity.gid,
      configPath,
      configSha256: spec.preview.sha256,
      socketPath,
      serviceUnit: phpFpmTemplatePolicy.serviceUnit,
      documentRoot: spec.templateInput.documentRoot,
      documentRootMode: documentRoot.mode,
    });
  }

  async function restoreConfig(spec, receipt) {
    const configPath = phpFpmPoolPath(spec.unixUser);
    if (!receipt.mutated) return;
    if (receipt.previousConfig === null) {
      await rmFn(configPath, { force: true });
    } else {
      await atomicWrite(configPath, receipt.previousConfig, phpFpmTemplatePolicy.poolMode);
    }
    await configTest();
    await reloadServiceIfActive();
  }

  async function apply(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const identity = await inspectIdentity(spec);
    if (!identity.satisfied) {
      throw new PhpFpmSiteManagerError('php_fpm_identity_required', 'Website Unix identity must be ready before PHP-FPM pool provisioning');
    }
    const documentRoot = await inspectDocumentRoot(spec, identity);
    if (!documentRoot.satisfied) {
      throw new PhpFpmSiteManagerError('php_fpm_document_root_required', 'Website document root must be ready before PHP-FPM pool provisioning');
    }

    await ensurePackage();
    await mkdirFn(phpFpmTemplatePolicy.poolDirectory, { recursive: true, mode: 0o755 });
    const configPath = phpFpmPoolPath(spec.unixUser);
    const desired = renderWebsitePhpFpmPool(spec.templateInput);
    let receipt = await loadReceipt(operationId, spec);
    const current = await readOptional(configPath);

    if (receipt?.state === 'compensated') {
      throw new PhpFpmSiteManagerError('php_fpm_operation_compensated', 'Compensated PHP-FPM Website operation cannot be re-applied');
    }

    if (!receipt) {
      if (current !== null && sha256(current) !== spec.preview.sha256) {
        throw new PhpFpmSiteManagerError('php_fpm_pool_conflict', 'Existing PHP-FPM Website pool is not owned by this operation');
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
      const acceptable = currentAfterReceipt === null || sha256(currentAfterReceipt) === receipt.configSha256;
      if (!acceptable) {
        throw new PhpFpmSiteManagerError('php_fpm_pool_drift', 'PHP-FPM Website pool changed after durable operation checkpoint');
      }
      await atomicWrite(configPath, desired, phpFpmTemplatePolicy.poolMode);
    }

    try {
      await configTest();
      await activateService();
      const verified = await inspect(rawIntent);
      if (!verified.satisfied) {
        throw new PhpFpmSiteManagerError('php_fpm_apply_unverified', 'PHP-FPM Website pool activation could not be verified');
      }
      receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'active' });
      return Object.freeze({ ...verified, created: receipt.mutated });
    } catch (error) {
      if (receipt.mutated) {
        try { await restoreConfig(spec, receipt); } catch { /* Preserve the primary failure; receipt remains prepared. */ }
      }
      if (error instanceof PhpFpmSiteManagerError) throw error;
      throw new PhpFpmSiteManagerError('php_fpm_apply_failed', 'PHP-FPM Website pool activation failed');
    }
  }

  async function inspectCompensation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReceipt(operationId, spec);
    if (!receipt || !receipt.mutated) {
      return Object.freeze({ satisfied: true, restoredPrevious: false, preservedExisting: true });
    }
    if (receipt.state === 'compensated') {
      return Object.freeze({ satisfied: true, restoredPrevious: receipt.previousConfig !== null, preservedExisting: false });
    }
    const current = await readOptional(phpFpmPoolPath(spec.unixUser));
    if (receipt.previousConfig === null && current === null) {
      return Object.freeze({ satisfied: true, restoredPrevious: false, preservedExisting: false });
    }
    if (receipt.previousConfig !== null && current !== null && current === receipt.previousConfig) {
      return Object.freeze({ satisfied: true, restoredPrevious: true, preservedExisting: false });
    }
    return Object.freeze({
      satisfied: false,
      reason: current !== null && sha256(current) !== receipt.configSha256
        ? 'php_fpm_compensation_drift'
        : 'php_fpm_compensation_pending',
      restoredPrevious: false,
      preservedExisting: false,
    });
  }

  async function compensate(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    let receipt = await loadReceipt(operationId, spec);
    if (!receipt || !receipt.mutated) {
      return Object.freeze({ satisfied: true, restoredPrevious: false, preservedExisting: true });
    }
    if (receipt.state === 'compensated') return inspectCompensation(rawIntent, { operationId });

    const before = await inspectCompensation(rawIntent, { operationId });
    if (before.satisfied) {
      receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'compensated' });
      return Object.freeze({ ...before, receiptState: receipt.state });
    }
    if (before.reason === 'php_fpm_compensation_drift') {
      throw new PhpFpmSiteManagerError('php_fpm_compensation_drift', 'PHP-FPM Website pool changed after the operation and cannot be safely restored');
    }

    await restoreConfig(spec, receipt);
    receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'compensated' });
    const after = await inspectCompensation(rawIntent, { operationId });
    if (!after.satisfied) {
      throw new PhpFpmSiteManagerError('php_fpm_compensation_unverified', 'PHP-FPM Website pool compensation could not be verified');
    }
    return Object.freeze({ ...after, receiptState: receipt.state });
  }

  return Object.freeze({ inspect, previewMigration, apply, compensate, inspectCompensation });
}

export const phpFpmSiteManagerInternals = Object.freeze({
  normalizeIntent,
  normalizeOperationId,
  specDigest,
  modeOf,
  paths: Object.freeze({
    DPKG_QUERY_PATH,
    APT_GET_PATH,
    PHP_FPM_BINARY,
    SYSTEMCTL_PATH,
    RECEIPT_ROOT,
  }),
  packageName: PACKAGE_NAME,
});
