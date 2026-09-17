import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod, chown, lstat, mkdir, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  phpMyAdminFpmTemplatePolicy,
  phpMyAdminNginxTemplatePolicy,
  phpMyAdminSignonTemplatePolicy,
} from '@yunpanel/config-templates';
import { createPhpMyAdminConfigBackupManager } from './phpmyadmin-config-backup.js';
import { createPhpMyAdminConfigManager } from './phpmyadmin-config-manager.js';
import { parseManagedSystemIdentity } from './mail-vmail-identity.js';

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GROUP_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const MAX_OUTPUT = 128 * 1024;
const GETENT = '/usr/bin/getent';
const ID = '/usr/bin/id';
const PHP = '/usr/bin/php';
const PHP_FPM = '/usr/sbin/php-fpm8.3';
const NGINX = '/usr/sbin/nginx';
const CURL = '/usr/bin/curl';
const SYSTEMCTL = '/usr/bin/systemctl';
const ROOT_UID = 0;
const ROOT_GID = 0;
const CONFIG_MODE = 0o640;
const PRIVATE_DIRECTORY_MODE = 0o700;
const SIGNON_BRIDGE_DIRECTORY_MODE = 0o750;
const GATEWAY_DIRECTORY_MODE = 0o2770;
const SOCKET_MODE = 0o660;
const GATEWAY_DIRECTORY = '/run/yunpanel';

export class PhpMyAdminConfigActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpMyAdminConfigActivationError';
    this.code = code;
  }
}

function activationError(code, message) {
  return new PhpMyAdminConfigActivationError(code, message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function boundedOutput(result) {
  const stdout = String(result?.stdout ?? result ?? '');
  const stderr = String(result?.stderr ?? '');
  if (Buffer.byteLength(stdout) > MAX_OUTPUT || Buffer.byteLength(stderr) > MAX_OUTPUT) {
    throw new Error('bounded output exceeded');
  }
  return stdout.trim();
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key));
}

const BUNDLE_KEYS = new Set(['version', 'fpm', 'nginx', 'signonConfig', 'signonBridge']);
const FPM_KEYS = new Set([
  'version', 'sha256', 'artifact', 'socketPath', 'serviceUnit', 'runtimeUser', 'runtimeGroup',
  'temporaryDirectory', 'sessionDirectory',
]);
const NGINX_KEYS = new Set([
  'version', 'sha256', 'artifact', 'documentRoot', 'fpmSocketPath', 'gatewaySocketPath',
  'gatewaySocketMode', 'gatewaySocketOwner', 'gatewaySocketGroup', 'signonBridgePath',
  'internalSignonPath', 'healthPath', 'serviceUnit',
]);
const SIGNON_CONFIG_KEYS = new Set([
  'version', 'sha256', 'artifact', 'signonSession', 'gatewayBasePath',
]);
const SIGNON_BRIDGE_KEYS = new Set([
  'version', 'sha256', 'artifact', 'handoffSocketPath', 'signonSession',
  'internalSignonPath', 'gatewayBasePath',
]);
const ARTIFACT_KEYS = new Set(['path', 'sha256', 'bytes', 'sensitive', 'mode']);

function validateArtifact(artifact, { path: expectedPath, mode }) {
  return exactKeys(artifact, ARTIFACT_KEYS)
    && artifact.path === expectedPath
    && typeof artifact.sha256 === 'string' && SHA256_PATTERN.test(artifact.sha256)
    && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0
    && artifact.sensitive === false
    && artifact.mode === mode;
}

