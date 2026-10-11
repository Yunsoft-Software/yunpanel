import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  phpFpmBinaryPath,
  phpFpmPackageName,
  phpFpmPoolDirectory,
  phpFpmPoolPath,
  phpFpmServiceUnit,
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
const APT_CACHE_PATH = '/usr/bin/apt-cache';
const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/php-fpm-sites';
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
    'phpVersion',
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

  let requestedPhpVersion = phpFpmTemplatePolicy.distroVersion;
  if (value.phpVersion !== undefined) {
    if (typeof value.phpVersion !== 'string' || !phpFpmTemplatePolicy.supportedVersions.includes(value.phpVersion)) {
      throw new PhpFpmSiteManagerError('php_fpm_site_version_unsupported', `PHP ${value.phpVersion} is not supported by the PHP-FPM adapter`);
    }
    requestedPhpVersion = value.phpVersion;
  }

  const templateInput = Object.freeze({
    unixUser: identity.unixUser,
    unixGroup: identity.unixUser,
    phpVersion: requestedPhpVersion,
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
    phpVersion: requestedPhpVersion,
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
    phpVersion: spec.phpVersion,
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
    || (value.phpVersion && value.phpVersion !== spec.phpVersion)
    || value.specDigest !== specDigest(spec)
    || value.configSha256 !== spec.preview.sha256
    || typeof value.mutated !== 'boolean'
    || (value.previousConfig !== null && typeof value.previousConfig !== 'string')
    || !RECEIPT_STATES.has(value.state)) {
    throw new PhpFpmSiteManagerError('php_fpm_receipt_invalid', 'PHP-FPM Website operation receipt is invalid');
  }
  if (value.previousRuntime) {
    const configuration = value.previousRuntime;
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
      || Object.keys(configuration).length !== 4 || !['phpVersion', 'maxChildren', 'memoryLimitMb', 'maxExecutionSeconds'].every(key => Object.hasOwn(configuration, key)) || typeof value.previousPoolConfig !== 'string'
      || configuration.phpVersion === spec.phpVersion) throw new PhpFpmSiteManagerError('php_fpm_receipt_invalid', 'PHP version checkpoint is invalid');
    const previous = normalizeIntent({ websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser,
      documentRoot: spec.templateInput.documentRoot, ...configuration });
    if (sha256(value.previousPoolConfig) !== previous.preview.sha256) throw new PhpFpmSiteManagerError('php_fpm_receipt_invalid', 'Previous PHP pool checksum does not match the checkpoint');
  }
  return Object.freeze({
    version: RECEIPT_VERSION,
    operationId,
    websiteId: spec.websiteId,
    applicationId: spec.applicationId,
    unixUser: spec.unixUser,
    phpVersion: spec.phpVersion,
    specDigest: value.specDigest,
    configSha256: value.configSha256,
    mutated: value.mutated,
    previousConfig: value.previousConfig,
    ...(value.previousRuntime ? { previousRuntime: value.previousRuntime, previousPoolConfig: value.previousPoolConfig } : {}),
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
      ...(value.previousRuntime ? { previousRuntime: value.previousRuntime, previousPoolConfig: value.previousPoolConfig } : {}),
      state: value.state,
    };
    await atomicWrite(receiptPath(operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return normalizeReceipt(receipt, { operationId, spec });
  }

  async function inspectPackage(version = phpFpmTemplatePolicy.distroVersion) {
    const packageName = phpFpmPackageName(version);
    try {
      const result = await run(DPKG_QUERY_PATH, ['-W', '-f=${Status}\t${Version}', packageName], { timeout: 10_000 });
      const output = String(result?.stdout ?? '').trim();
      const match = output.match(/^install ok installed\t([^\s]+)$/);
      return Object.freeze({ installed: Boolean(match), version: match?.[1] ?? null, packageName });
    } catch (error) {
      if (missingPackage(error)) return Object.freeze({ installed: false, version: null, packageName });
      throw new PhpFpmSiteManagerError('php_fpm_package_inspection_failed', 'PHP-FPM package state could not be inspected');
    }
  }

  async function verifyPhpRepository(version) {
    if (version === phpFpmTemplatePolicy.distroVersion) return true;
    const packageName = phpFpmPackageName(version);
    try {
      const result = await run(APT_CACHE_PATH, ['policy', packageName], { timeout: 15_000 });
      const output = String(result?.stdout ?? '');
      const candidate = output.match(/^\s*Candidate:\s*(\S+)\s*$/m)?.[1];
      const lines = output.split('\n');
      let candidateBlock = false;
      let verifiedOrigin = false;
      for (const line of lines) {
        const versionLine = line.match(/^\s*(?:\*\*\*\s+)?(\S+)\s+\d+\s*$/);
        if (versionLine) candidateBlock = versionLine[1] === candidate;
        if (candidateBlock && /^\s+\d+\s+https?:\/\/ppa\.launchpad(?:content)?\.net\/ondrej\/php\/ubuntu\s+\S+\/main\s+\S+\s+Packages\s*$/.test(line)) {
          verifiedOrigin = true;
        }
      }
      if (!candidate || candidate === '(none)' || !verifiedOrigin) {
        throw new PhpFpmSiteManagerError(
          'php_fpm_repository_unverified',
          `PHP ${version} is not available in verified package repositories`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof PhpFpmSiteManagerError) throw error;
      throw new PhpFpmSiteManagerError(
        'php_fpm_repository_unverified',
        `PHP ${version} package repository verification failed`,
      );
    }
  }

  async function ensurePackage(version = phpFpmTemplatePolicy.distroVersion) {
    const before = await inspectPackage(version);
    if (before.installed) return before;
    await verifyPhpRepository(version);
    const packageName = phpFpmPackageName(version);
    try {
      await run(APT_GET_PATH, ['install', '--yes', '--no-install-recommends', packageName], {
        timeout: 10 * 60_000,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
      });
    } catch {
      throw new PhpFpmSiteManagerError('php_fpm_package_install_failed', 'PHP-FPM package could not be installed');
    }
    const after = await inspectPackage(version);
    if (!after.installed) {
      throw new PhpFpmSiteManagerError('php_fpm_package_install_unverified', 'PHP-FPM package installation could not be verified');
    }
    return after;
  }

  async function configTest(version = phpFpmTemplatePolicy.distroVersion) {
    const binary = phpFpmBinaryPath(version);
    try { await run(binary, ['--test'], { timeout: 30_000 }); }
    catch { throw new PhpFpmSiteManagerError('php_fpm_config_test_failed', 'PHP-FPM configuration test failed'); }
  }

  async function serviceActive(version = phpFpmTemplatePolicy.distroVersion) {
    const unit = phpFpmServiceUnit(version);
    try {
      await run(SYSTEMCTL_PATH, ['is-active', '--quiet', unit], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }

  async function activateService(version = phpFpmTemplatePolicy.distroVersion) {
    const unit = phpFpmServiceUnit(version);
    try {
      await run(SYSTEMCTL_PATH, ['enable', '--now', unit], { timeout: 60_000 });
      await run(SYSTEMCTL_PATH, ['reload', unit], { timeout: 30_000 });
    } catch {
      throw new PhpFpmSiteManagerError('php_fpm_service_activation_failed', 'PHP-FPM service could not activate the Website pool');
    }
  }

  async function reloadServiceIfActive(version = phpFpmTemplatePolicy.distroVersion) {
    if (!(await serviceActive(version))) return;
    const unit = phpFpmServiceUnit(version);
    try { await run(SYSTEMCTL_PATH, ['reload', unit], { timeout: 30_000 }); }
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
    const configPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion);
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
      inspectPackage(spec.phpVersion),
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
        await configTest(spec.phpVersion);
        configValid = true;
      } catch {
        configValid = false;
      }
    }
    const active = await serviceActive(spec.phpVersion);

    const documentRootReady = documentRootState.present
      && identity.satisfied
      && documentRootState.directory === true
      && documentRootState.symbolicLink === false
      && documentRootState.uid === identity.uid
      && documentRootState.gid === identity.gid
      && (Number.parseInt(documentRootState.mode, 8) & 0o007) === 0
      && (Number.parseInt(documentRootState.mode, 8) & 0o500) === 0o500;
    const safeCreateCandidate = receipt === null
      && receiptError === null
      && documentRootReady
      && packageState.installed === true
      && configState.present === false
      && configReadError === null
      && configValid === true
      && active === true
      && socketState.present === false;
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
      safeCreateCandidate,
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
        packageName: phpFpmPackageName(spec.phpVersion),
        phpVersion: spec.phpVersion,
        configPath,
        configSha256: spec.preview.sha256,
        configMode: phpFpmTemplatePolicy.poolMode.toString(8).padStart(4, '0'),
        socketPath,
        socketMode: '0660',
        serviceUnit: phpFpmServiceUnit(spec.phpVersion),
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

    const packageState = await inspectPackage(spec.phpVersion);
    if (!packageState.installed) {
      return Object.freeze({
        satisfied: false,
        reason: 'php_fpm_package_missing',
        adapter: 'php-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }

    const configPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion);
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

    try { await configTest(spec.phpVersion); }
    catch {
      return Object.freeze({
        satisfied: false,
        reason: 'php_fpm_config_invalid',
        adapter: 'php-fpm',
        websiteId: spec.websiteId,
        applicationId: spec.applicationId,
      });
    }
    if (!(await serviceActive(spec.phpVersion))) {
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
      phpVersion: spec.phpVersion,
      packageVersion: packageState.version,
      unixUser: spec.unixUser,
      unixUid: identity.uid,
      unixGid: identity.gid,
      configPath,
      configSha256: spec.preview.sha256,
      socketPath,
      serviceUnit: phpFpmServiceUnit(spec.phpVersion),
      documentRoot: spec.templateInput.documentRoot,
      documentRootMode: documentRoot.mode,
    });
  }

  async function restoreConfig(spec, receipt) {
    if (receipt.previousRuntime) return restoreVersion(spec, receipt);
    const configPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion);
    if (!receipt.mutated) return;
    if (receipt.previousConfig === null) {
      await rmFn(configPath, { force: true });
    } else {
      await atomicWrite(configPath, receipt.previousConfig, phpFpmTemplatePolicy.poolMode);
    }
    await configTest(spec.phpVersion);
    await reloadServiceIfActive(spec.phpVersion);
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

    await ensurePackage(spec.phpVersion);
    await mkdirFn(phpFpmPoolDirectory(spec.phpVersion), { recursive: true, mode: 0o755 });
    const configPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion);
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
      await configTest(spec.phpVersion);
      await activateService(spec.phpVersion);
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

  async function update(rawIntent, { previousIntent, operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent), previous = normalizeIntent(previousIntent);
    const operationId = normalizeOperationId(rawOperationId);
    if (['websiteId', 'applicationId', 'unixUser'].some((key) => spec[key] !== previous[key])
      || spec.templateInput.documentRoot !== previous.templateInput.documentRoot) {
      throw new PhpFpmSiteManagerError('php_fpm_update_binding_changed', 'PHP runtime transition requires a separate verified migration');
    }
    if (spec.phpVersion !== previous.phpVersion) return updateVersion(rawIntent, previousIntent, operationId, spec, previous);
    const configPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion);
    let receipt = await loadReceipt(operationId, spec);
    if (receipt?.state === 'compensated') throw new PhpFpmSiteManagerError('php_fpm_operation_compensated', 'PHP configuration was rolled back');
    if (!receipt) {
      const before = await inspect(previousIntent);
      if (!before.satisfied) throw new PhpFpmSiteManagerError('php_fpm_update_unverified', 'Current PHP configuration could not be verified');
      const current = await readOptional(configPath);
      if (current === null || sha256(current) !== previous.preview.sha256) throw new PhpFpmSiteManagerError('php_fpm_pool_drift', 'PHP configuration changed before update');
      receipt = await persistReceipt(operationId, spec, { mutated: true, previousConfig: current, state: 'prepared' });
    }
    if (receipt.state === 'active') return inspect(rawIntent);
    const current = await readOptional(configPath);
    if (current !== receipt.previousConfig && (current === null || sha256(current) !== spec.preview.sha256)) {
      throw new PhpFpmSiteManagerError('php_fpm_pool_drift', 'PHP configuration changed after update checkpoint');
    }
    try {
      await atomicWrite(configPath, renderWebsitePhpFpmPool(spec.templateInput), phpFpmTemplatePolicy.poolMode);
      await configTest(spec.phpVersion);
      await reloadServiceIfActive(spec.phpVersion);
      const after = await inspect(rawIntent);
      if (!after.satisfied) throw new PhpFpmSiteManagerError('php_fpm_update_unverified', 'Updated PHP configuration could not be verified');
      await persistReceipt(operationId, spec, { ...receipt, state: 'active' });
      return Object.freeze({ ...after, updated: true });
    } catch (error) {
      try {
        await restoreConfig(spec, receipt);
        await persistReceipt(operationId, spec, { ...receipt, state: 'compensated' });
      } catch { throw new PhpFpmSiteManagerError('php_fpm_update_rollback_failed', 'PHP update failed and rollback requires reconciliation'); }
      throw error;
    }
  }

  function previousRuntimeIntent(spec, receipt) {
    return { websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser,
      documentRoot: spec.templateInput.documentRoot, ...receipt.previousRuntime };
  }
  function previousVersionSpec(spec, receipt) { return normalizeIntent(previousRuntimeIntent(spec, receipt)); }

  async function socketListening(socketPath) {
    try {
      const result = await run('/usr/bin/ss', ['-H', '-xl'], { timeout: 10_000 });
      const output = String(result.stdout ?? '');
      if (Buffer.byteLength(output) > 1024 * 1024) throw new Error('Socket inventory too large');
      return output.split('\n').some(line => line.trim().split(/\s+/).includes(socketPath));
    } catch { throw new PhpFpmSiteManagerError('php_fpm_socket_owner_unverified', 'Website PHP socket listeners could not be verified'); }
  }
  async function releaseSocket(spec) {
    const socket = phpFpmSocketPath(spec.unixUser);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!await socketListening(socket)) {
        try {
          const metadata = await lstatFn(socket);
          if (!metadata.isSocket?.() || modeOf(metadata) !== 0o660) throw new PhpFpmSiteManagerError('php_fpm_socket_drift', 'Website PHP socket changed during transition');
          await rmFn(socket, { force: true });
        } catch (error) { if (!missingPath(error)) throw error; }
        return;
      }
      await delay(100);
    }
    throw new PhpFpmSiteManagerError('php_fpm_socket_transition_busy', 'The old PHP pool is still serving requests; its configuration was restored');
  }
  async function validateVersionCandidate(spec, operationId) {
    await configTest(spec.phpVersion);
    const candidate = path.posix.join(receiptRoot, `${operationId}.candidate-pool`);
    const config = path.posix.join(receiptRoot, `${operationId}.candidate-config`);
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    try {
      await atomicWrite(candidate, renderWebsitePhpFpmPool(spec.templateInput), phpFpmTemplatePolicy.poolMode);
      await atomicWrite(config, `[global]\ndaemonize = no\ninclude = ${candidate}\n`, 0o600);
      await run(phpFpmBinaryPath(spec.phpVersion), ['--test', '--fpm-config', config], { timeout: 30_000 });
    } catch { throw new PhpFpmSiteManagerError('php_fpm_config_test_failed', 'New PHP version configuration failed validation'); }
    finally { await rmFn(candidate, { force: true }); await rmFn(config, { force: true }); }
  }
  async function updateVersion(rawIntent, previousIntent, operationId, spec, previous) {
    const oldPath = phpFpmPoolPath(spec.unixUser, previous.phpVersion), newPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion);
    let receipt = await loadReceipt(operationId, spec);
    if (receipt?.state === 'compensated') throw new PhpFpmSiteManagerError('php_fpm_operation_compensated', 'PHP version change was rolled back');
    if (!receipt) {
      if (!(await inspectPackage(spec.phpVersion)).installed || !await serviceActive(spec.phpVersion)) throw new PhpFpmSiteManagerError('php_fpm_version_unavailable', 'Selected PHP version must already be installed and active');
      if (!(await inspect(previousIntent)).satisfied || await readOptional(newPath) !== null) throw new PhpFpmSiteManagerError('php_fpm_update_unverified', 'Current PHP pool or target version ownership could not be verified');
      await validateVersionCandidate(spec, operationId);
      receipt = await persistReceipt(operationId, spec, { mutated: true, previousConfig: null, state: 'prepared',
        previousRuntime: { phpVersion: previous.phpVersion, maxChildren: previous.templateInput.maxChildren ?? phpFpmTemplatePolicy.defaultMaxChildren,
          memoryLimitMb: previous.templateInput.memoryLimitMb ?? phpFpmTemplatePolicy.defaultMemoryLimitMb,
          maxExecutionSeconds: previous.templateInput.maxExecutionSeconds ?? phpFpmTemplatePolicy.defaultMaxExecutionSeconds },
        previousPoolConfig: await readOptional(oldPath) });
    }
    if (!receipt.previousRuntime || receipt.previousRuntime.phpVersion !== previous.phpVersion) throw new PhpFpmSiteManagerError('php_fpm_receipt_invalid', 'PHP version change does not match its checkpoint');
    const oldConfig = await readOptional(oldPath), newConfig = await readOptional(newPath);
    if (oldConfig !== null && oldConfig !== receipt.previousPoolConfig || newConfig !== null && sha256(newConfig) !== spec.preview.sha256) throw new PhpFpmSiteManagerError('php_fpm_pool_drift', 'PHP pool changed after the transition checkpoint');
    if (receipt.state === 'active') {
      if (oldConfig !== null) throw new PhpFpmSiteManagerError('php_fpm_pool_drift', 'Old PHP pool reappeared after transition');
      const inspected = await inspect(rawIntent);
      if (!inspected.satisfied) throw new PhpFpmSiteManagerError('php_fpm_update_unverified', 'Active PHP version could not be verified');
      return inspected;
    }
    try {
      if (oldConfig !== null) {
        await rmFn(oldPath, { force: true }); await configTest(previous.phpVersion); await reloadServiceIfActive(previous.phpVersion);
        await releaseSocket(previous);
      } else if (newConfig === null) await releaseSocket(previous);
      if (newConfig === null) await atomicWrite(newPath, renderWebsitePhpFpmPool(spec.templateInput), phpFpmTemplatePolicy.poolMode);
      await configTest(spec.phpVersion); await reloadServiceIfActive(spec.phpVersion);
      let inspected;
      for (let attempt = 0; attempt < 30; attempt++) {
        inspected = await inspect(rawIntent);
        if (inspected.satisfied && await socketListening(phpFpmSocketPath(spec.unixUser))) break;
        await delay(100);
      }
      if (!inspected?.satisfied || !await socketListening(phpFpmSocketPath(spec.unixUser))) throw new PhpFpmSiteManagerError('php_fpm_update_unverified', 'New PHP pool did not become ready');
      await persistReceipt(operationId, spec, { ...receipt, state: 'active' });
      return Object.freeze({ ...inspected, updated: true, previousPhpVersion: previous.phpVersion });
    } catch (error) {
      try { await restoreVersion(spec, receipt); await persistReceipt(operationId, spec, { ...receipt, state: 'compensated' }); }
      catch { throw new PhpFpmSiteManagerError('php_fpm_update_rollback_failed', 'PHP version change failed and rollback requires reconciliation'); }
      throw error;
    }
  }
  async function restoreVersion(spec, receipt) {
    const previous = previousVersionSpec(spec, receipt);
    const newPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion), oldPath = phpFpmPoolPath(spec.unixUser, previous.phpVersion);
    const oldConfig = await readOptional(oldPath), newConfig = await readOptional(newPath);
    if (newConfig !== null && sha256(newConfig) !== spec.preview.sha256 || oldConfig !== null && oldConfig !== receipt.previousPoolConfig) throw new PhpFpmSiteManagerError('php_fpm_compensation_drift', 'PHP version pool changed before rollback');
    if (newConfig !== null) {
      await rmFn(newPath, { force: true }); await configTest(spec.phpVersion); await reloadServiceIfActive(spec.phpVersion); await releaseSocket(spec);
    }
    await atomicWrite(oldPath, receipt.previousPoolConfig, phpFpmTemplatePolicy.poolMode);
    await configTest(previous.phpVersion); await reloadServiceIfActive(previous.phpVersion);
    let inspected;
    for (let attempt = 0; attempt < 30; attempt++) {
      inspected = await inspect(previousRuntimeIntent(spec, receipt)); if (inspected.satisfied) return; await delay(100);
    }
    throw new PhpFpmSiteManagerError('php_fpm_compensation_unverified', 'Previous PHP version could not be verified after rollback');
  }
  async function availableVersions() {
    const versions = await Promise.all(phpFpmTemplatePolicy.supportedVersions.map(async version => (await inspectPackage(version)).installed && await serviceActive(version) ? version : null));
    return Object.freeze(versions.filter(Boolean));
  }

  async function inspectMigrationOperation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReceipt(operationId, spec);
    if (!receipt) return Object.freeze({ satisfied: false, reason: 'php_fpm_receipt_missing' });
    if (receipt.state !== 'active' || receipt.mutated !== true || receipt.previousConfig !== null) {
      return Object.freeze({ satisfied: false, reason: 'php_fpm_migration_receipt_not_active' });
    }
    const inspected = await inspect(rawIntent);
    if (!inspected?.satisfied) return inspected;
    return Object.freeze({
      ...inspected,
      phpFpmReceiptVersion: RECEIPT_VERSION,
      createdPhpFpmPool: true,
    });
  }

  async function applyMigration(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const preview = await previewMigration(rawIntent, { operationId });
    if (preview.satisfied === true) {
      const receipt = await loadReceipt(operationId, spec);
      if (receipt?.state === 'active' && receipt.mutated === true && receipt.previousConfig === null) {
        return inspectMigrationOperation(rawIntent, { operationId });
      }
      throw new PhpFpmSiteManagerError(
        'php_fpm_migration_not_operation_owned',
        'Existing PHP-FPM Website pool is not owned by this migration operation',
      );
    }
    if (preview.safeCreateCandidate !== true) {
      throw new PhpFpmSiteManagerError(
        'php_fpm_migration_not_safe_create',
        'PHP-FPM migration is blocked because shared runtime or Website-specific state requires non-owned mutation',
      );
    }

    const desired = renderWebsitePhpFpmPool(spec.templateInput);
    const configPath = phpFpmPoolPath(spec.unixUser, spec.phpVersion);
    let receipt = await loadReceipt(operationId, spec);
    if (receipt?.state === 'compensated') {
      throw new PhpFpmSiteManagerError('php_fpm_operation_compensated', 'Compensated PHP-FPM Website operation cannot be re-applied');
    }
    if (!receipt) {
      const current = await readOptional(configPath);
      if (current !== null) {
        throw new PhpFpmSiteManagerError('php_fpm_pool_conflict', 'Existing PHP-FPM Website pool is not owned by this operation');
      }
      receipt = await persistReceipt(operationId, spec, {
        mutated: true,
        previousConfig: null,
        state: 'prepared',
      });
    }
    if (receipt.mutated !== true || receipt.previousConfig !== null) {
      throw new PhpFpmSiteManagerError(
        'php_fpm_migration_not_operation_owned',
        'PHP-FPM migration receipt does not prove safe-create ownership',
      );
    }

    const currentAfterReceipt = await readOptional(configPath);
    if (currentAfterReceipt !== null && sha256(currentAfterReceipt) !== receipt.configSha256) {
      throw new PhpFpmSiteManagerError(
        'php_fpm_pool_drift',
        'PHP-FPM Website pool changed after durable migration checkpoint',
      );
    }
    if (currentAfterReceipt === null) {
      await atomicWrite(configPath, desired, phpFpmTemplatePolicy.poolMode);
    }
    await configTest(spec.phpVersion);
    if (!(await serviceActive(spec.phpVersion))) {
      throw new PhpFpmSiteManagerError(
        'php_fpm_migration_shared_service_inactive',
        'PHP-FPM migration will not activate a shared service implicitly',
      );
    }
    await reloadServiceIfActive(spec.phpVersion);
    const verified = await inspect(rawIntent);
    if (!verified?.satisfied) {
      throw new PhpFpmSiteManagerError('php_fpm_migration_unverified', 'PHP-FPM migration could not be verified');
    }
    receipt = await persistReceipt(operationId, spec, { ...receipt, state: 'active' });
    return Object.freeze({
      ...verified,
      phpFpmReceiptVersion: RECEIPT_VERSION,
      createdPhpFpmPool: true,
    });
  }

  async function inspectCompensation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReceipt(operationId, spec);
    if (!receipt || !receipt.mutated) {
      return Object.freeze({ satisfied: true, restoredPrevious: false, preservedExisting: true });
    }
    if (receipt.previousRuntime) {
      const previous = previousVersionSpec(spec, receipt);
      const oldConfig = await readOptional(phpFpmPoolPath(spec.unixUser, previous.phpVersion));
      const newConfig = await readOptional(phpFpmPoolPath(spec.unixUser, spec.phpVersion));
      if (oldConfig !== null && oldConfig !== receipt.previousPoolConfig || newConfig !== null && sha256(newConfig) !== spec.preview.sha256) return Object.freeze({ satisfied: false, reason: 'php_fpm_compensation_drift' });
      const verified = oldConfig === receipt.previousPoolConfig && newConfig === null && (await inspect(previousRuntimeIntent(spec, receipt))).satisfied;
      return Object.freeze({ satisfied: verified, reason: verified ? null : 'php_fpm_compensation_pending', restoredPrevious: verified, preservedExisting: false });
    }
    if (receipt.state === 'compensated') {
      return Object.freeze({ satisfied: true, restoredPrevious: receipt.previousConfig !== null, preservedExisting: false });
    }
    const current = await readOptional(phpFpmPoolPath(spec.unixUser, spec.phpVersion));
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

  async function inspectRetirement(rawIntent) {
    const spec = normalizeIntent(rawIntent);
    const targets = phpFpmTemplatePolicy.supportedVersions.map(version => phpFpmPoolPath(spec.unixUser, version));
    targets.push(phpFpmSocketPath(spec.unixUser));
    for (const target of targets) {
      try {
        await lstatFn(target);
        return Object.freeze({ satisfied: false, reason: 'php_fpm_retirement_pending',
          websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser });
      } catch (error) {
        if (!missingPath(error)) throw new PhpFpmSiteManagerError('php_fpm_retirement_unavailable',
          'The Website PHP pool or socket could not be inspected');
      }
    }
    if (await socketListening(phpFpmSocketPath(spec.unixUser))) {
      return Object.freeze({ satisfied: false, reason: 'php_fpm_retirement_listener_pending',
        websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser });
    }
    return Object.freeze({ satisfied: true, poolRemoved: true, socketRemoved: true,
      websiteId: spec.websiteId, applicationId: spec.applicationId, unixUser: spec.unixUser });
  }

  async function retireCurrent(rawIntent, currentIntent, operationId, originalReceipt) {
    const original = normalizeIntent(rawIntent), current = normalizeIntent(currentIntent);
    if (['websiteId', 'applicationId', 'unixUser'].some(key => current[key] !== original[key])
      || current.templateInput.documentRoot !== original.templateInput.documentRoot) {
      throw new PhpFpmSiteManagerError('php_fpm_retirement_binding_changed',
        'PHP retirement cannot change the provisioning identity or document root');
    }
    // This is a deletion checkpoint, not update compensation: restoring an older
    // pool would leave a shared PHP service pointing at the deleted Website.
    const checkpointPath = path.posix.join(receiptRoot, `${operationId}.retirement.json`);
    const expected = { version: 1, operationId, websiteId: current.websiteId,
      applicationId: current.applicationId, unixUser: current.unixUser,
      provisioningDigest: specDigest(original), retirementDigest: specDigest(current),
      phpVersion: current.phpVersion, configSha256: current.preview.sha256 };
    let checkpoint = null;
    const stored = await readOptional(checkpointPath);
    if (stored !== null) {
      try { checkpoint = JSON.parse(stored); } catch { /* Rejected below. */ }
      if (!checkpoint || Object.keys(checkpoint).length !== Object.keys(expected).length + 1
        || Object.entries(expected).some(([key, value]) => checkpoint[key] !== value)
        || !['prepared', 'retired'].includes(checkpoint.state)) {
        throw new PhpFpmSiteManagerError('php_fpm_retirement_checkpoint_invalid',
          'PHP retirement no longer matches its durable deletion checkpoint');
      }
    }
    const configPath = phpFpmPoolPath(current.unixUser, current.phpVersion);
    let present = false;
    // A version transition must have removed the old pool. Never guess ownership
    // of another version or remove a second pool that could serve the same socket.
    for (const version of phpFpmTemplatePolicy.supportedVersions) {
      const target = phpFpmPoolPath(current.unixUser, version);
      let metadata;
      try { metadata = await lstatFn(target); }
      catch (error) { if (missingPath(error)) continue; throw error; }
      if (target !== configPath || !metadata.isFile?.() || metadata.isSymbolicLink?.()
        || metadata.uid !== 0 || metadata.gid !== 0 || modeOf(metadata) !== phpFpmTemplatePolicy.poolMode
        || sha256(await readFileFn(target, 'utf8')) !== current.preview.sha256) {
        throw new PhpFpmSiteManagerError('php_fpm_retirement_pool_drift',
          'PHP retirement requires the exact registered pool and no other version pool');
      }
      present = true;
    }
    if (present && (checkpoint?.state === 'retired' || originalReceipt.state === 'compensated')) {
      throw new PhpFpmSiteManagerError('php_fpm_retirement_pool_drift',
        'A PHP pool reappeared after its ownership was retired');
    }
    if (!checkpoint) {
      checkpoint = { ...expected, state: 'prepared' };
      await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
      await atomicWrite(checkpointPath, `${JSON.stringify(checkpoint)}\n`, 0o600);
    }
    if (present) await rmFn(configPath, { force: true });
    await configTest(current.phpVersion);
    await reloadServiceIfActive(current.phpVersion);
    await releaseSocket(current);
    const result = await inspectRetirement(currentIntent);
    if (!result.satisfied) throw new PhpFpmSiteManagerError('php_fpm_retirement_unverified',
      'The Website PHP pool or socket is still present');
    if (checkpoint.state !== 'retired') {
      await atomicWrite(checkpointPath, `${JSON.stringify({ ...expected, state: 'retired' })}\n`, 0o600);
    }
    return result;
  }

  async function retire(rawIntent, options = {}) {
    const spec = normalizeIntent(rawIntent);
    const operationId = normalizeOperationId(options.operationId);
    const receipt = await loadReceipt(operationId, spec);
    if (!receipt || receipt.mutated !== true || receipt.previousConfig !== null || receipt.previousRuntime) {
      throw new PhpFpmSiteManagerError('php_fpm_retirement_not_owned',
        'The provisioning receipt does not prove exclusive ownership of this PHP pool');
    }
    return retireCurrent(rawIntent, options.currentIntent ?? rawIntent, operationId, receipt);
  }

  return Object.freeze({
    inspect,
    availableVersions,
    previewMigration,
    inspectMigrationOperation,
    applyMigration,
    apply,
    update,
    compensate,
    inspectCompensation,
    retire,
    inspectRetirement,
  });
}

export const phpFpmSiteManagerInternals = Object.freeze({
  normalizeIntent,
  normalizeOperationId,
  specDigest,
  modeOf,
  paths: Object.freeze({
    DPKG_QUERY_PATH,
    APT_GET_PATH,
    APT_CACHE_PATH,
    SYSTEMCTL_PATH,
    RECEIPT_ROOT,
  }),
  packageName: phpFpmPackageName,
  binaryPath: phpFpmBinaryPath,
  serviceUnit: phpFpmServiceUnit,
});
