import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, chown, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  roundcubeFpmTemplatePolicy,
  roundcubeNginxTemplatePolicy,
  roundcubeTemplatePolicy,
} from '@yunpanel/config-templates';
import { createRoundcubeConfigBackupManager } from './roundcube-config-backup.js';
import { createRoundcubeConfigManager } from './roundcube-config-manager.js';
import { parseManagedSystemIdentity } from './mail-vmail-identity.js';

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OUTPUT = 128 * 1024;
const GETENT = '/usr/bin/getent';
const ID = '/usr/bin/id';
const PHP = '/usr/bin/php';
const PHP_FPM = '/usr/sbin/php-fpm8.3';
const SQLITE = '/usr/bin/sqlite3';
const NGINX = '/usr/sbin/nginx';
const CURL = '/usr/bin/curl';
const SYSTEMCTL = '/usr/bin/systemctl';
const ROOT_UID = 0;
const ROOT_GID = 0;
const CONFIG_MODE = 0o640;
const FPM_MODE = 0o640;
const NGINX_MODE = 0o640;
const DATABASE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const SOCKET_MODE = 0o660;

export class RoundcubeConfigActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeConfigActivationError';
    this.code = code;
  }
}

function activationError(code, message) {
  return new RoundcubeConfigActivationError(code, message);
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

function validatePreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.readyToApply !== true
    || typeof preview.sha256 !== 'string' || !SHA256_PATTERN.test(preview.sha256)
    || !preview.configuration || preview.configuration.sha256 !== preview.configSha256
    || preview.configuration.artifact?.path !== roundcubeTemplatePolicy.configPath
    || preview.configuration.databasePath !== roundcubeTemplatePolicy.databasePath
    || preview.configuration.databaseSchemaPath !== roundcubeTemplatePolicy.databaseSchemaPath
    || preview.configuration.temporaryDirectory !== roundcubeTemplatePolicy.temporaryDirectory
    || !preview.fpm || preview.fpm.sha256 !== preview.fpmSha256
    || preview.fpm.artifact?.path !== roundcubeFpmTemplatePolicy.poolPath
    || preview.fpm.socketPath !== roundcubeFpmTemplatePolicy.socketPath
    || preview.fpm.serviceUnit !== roundcubeFpmTemplatePolicy.serviceUnit
    || !preview.nginx || preview.nginx.sha256 !== preview.nginxSha256
    || preview.nginx.artifact?.path !== roundcubeNginxTemplatePolicy.configPath
    || preview.nginx.publicRoot !== roundcubeNginxTemplatePolicy.publicRoot
    || preview.nginx.fpmSocketPath !== roundcubeFpmTemplatePolicy.socketPath
    || preview.nginx.serviceUnit !== roundcubeNginxTemplatePolicy.serviceUnit
    || preview.nginx.healthPath !== roundcubeNginxTemplatePolicy.healthPath
    || preview.nginx.webHostname !== preview.mailHostname
    || preview.nginx.endpoint !== `https://${preview.mailHostname}/`) {
    throw activationError('roundcube_activation_preview_invalid', 'Roundcube activation preview is invalid');
  }
  return preview;
}

function validateTransactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_PATTERN.test(value)) {
    throw activationError('roundcube_activation_transaction_invalid', 'Roundcube activation transaction ID is invalid');
  }
  return value.toLowerCase();
}