function validatePreview(preview) {
  if (!exactKeys(preview, BUNDLE_KEYS) || preview.version !== 1
    || !exactKeys(preview.fpm, FPM_KEYS) || preview.fpm.version !== 1
    || typeof preview.fpm.sha256 !== 'string' || !SHA256_PATTERN.test(preview.fpm.sha256)
    || !validateArtifact(preview.fpm.artifact, {
      path: phpMyAdminFpmTemplatePolicy.poolPath,
      mode: phpMyAdminFpmTemplatePolicy.poolMode,
    })
    || preview.fpm.artifact.sha256 !== preview.fpm.sha256
    || preview.fpm.socketPath !== phpMyAdminFpmTemplatePolicy.socketPath
    || preview.fpm.serviceUnit !== phpMyAdminFpmTemplatePolicy.serviceUnit
    || preview.fpm.runtimeUser !== phpMyAdminFpmTemplatePolicy.runtimeUser
    || preview.fpm.runtimeGroup !== phpMyAdminFpmTemplatePolicy.runtimeGroup
    || preview.fpm.temporaryDirectory !== phpMyAdminFpmTemplatePolicy.temporaryDirectory
    || preview.fpm.sessionDirectory !== phpMyAdminFpmTemplatePolicy.sessionDirectory
    || !exactKeys(preview.nginx, NGINX_KEYS) || preview.nginx.version !== 1
    || typeof preview.nginx.sha256 !== 'string' || !SHA256_PATTERN.test(preview.nginx.sha256)
    || !validateArtifact(preview.nginx.artifact, {
      path: phpMyAdminNginxTemplatePolicy.configPath,
      mode: phpMyAdminNginxTemplatePolicy.configMode,
    })
    || preview.nginx.artifact.sha256 !== preview.nginx.sha256
    || preview.nginx.documentRoot !== phpMyAdminNginxTemplatePolicy.documentRoot
    || preview.nginx.fpmSocketPath !== phpMyAdminNginxTemplatePolicy.fpmSocketPath
    || preview.nginx.gatewaySocketPath !== phpMyAdminNginxTemplatePolicy.gatewaySocketPath
    || preview.nginx.gatewaySocketMode !== phpMyAdminNginxTemplatePolicy.gatewaySocketMode
    || preview.nginx.gatewaySocketOwner !== phpMyAdminNginxTemplatePolicy.gatewaySocketOwner
    || preview.nginx.gatewaySocketGroup !== phpMyAdminNginxTemplatePolicy.gatewaySocketGroup
    || preview.nginx.signonBridgePath !== phpMyAdminNginxTemplatePolicy.signonBridgePath
    || preview.nginx.internalSignonPath !== phpMyAdminNginxTemplatePolicy.internalSignonPath
    || preview.nginx.healthPath !== phpMyAdminNginxTemplatePolicy.healthPath
    || preview.nginx.serviceUnit !== phpMyAdminNginxTemplatePolicy.serviceUnit
    || !exactKeys(preview.signonConfig, SIGNON_CONFIG_KEYS) || preview.signonConfig.version !== 1
    || typeof preview.signonConfig.sha256 !== 'string' || !SHA256_PATTERN.test(preview.signonConfig.sha256)
    || !validateArtifact(preview.signonConfig.artifact, {
      path: phpMyAdminSignonTemplatePolicy.configPath,
      mode: phpMyAdminSignonTemplatePolicy.configMode,
    })
    || preview.signonConfig.artifact.sha256 !== preview.signonConfig.sha256
    || preview.signonConfig.signonSession !== phpMyAdminSignonTemplatePolicy.signonSession
    || preview.signonConfig.gatewayBasePath !== phpMyAdminSignonTemplatePolicy.gatewayBasePath
    || !exactKeys(preview.signonBridge, SIGNON_BRIDGE_KEYS) || preview.signonBridge.version !== 1
    || typeof preview.signonBridge.sha256 !== 'string' || !SHA256_PATTERN.test(preview.signonBridge.sha256)
    || !validateArtifact(preview.signonBridge.artifact, {
      path: phpMyAdminSignonTemplatePolicy.bridgePath,
      mode: phpMyAdminSignonTemplatePolicy.bridgeMode,
    })
    || preview.signonBridge.artifact.sha256 !== preview.signonBridge.sha256
    || preview.signonBridge.handoffSocketPath !== phpMyAdminSignonTemplatePolicy.handoffSocketPath
    || preview.signonBridge.signonSession !== phpMyAdminSignonTemplatePolicy.signonSession
    || preview.signonBridge.internalSignonPath !== phpMyAdminSignonTemplatePolicy.internalSignonPath
    || preview.signonBridge.gatewayBasePath !== phpMyAdminSignonTemplatePolicy.gatewayBasePath) {
    throw activationError(
      'phpmyadmin_activation_preview_invalid',
      'phpMyAdmin activation preview is invalid',
    );
  }
  return preview;
}