export function createRoundcubeConfigActivator({
  configManager = createRoundcubeConfigManager(),
  backupManager = createRoundcubeConfigBackupManager(),
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
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (!configManager || typeof configManager.inspectStagedConfiguration !== 'function'
    || typeof configManager.inspectStagedFpmPool !== 'function'
    || typeof configManager.inspectStagedNginxConfig !== 'function'
    || typeof configManager.stagedConfigPath !== 'function'
    || typeof configManager.stagedFpmPath !== 'function'
    || typeof configManager.stagedNginxPath !== 'function') {
    throw activationError('roundcube_config_manager_invalid', 'Roundcube staging manager is unavailable');
  }
  if (!backupManager || typeof backupManager.backupConfiguration !== 'function'
    || typeof backupManager.restoreConfiguration !== 'function'
    || typeof backupManager.loadManifest !== 'function') {
    throw activationError('roundcube_backup_manager_invalid', 'Roundcube backup manager is unavailable');
  }

  let activationChain = Promise.resolve();

  async function runCommand(file, args, code, message, options = {}) {
    try {
      const result = await run(file, args, { timeout: 30_000, maxBuffer: MAX_OUTPUT, ...options });
      boundedOutput(result);
      return result;
    } catch {
      throw activationError(code, message);
    }
  }

  async function resolveIdentity(name, code) {
    try {
      const result = await run(GETENT, ['passwd', name], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      const identity = parseManagedSystemIdentity(boundedOutput(result), name);
      if (!identity) throw new Error('invalid identity');
      return identity;
    } catch {
      throw activationError(code, 'Roundcube runtime identity could not be resolved safely');
    }
  }

  async function assertPackageGroupMembership() {
    try {
      const result = await run(ID, ['-nG', roundcubeFpmTemplatePolicy.runtimeUser], {
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT,
      });
      const groups = new Set(boundedOutput(result).split(/\s+/).filter(Boolean));
      if (!groups.has('www-data')) throw new Error('missing package config group');
    } catch {
      throw activationError(
        'roundcube_runtime_group_unavailable',
        'Roundcube runtime user is not allowed to traverse the package configuration group',
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
      throw activationError('roundcube_runtime_directory_unsafe', 'Roundcube private runtime directory is unavailable or unsafe');
    }
  }

  async function assertParentDirectory(targetPath) {
    try {
      const metadata = await lstatFn(targetPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe parent');
    } catch {
      throw activationError('roundcube_configuration_parent_unsafe', 'Roundcube configuration directory is unavailable or unsafe');
    }
  }

  async function readStaged(targetPath, expectedSha256, expectedBytes, expectedMode) {
    try {
      const metadata = await lstatFn(targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== expectedMode) {
        throw new Error('unsafe stage');
      }
      const content = await readFileFn(targetPath);
      if (content.length !== expectedBytes || sha256(content) !== expectedSha256) throw new Error('changed stage');
      return content;
    } catch {
      throw activationError('roundcube_stage_changed', 'Roundcube staged configuration changed before activation');
    }
  }

  async function atomicReplace(targetPath, content, { uid, gid, mode }) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { mode, flag: 'wx' });
      await chownFn(temporaryPath, uid, gid);
      await chmodFn(temporaryPath, mode);
      await renameFn(temporaryPath, targetPath);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function inspectDatabase(runtimeIdentity) {
    try {
      const metadata = await lstatFn(roundcubeTemplatePolicy.databasePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.uid !== runtimeIdentity.uid || metadata.gid !== runtimeIdentity.gid
        || (metadata.mode & 0o7777) !== DATABASE_MODE || metadata.size < 1) {
        throw new Error('unsafe database');
      }
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw activationError('roundcube_database_unsafe', 'Roundcube SQLite database is unavailable or unsafe');
    }
  }

  async function assertSchemaSafe() {
    try {
      const metadata = await lstatFn(roundcubeTemplatePolicy.databaseSchemaPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 2 * 1024 * 1024) {
        throw new Error('unsafe schema');
      }
    } catch {
      throw activationError('roundcube_database_schema_unavailable', 'Roundcube SQLite schema is unavailable or unsafe');
    }
  }

  async function assertDatabaseHealthy(runtimeIdentity) {
    const result = await runCommand(
      SQLITE,
      [roundcubeTemplatePolicy.databasePath, 'PRAGMA quick_check;'],
      'roundcube_database_check_failed',
      'Roundcube SQLite integrity check failed',
      { uid: runtimeIdentity.uid, gid: runtimeIdentity.gid },
    );
    if (boundedOutput(result) !== 'ok') {
      throw activationError('roundcube_database_check_failed', 'Roundcube SQLite integrity check failed');
    }
  }

  async function bootstrapDatabase(runtimeIdentity) {
    await assertSchemaSafe();
    await runCommand(
      SQLITE,
      [roundcubeTemplatePolicy.databasePath, `.read ${roundcubeTemplatePolicy.databaseSchemaPath}`],
      'roundcube_database_bootstrap_failed',
      'Roundcube SQLite database could not be initialized',
    );
    try {
      const metadata = await lstatFn(roundcubeTemplatePolicy.databasePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('unsafe database output');
      await chownFn(roundcubeTemplatePolicy.databasePath, runtimeIdentity.uid, runtimeIdentity.gid);
      await chmodFn(roundcubeTemplatePolicy.databasePath, DATABASE_MODE);
    } catch {
      throw activationError('roundcube_database_output_invalid', 'Roundcube SQLite initialization did not produce a safe database');
    }
    await assertDatabaseHealthy(runtimeIdentity);
  }

  async function validatePhpConfig() {
    await runCommand(PHP, ['-l', roundcubeTemplatePolicy.configPath], 'roundcube_php_config_invalid', 'Roundcube PHP configuration validation failed');
  }

  async function validateFpmConfig() {
    await runCommand(PHP_FPM, ['-t'], 'roundcube_fpm_config_invalid', 'Roundcube PHP-FPM configuration validation failed');
  }

  async function validateNginxConfig() {
    await runCommand(NGINX, ['-t'], 'roundcube_nginx_config_invalid', 'Roundcube Nginx configuration validation failed');
  }

  async function reloadFpm() {
    await runCommand(SYSTEMCTL, ['reload', roundcubeFpmTemplatePolicy.serviceUnit], 'roundcube_fpm_reload_failed', 'Roundcube PHP-FPM reload failed');
    await runCommand(SYSTEMCTL, ['is-active', '--quiet', roundcubeFpmTemplatePolicy.serviceUnit], 'roundcube_fpm_health_failed', 'Roundcube PHP-FPM service is not active');
  }

  async function reloadNginx() {
    await runCommand(SYSTEMCTL, ['reload', roundcubeNginxTemplatePolicy.serviceUnit], 'roundcube_nginx_reload_failed', 'Roundcube Nginx reload failed');
    await runCommand(SYSTEMCTL, ['is-active', '--quiet', roundcubeNginxTemplatePolicy.serviceUnit], 'roundcube_nginx_health_failed', 'Roundcube Nginx service is not active');
  }

  async function assertFpmSocket(wwwIdentity, expectedPresent = true) {
    try {
      const metadata = await lstatFn(roundcubeFpmTemplatePolicy.socketPath);
      if (!expectedPresent) throw new Error('unexpected fpm socket');
      if (!metadata.isSocket() || metadata.isSymbolicLink()
        || metadata.uid !== wwwIdentity.uid || metadata.gid !== wwwIdentity.gid
        || (metadata.mode & 0o7777) !== SOCKET_MODE) {
        throw new Error('unsafe fpm socket');
      }
    } catch (error) {
      if (!expectedPresent && error?.code === 'ENOENT') return;
      throw activationError(
        expectedPresent ? 'roundcube_fpm_socket_invalid' : 'roundcube_fpm_socket_not_retired',
        expectedPresent
          ? 'Roundcube PHP-FPM socket is unavailable or unsafe'
          : 'Roundcube PHP-FPM socket remained after rollback',
      );
    }
  }

  async function assertHttpHealthy(preview) {
    await runCommand(
      CURL,
      [
        '--fail', '--silent', '--show-error', '--insecure',
        '--max-time', '10',
        '--resolve', `${preview.nginx.webHostname}:443:127.0.0.1`,
        '--output', '/dev/null',
        preview.nginx.endpoint,
      ],
      'roundcube_http_health_failed',
      'Roundcube HTTPS endpoint did not become healthy',
      { timeout: 15_000 },
    );
  }

  async function rollback(transactionId, runtimeIdentity, wwwIdentity) {
    try {
      const manifest = await backupManager.loadManifest(transactionId);
      await backupManager.restoreConfiguration(transactionId);
      if (manifest.files[0].exists) await validatePhpConfig();
      await validateFpmConfig();
      await validateNginxConfig();
      await reloadFpm();
      await assertFpmSocket(wwwIdentity, manifest.files[1].exists);
      await reloadNginx();
      const databaseExists = await inspectDatabase(runtimeIdentity);
      if (databaseExists !== manifest.databaseExisted) throw new Error('database rollback mismatch');
      if (databaseExists) await assertDatabaseHealthy(runtimeIdentity);
    } catch {
      throw activationError('roundcube_config_rollback_failed', 'Roundcube activation failed and the previous configuration could not be confirmed');
    }
  }

  async function activateNow(preview, { transactionId } = {}) {
    const expected = validatePreview(preview);
    const tx = validateTransactionId(transactionId);
    const [runtimeIdentity, wwwIdentity] = await Promise.all([
      resolveIdentity(roundcubeFpmTemplatePolicy.runtimeUser, 'roundcube_runtime_identity_unavailable'),
      resolveIdentity(roundcubeFpmTemplatePolicy.socketOwner, 'roundcube_web_identity_unavailable'),
    ]);
    await assertPackageGroupMembership();
    await Promise.all([
      assertDirectory('/var/lib/yunpanel/roundcube', {
        uid: runtimeIdentity.uid, gid: runtimeIdentity.gid, mode: PRIVATE_DIRECTORY_MODE,
      }),
      assertDirectory(roundcubeTemplatePolicy.temporaryDirectory, {
        uid: runtimeIdentity.uid, gid: runtimeIdentity.gid, mode: PRIVATE_DIRECTORY_MODE,
      }),
      assertParentDirectory('/etc/roundcube'),
      assertParentDirectory('/etc/php/8.3/fpm/pool.d'),
      assertParentDirectory('/etc/nginx/sites-enabled'),
    ]);

    const [stagedConfig, stagedFpm, stagedNginx] = await Promise.all([
      configManager.inspectStagedConfiguration(expected.configuration),
      configManager.inspectStagedFpmPool(expected.fpm),
      configManager.inspectStagedNginxConfig(expected.nginx),
    ]);
    if (!stagedConfig?.satisfied || !stagedFpm?.satisfied || !stagedNginx?.satisfied) {
      throw activationError('roundcube_activation_prerequisite_missing', 'Roundcube staged configuration is missing');
    }
    const [configContent, fpmContent, nginxContent] = await Promise.all([
      readStaged(
        configManager.stagedConfigPath(expected.configuration.sha256),
        expected.configuration.artifact.sha256,
        expected.configuration.artifact.bytes,
        0o600,
      ),
      readStaged(
        configManager.stagedFpmPath(expected.fpm.sha256),
        expected.fpm.artifact.sha256,
        expected.fpm.artifact.bytes,
        FPM_MODE,
      ),
      readStaged(
        configManager.stagedNginxPath(expected.nginx.sha256),
        expected.nginx.artifact.sha256,
        expected.nginx.artifact.bytes,
        NGINX_MODE,
      ),
    ]);

    const backup = await backupManager.backupConfiguration(tx);
    let mutationStarted = false;
    try {
      mutationStarted = true;
      await atomicReplace(roundcubeTemplatePolicy.configPath, configContent, {
        uid: ROOT_UID, gid: runtimeIdentity.gid, mode: CONFIG_MODE,
      });
      await atomicReplace(roundcubeFpmTemplatePolicy.poolPath, fpmContent, {
        uid: ROOT_UID, gid: ROOT_GID, mode: FPM_MODE,
      });
      await atomicReplace(roundcubeNginxTemplatePolicy.configPath, nginxContent, {
        uid: ROOT_UID, gid: ROOT_GID, mode: NGINX_MODE,
      });
      const databaseExists = await inspectDatabase(runtimeIdentity);
      if (!databaseExists) await bootstrapDatabase(runtimeIdentity);
      else await assertDatabaseHealthy(runtimeIdentity);
      await validatePhpConfig();
      await validateFpmConfig();
      await validateNginxConfig();
      await reloadFpm();
      await assertFpmSocket(wwwIdentity, true);
      await reloadNginx();
      await assertHttpHealthy(expected);
      return Object.freeze({
        version: 1,
        previewSha256: expected.sha256,
        configSha256: expected.configSha256,
        fpmSha256: expected.fpmSha256,
        nginxSha256: expected.nginxSha256,
        databaseCreated: backup.databaseExisted === false,
        httpHealthy: true,
        applied: true,
        sideEffects: true,
      });
    } catch (error) {
      if (!mutationStarted) throw error;
      await rollback(tx, runtimeIdentity, wwwIdentity);
      if (error instanceof RoundcubeConfigActivationError) throw error;
      throw activationError('roundcube_config_activation_failed', 'Roundcube activation failed and the previous configuration was restored');
    }
  }

  function activateConfiguration(preview, options = {}) {
    const pending = activationChain.catch(() => {}).then(() => activateNow(preview, options));
    activationChain = pending;
    return pending;
  }

  return Object.freeze({ activateConfiguration });
}

export const roundcubeConfigActivatorInternals = Object.freeze({
  getentPath: GETENT,
  idPath: ID,
  phpPath: PHP,
  phpFpmPath: PHP_FPM,
  sqlitePath: SQLITE,
  nginxPath: NGINX,
  curlPath: CURL,
  systemctlPath: SYSTEMCTL,
  maxOutput: MAX_OUTPUT,
  configMode: CONFIG_MODE,
  fpmMode: FPM_MODE,
  nginxMode: NGINX_MODE,
  databaseMode: DATABASE_MODE,
  privateDirectoryMode: PRIVATE_DIRECTORY_MODE,
  socketMode: SOCKET_MODE,
  validatePreview,
  boundedOutput,
});