function previewSha256(preview) {
  const expected = validatePreview(preview);
  return sha256(JSON.stringify({
    version: 1,
    fpmSha256: expected.fpm.sha256,
    nginxSha256: expected.nginx.sha256,
    signonConfigSha256: expected.signonConfig.sha256,
    signonBridgeSha256: expected.signonBridge.sha256,
  }));
}

function validateTransactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_PATTERN.test(value)) {
    throw activationError(
      'phpmyadmin_activation_transaction_invalid',
      'phpMyAdmin activation transaction ID is invalid',
    );
  }
  return value.toLowerCase();
}

function parseGroupIdentity(value, expectedName) {
  if (typeof expectedName !== 'string' || !GROUP_NAME_PATTERN.test(expectedName)) return null;
  const fields = String(value ?? '').trim().split(':');
  if (fields.length !== 4 || fields[0] !== expectedName || !/^\d+$/.test(fields[2])) return null;
  const gid = Number.parseInt(fields[2], 10);
  if (!Number.isSafeInteger(gid) || gid <= 0) return null;
  return Object.freeze({ gid });
}

export function createPhpMyAdminConfigActivator({
  configManager = createPhpMyAdminConfigManager(),
  backupManager = createPhpMyAdminConfigBackupManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (!configManager || typeof configManager.inspectStagedFpmPool !== 'function'
    || typeof configManager.inspectStagedNginxConfig !== 'function'
    || typeof configManager.inspectStagedSignonConfig !== 'function'
    || typeof configManager.inspectStagedSignonBridge !== 'function'
    || typeof configManager.stagedFpmPath !== 'function'
    || typeof configManager.stagedNginxPath !== 'function'
    || typeof configManager.stagedSignonConfigPath !== 'function'
    || typeof configManager.stagedSignonBridgePath !== 'function') {
    throw activationError(
      'phpmyadmin_config_manager_invalid',
      'phpMyAdmin staging manager is unavailable',
    );
  }
  if (!backupManager || typeof backupManager.backupConfiguration !== 'function'
    || typeof backupManager.restoreConfiguration !== 'function'
    || typeof backupManager.loadManifest !== 'function') {
    throw activationError(
      'phpmyadmin_backup_manager_invalid',
      'phpMyAdmin backup manager is unavailable',
    );
  }

  let activationChain = Promise.resolve();

  async function runCommand(file, args, code, message, options = {}) {
    try {
      const result = await run(file, args, {
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT,
        ...options,
      });
      boundedOutput(result);
      return result;
    } catch {
      throw activationError(code, message);
    }
  }

  async function resolveIdentity(name, code) {
    try {
      const result = await run(GETENT, ['passwd', name], {
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT,
      });
      const identity = parseManagedSystemIdentity(boundedOutput(result), name);
      if (!identity) throw new Error('invalid identity');
      return identity;
    } catch {
      throw activationError(code, 'phpMyAdmin runtime identity could not be resolved safely');
    }
  }

  async function resolveGroup(name, code) {
    try {
      const result = await run(GETENT, ['group', name], {
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT,
      });
      const identity = parseGroupIdentity(boundedOutput(result), name);
      if (!identity) throw new Error('invalid group');
      return identity;
    } catch {
      throw activationError(code, 'phpMyAdmin gateway group could not be resolved safely');
    }
  }

  async function assertPackageGroupMembership() {
    try {
      const result = await run(ID, ['-nG', phpMyAdminFpmTemplatePolicy.runtimeUser], {
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT,
      });
      const groups = new Set(boundedOutput(result).split(/\s+/).filter(Boolean));
      if (!groups.has('www-data')) throw new Error('missing package config group');
    } catch {
      throw activationError(
        'phpmyadmin_runtime_group_unavailable',
        'phpMyAdmin runtime user cannot traverse the package configuration group',
      );
    }
  }

  async function assertDirectory(targetPath, { uid, gid, mode }) {
    try {
      const metadata = await lstatFn(targetPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || metadata.uid !== uid || metadata.gid !== gid || (metadata.mode & 0o7777) !== mode) {
        throw new Error('unsafe directory');
      }
    } catch {
      throw activationError(
        'phpmyadmin_runtime_directory_unsafe',
        'phpMyAdmin private runtime directory is unavailable or unsafe',
      );
    }
  }

  async function assertParentDirectory(targetPath) {
    try {
      const metadata = await lstatFn(targetPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe parent');
    } catch {
      throw activationError(
        'phpmyadmin_configuration_parent_unsafe',
        'phpMyAdmin configuration directory is unavailable or unsafe',
      );
    }
  }

  async function assertSignonBridgeDirectory(runtimeIdentity) {
    try {
      const metadata = await lstatFn(phpMyAdminSignonTemplatePolicy.bridgeDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || metadata.uid !== ROOT_UID || metadata.gid !== runtimeIdentity.gid
        || (metadata.mode & 0o7777) !== SIGNON_BRIDGE_DIRECTORY_MODE) {
        throw new Error('unsafe signon bridge directory');
      }
    } catch {
      throw activationError(
        'phpmyadmin_signon_bridge_directory_unsafe',
        'phpMyAdmin signon bridge directory is unavailable or unsafe',
      );
    }
  }

  async function ensureGatewayDirectory(gatewayGroup) {
    let metadata;
    try {
      metadata = await lstatFn(GATEWAY_DIRECTORY);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe gateway directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw activationError(
          'phpmyadmin_gateway_directory_unsafe',
          'phpMyAdmin gateway runtime directory is unsafe',
        );
      }
      try {
        await mkdirFn(GATEWAY_DIRECTORY, { mode: GATEWAY_DIRECTORY_MODE });
        await chownFn(GATEWAY_DIRECTORY, ROOT_UID, gatewayGroup.gid);
        await chmodFn(GATEWAY_DIRECTORY, GATEWAY_DIRECTORY_MODE);
        metadata = await lstatFn(GATEWAY_DIRECTORY);
      } catch {
        throw activationError(
          'phpmyadmin_gateway_directory_unavailable',
          'phpMyAdmin gateway runtime directory could not be prepared',
        );
      }
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.uid !== ROOT_UID || metadata.gid !== gatewayGroup.gid
      || (metadata.mode & 0o7777) !== GATEWAY_DIRECTORY_MODE) {
      throw activationError(
        'phpmyadmin_gateway_directory_unsafe',
        'phpMyAdmin gateway runtime directory is unsafe',
      );
    }
  }

  async function readStaged(targetPath, expectedSha256, expectedBytes) {
    try {
      const metadata = await lstatFn(targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || (metadata.mode & 0o7777) !== CONFIG_MODE) {
        throw new Error('unsafe stage');
      }
      const content = await readFileFn(targetPath);
      if (content.length !== expectedBytes || sha256(content) !== expectedSha256) {
        throw new Error('changed stage');
      }
      return content;
    } catch {
      throw activationError(
        'phpmyadmin_stage_changed',
        'phpMyAdmin staged configuration changed before activation',
      );
    }
  }

  async function atomicReplace(targetPath, content, { gid = ROOT_GID, mode = CONFIG_MODE } = {}) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { mode, flag: 'wx' });
      await chownFn(temporaryPath, ROOT_UID, gid);
      await chmodFn(temporaryPath, mode);
      await renameFn(temporaryPath, targetPath);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function validateFpmConfig() {
    await runCommand(
      PHP_FPM,
      ['-t'],
      'phpmyadmin_fpm_config_invalid',
      'phpMyAdmin PHP-FPM configuration validation failed',
    );
  }

  async function validateNginxConfig() {
    await runCommand(
      NGINX,
      ['-t'],
      'phpmyadmin_nginx_config_invalid',
      'phpMyAdmin Nginx configuration validation failed',
    );
  }

  async function validatePhpFile(targetPath, code, message) {
    await runCommand(PHP, ['-l', targetPath], code, message);
  }

  async function reloadFpm() {
    await runCommand(
      SYSTEMCTL,
      ['reload', phpMyAdminFpmTemplatePolicy.serviceUnit],
      'phpmyadmin_fpm_reload_failed',
      'phpMyAdmin PHP-FPM reload failed',
    );
    await runCommand(
      SYSTEMCTL,
      ['is-active', '--quiet', phpMyAdminFpmTemplatePolicy.serviceUnit],
      'phpmyadmin_fpm_health_failed',
      'phpMyAdmin PHP-FPM service is not active',
    );
  }

  async function reloadNginx() {
    await runCommand(
      SYSTEMCTL,
      ['reload', phpMyAdminNginxTemplatePolicy.serviceUnit],
      'phpmyadmin_nginx_reload_failed',
      'phpMyAdmin Nginx reload failed',
    );
    await runCommand(
      SYSTEMCTL,
      ['is-active', '--quiet', phpMyAdminNginxTemplatePolicy.serviceUnit],
      'phpmyadmin_nginx_health_failed',
      'phpMyAdmin Nginx service is not active',
    );
  }

  async function assertFpmSocket(wwwIdentity, expectedPresent = true) {
    try {
      const metadata = await lstatFn(phpMyAdminFpmTemplatePolicy.socketPath);
      if (!expectedPresent) throw new Error('unexpected FPM socket');
      if (!metadata.isSocket() || metadata.isSymbolicLink()
        || metadata.uid !== wwwIdentity.uid || metadata.gid !== wwwIdentity.gid
        || (metadata.mode & 0o7777) !== SOCKET_MODE) {
        throw new Error('unsafe FPM socket');
      }
    } catch (error) {
      if (!expectedPresent && error?.code === 'ENOENT') return;
      throw activationError(
        expectedPresent ? 'phpmyadmin_fpm_socket_invalid' : 'phpmyadmin_fpm_socket_not_retired',
        expectedPresent
          ? 'phpMyAdmin PHP-FPM socket is unavailable or unsafe'
          : 'phpMyAdmin PHP-FPM socket remained after rollback',
      );
    }
  }

  async function assertGatewaySocket(gatewayGroup, expectedPresent = true) {
    try {
      const metadata = await lstatFn(phpMyAdminNginxTemplatePolicy.gatewaySocketPath);
      if (!expectedPresent) throw new Error('unexpected gateway socket');
      if (!metadata.isSocket() || metadata.isSymbolicLink()) throw new Error('unsafe gateway socket');
      if (metadata.uid !== ROOT_UID || metadata.gid !== gatewayGroup.gid
        || (metadata.mode & 0o7777) !== phpMyAdminNginxTemplatePolicy.gatewaySocketMode) {
        await chownFn(
          phpMyAdminNginxTemplatePolicy.gatewaySocketPath,
          ROOT_UID,
          gatewayGroup.gid,
        );
        await chmodFn(
          phpMyAdminNginxTemplatePolicy.gatewaySocketPath,
          phpMyAdminNginxTemplatePolicy.gatewaySocketMode,
        );
        const repaired = await lstatFn(phpMyAdminNginxTemplatePolicy.gatewaySocketPath);
        if (!repaired.isSocket() || repaired.isSymbolicLink()
          || repaired.uid !== ROOT_UID || repaired.gid !== gatewayGroup.gid
          || (repaired.mode & 0o7777) !== phpMyAdminNginxTemplatePolicy.gatewaySocketMode) {
          throw new Error('gateway socket metadata repair failed');
        }
      }
    } catch (error) {
      if (!expectedPresent && error?.code === 'ENOENT') return;
      throw activationError(
        expectedPresent
          ? 'phpmyadmin_gateway_socket_invalid'
          : 'phpmyadmin_gateway_socket_not_retired',
        expectedPresent
          ? 'phpMyAdmin internal HTTP socket is unavailable or unsafe'
          : 'phpMyAdmin internal HTTP socket remained after rollback',
      );
    }
  }

  async function assertHttpHealthy() {
    await runCommand(
      CURL,
      [
        '--fail', '--silent', '--show-error',
        '--max-time', '10',
        '--unix-socket', phpMyAdminNginxTemplatePolicy.gatewaySocketPath,
        '--output', '/dev/null',
        `http://localhost${phpMyAdminNginxTemplatePolicy.healthPath}`,
      ],
      'phpmyadmin_http_health_failed',
      'phpMyAdmin internal HTTP endpoint did not become healthy',
      { timeout: 15_000 },
    );
  }

  async function rollback(transactionId, wwwIdentity, gatewayGroup) {
    try {
      const manifest = await backupManager.loadManifest(transactionId);
      await backupManager.restoreConfiguration(transactionId);
      if (manifest.files[2]?.exists) {
        await validatePhpFile(
          phpMyAdminSignonTemplatePolicy.configPath,
          'phpmyadmin_signon_config_invalid',
          'Previous phpMyAdmin signon configuration validation failed',
        );
      }
      if (manifest.files[3]?.exists) {
        await validatePhpFile(
          phpMyAdminSignonTemplatePolicy.bridgePath,
          'phpmyadmin_signon_bridge_invalid',
          'Previous phpMyAdmin signon bridge validation failed',
        );
      }
      await validateFpmConfig();
      await validateNginxConfig();
      await reloadFpm();
      await assertFpmSocket(wwwIdentity, manifest.files[0].exists);
      await reloadNginx();
      await assertGatewaySocket(gatewayGroup, manifest.files[1].exists);
    } catch {
      throw activationError(
        'phpmyadmin_config_rollback_failed',
        'phpMyAdmin activation failed and the previous configuration could not be confirmed',
      );
    }
  }

  async function activateNow(preview, { transactionId } = {}) {
    const expected = validatePreview(preview);
    const tx = validateTransactionId(transactionId);
    const [runtimeIdentity, wwwIdentity, gatewayGroup] = await Promise.all([
      resolveIdentity(
        phpMyAdminFpmTemplatePolicy.runtimeUser,
        'phpmyadmin_runtime_identity_unavailable',
      ),
      resolveIdentity(
        phpMyAdminFpmTemplatePolicy.socketOwner,
        'phpmyadmin_web_identity_unavailable',
      ),
      resolveGroup(
        phpMyAdminNginxTemplatePolicy.gatewaySocketGroup,
        'phpmyadmin_gateway_group_unavailable',
      ),
    ]);
    await assertPackageGroupMembership();
    await Promise.all([
      assertDirectory('/var/lib/yunpanel/phpmyadmin', {
        uid: runtimeIdentity.uid,
        gid: runtimeIdentity.gid,
        mode: PRIVATE_DIRECTORY_MODE,
      }),
      assertDirectory(phpMyAdminFpmTemplatePolicy.temporaryDirectory, {
        uid: runtimeIdentity.uid,
        gid: runtimeIdentity.gid,
        mode: PRIVATE_DIRECTORY_MODE,
      }),
      assertDirectory(phpMyAdminFpmTemplatePolicy.sessionDirectory, {
        uid: runtimeIdentity.uid,
        gid: runtimeIdentity.gid,
        mode: PRIVATE_DIRECTORY_MODE,
      }),
      assertParentDirectory('/etc/php/8.3/fpm/pool.d'),
      assertParentDirectory('/etc/nginx/sites-enabled'),
      assertParentDirectory('/etc/phpmyadmin/conf.d'),
      assertParentDirectory(phpMyAdminNginxTemplatePolicy.documentRoot),
      assertSignonBridgeDirectory(runtimeIdentity),
    ]);
    await ensureGatewayDirectory(gatewayGroup);

    const [stagedFpm, stagedNginx, stagedSignonConfig, stagedSignonBridge] = await Promise.all([
      configManager.inspectStagedFpmPool(expected.fpm),
      configManager.inspectStagedNginxConfig(expected.nginx),
      configManager.inspectStagedSignonConfig(expected.signonConfig),
      configManager.inspectStagedSignonBridge(expected.signonBridge),
    ]);
    if (!stagedFpm?.satisfied || !stagedNginx?.satisfied
      || !stagedSignonConfig?.satisfied || !stagedSignonBridge?.satisfied) {
      throw activationError(
        'phpmyadmin_activation_prerequisite_missing',
        'phpMyAdmin staged configuration is missing',
      );
    }
    const [fpmContent, nginxContent, signonConfigContent, signonBridgeContent] = await Promise.all([
      readStaged(
        configManager.stagedFpmPath(expected.fpm.sha256),
        expected.fpm.artifact.sha256,
        expected.fpm.artifact.bytes,
      ),
      readStaged(
        configManager.stagedNginxPath(expected.nginx.sha256),
        expected.nginx.artifact.sha256,
        expected.nginx.artifact.bytes,
      ),
      readStaged(
        configManager.stagedSignonConfigPath(expected.signonConfig.sha256),
        expected.signonConfig.artifact.sha256,
        expected.signonConfig.artifact.bytes,
      ),
      readStaged(
        configManager.stagedSignonBridgePath(expected.signonBridge.sha256),
        expected.signonBridge.artifact.sha256,
        expected.signonBridge.artifact.bytes,
      ),
    ]);

    await validatePhpFile(
      configManager.stagedSignonConfigPath(expected.signonConfig.sha256),
      'phpmyadmin_signon_config_invalid',
      'phpMyAdmin staged signon configuration validation failed',
    );
    await validatePhpFile(
      configManager.stagedSignonBridgePath(expected.signonBridge.sha256),
      'phpmyadmin_signon_bridge_invalid',
      'phpMyAdmin staged signon bridge validation failed',
    );

    await backupManager.backupConfiguration(tx);
    let mutationStarted = false;
    try {
      mutationStarted = true;
      await atomicReplace(
        phpMyAdminSignonTemplatePolicy.bridgePath,
        signonBridgeContent,
        { gid: runtimeIdentity.gid, mode: phpMyAdminSignonTemplatePolicy.bridgeMode },
      );
      await atomicReplace(phpMyAdminFpmTemplatePolicy.poolPath, fpmContent);
      await atomicReplace(phpMyAdminNginxTemplatePolicy.configPath, nginxContent);
      await atomicReplace(
        phpMyAdminSignonTemplatePolicy.configPath,
        signonConfigContent,
        { gid: wwwIdentity.gid, mode: phpMyAdminSignonTemplatePolicy.configMode },
      );
      await validatePhpFile(
        phpMyAdminSignonTemplatePolicy.configPath,
        'phpmyadmin_signon_config_invalid',
        'phpMyAdmin signon configuration validation failed',
      );
      await validatePhpFile(
        phpMyAdminSignonTemplatePolicy.bridgePath,
        'phpmyadmin_signon_bridge_invalid',
        'phpMyAdmin signon bridge validation failed',
      );
      await validateFpmConfig();
      await validateNginxConfig();
      await reloadFpm();
      await assertFpmSocket(wwwIdentity, true);
      await reloadNginx();
      await assertGatewaySocket(gatewayGroup, true);
      await assertHttpHealthy();
      return Object.freeze({
        version: 1,
        previewSha256: previewSha256(expected),
        fpmSha256: expected.fpm.sha256,
        nginxSha256: expected.nginx.sha256,
        signonConfigSha256: expected.signonConfig.sha256,
        signonBridgeSha256: expected.signonBridge.sha256,
        fpmSocketHealthy: true,
        gatewaySocketHealthy: true,
        httpHealthy: true,
        applied: true,
        sideEffects: true,
      });
    } catch (error) {
      if (!mutationStarted) throw error;
      await rollback(tx, wwwIdentity, gatewayGroup);
      if (error instanceof PhpMyAdminConfigActivationError) throw error;
      throw activationError(
        'phpmyadmin_config_activation_failed',
        'phpMyAdmin activation failed and the previous configuration was restored',
      );
    }
  }

  function activateConfiguration(preview, options = {}) {
    const pending = activationChain.catch(() => {}).then(() => activateNow(preview, options));
    activationChain = pending;
    return pending;
  }

  return Object.freeze({ activateConfiguration });
}

export const phpMyAdminConfigActivatorInternals = Object.freeze({
  getentPath: GETENT,
  idPath: ID,
  phpPath: PHP,
  phpFpmPath: PHP_FPM,
  nginxPath: NGINX,
  curlPath: CURL,
  systemctlPath: SYSTEMCTL,
  maxOutput: MAX_OUTPUT,
  configMode: CONFIG_MODE,
  privateDirectoryMode: PRIVATE_DIRECTORY_MODE,
  signonBridgeDirectoryMode: SIGNON_BRIDGE_DIRECTORY_MODE,
  gatewayDirectoryMode: GATEWAY_DIRECTORY_MODE,
  gatewayDirectory: GATEWAY_DIRECTORY,
  socketMode: SOCKET_MODE,
  validatePreview,
  previewSha256,
  parseGroupIdentity,
  boundedOutput,
});
