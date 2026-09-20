import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod, chown, lstat, mkdir, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  elFinderNginxTemplatePolicy,
  previewElFinderNginxConfig,
  renderElFinderNginxConfig,
} from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);
const STATE_ROOT = '/var/lib/yunpanel/staging/elfinder-nginx';
const STATE_VERSION = 1;
const ROOT_UID = 0;
const ROOT_GID = 0;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GATEWAY_DIRECTORY = '/run/yunpanel';
const GATEWAY_DIRECTORY_MODE = 0o2770;
const NGINX = '/usr/sbin/nginx';
const SYSTEMCTL = '/usr/bin/systemctl';
const GETENT = '/usr/bin/getent';
const CURL = '/usr/bin/curl';
const MAX_OUTPUT = 128 * 1024;
const REQUIRED_ASSETS = Object.freeze([
  '/usr/share/yunpanel/elfinder/index.html',
  '/usr/share/yunpanel/elfinder/yunpanel-client.js',
  '/usr/share/yunpanel/elfinder/connector.php',
  '/usr/share/yunpanel/elfinder/vendor/elfinder/js/elfinder.min.js',
  '/usr/share/yunpanel/elfinder/vendor/elfinder/css/elfinder.min.css',
  '/usr/share/yunpanel/elfinder/vendor/elfinder/php/autoload.php',
  '/usr/share/javascript/jquery/jquery.min.js',
  '/usr/share/javascript/jquery-ui/jquery-ui.min.js',
  '/usr/share/javascript/jquery-ui/themes/base/jquery-ui.min.css',
]);

export class ElFinderNginxGatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElFinderNginxGatewayError';
    this.code = code;
  }
}

function gatewayError(code, message) {
  return new ElFinderNginxGatewayError(code, message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function modeOf(value) {
  return Number(value?.mode ?? 0) & 0o7777;
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function boundedOutput(result) {
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  if (Buffer.byteLength(stdout) > MAX_OUTPUT || Buffer.byteLength(stderr) > MAX_OUTPUT) {
    throw new Error('command output exceeded bound');
  }
  return stdout.trim();
}

function parseGroup(value, expected) {
  const fields = String(value ?? '').trim().split(':');
  if (fields.length !== 4 || fields[0] !== expected || !/^\d+$/.test(fields[2])) return null;
  const gid = Number.parseInt(fields[2], 10);
  return Number.isSafeInteger(gid) && gid > 0 ? Object.freeze({ gid }) : null;
}

export function createElFinderNginxGatewayManager({
  stateRoot = STATE_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
  }),
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
  sleepFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || stateRoot === '/'
    || typeof run !== 'function' || typeof chmodFn !== 'function' || typeof chownFn !== 'function'
    || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function' || typeof renameFn !== 'function'
    || typeof rmFn !== 'function' || typeof writeFileFn !== 'function'
    || typeof sleepFn !== 'function') {
    throw gatewayError(
      'elfinder_gateway_dependencies_invalid',
      'elFinder Nginx gateway dependencies are invalid',
    );
  }

  const desiredContent = renderElFinderNginxConfig();
  const desiredPreview = previewElFinderNginxConfig();
  const desiredSha = desiredPreview.sha256;
  const transactionDirectory = path.join(stateRoot, desiredSha);
  const manifestPath = path.join(transactionDirectory, 'manifest.json');
  const previousPath = path.join(transactionDirectory, 'previous.conf');

  async function atomicWrite(target, value, mode) {
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, value, { mode, flag: 'wx' });
      await chmodFn(temporary, mode);
      await chownFn(temporary, ROOT_UID, ROOT_GID);
      await renameFn(temporary, target);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function resolveGatewayGroup() {
    try {
      const result = await run(GETENT, ['group', elFinderNginxTemplatePolicy.gatewaySocketGroup], {
        timeout: 10_000,
      });
      return parseGroup(boundedOutput(result), elFinderNginxTemplatePolicy.gatewaySocketGroup);
    } catch {
      return null;
    }
  }

  async function inspectAssets() {
    for (const target of REQUIRED_ASSETS) {
      let info;
      try { info = await lstatFn(target); }
      catch (error) {
        if (missing(error)) return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_asset_missing', asset: target });
        throw gatewayError(
          'elfinder_gateway_asset_unavailable',
          'elFinder gateway asset state could not be inspected',
        );
      }
      if (!info?.isFile?.() || info.isSymbolicLink?.() || info.uid !== ROOT_UID
        || (modeOf(info) & 0o022) !== 0) {
        throw gatewayError(
          'elfinder_gateway_asset_unsafe',
          'elFinder gateway asset ownership or permissions are unsafe',
        );
      }
    }
    return Object.freeze({ satisfied: true });
  }

  async function inspectConfig() {
    let info;
    let value;
    try {
      [info, value] = await Promise.all([
        lstatFn(elFinderNginxTemplatePolicy.configPath),
        readFileFn(elFinderNginxTemplatePolicy.configPath),
      ]);
    } catch (error) {
      if (missing(error)) return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_config_missing' });
      throw gatewayError(
        'elfinder_gateway_config_unavailable',
        'elFinder Nginx configuration could not be inspected',
      );
    }
    if (!info?.isFile?.() || info.isSymbolicLink?.() || info.uid !== ROOT_UID || info.gid !== ROOT_GID
      || modeOf(info) !== elFinderNginxTemplatePolicy.configMode) {
      throw gatewayError(
        'elfinder_gateway_config_unsafe',
        'elFinder Nginx configuration ownership or permissions are unsafe',
      );
    }
    if (sha256(value) !== desiredSha) {
      return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_config_drift' });
    }
    return Object.freeze({ satisfied: true });
  }

  async function configTest() {
    try {
      const result = await run(NGINX, ['-t'], { timeout: 30_000 });
      boundedOutput(result);
      return true;
    } catch {
      return false;
    }
  }

  async function serviceActive() {
    try {
      await run(SYSTEMCTL, ['is-active', '--quiet', elFinderNginxTemplatePolicy.serviceUnit], {
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function inspectSocket(group) {
    let info;
    try { info = await lstatFn(elFinderNginxTemplatePolicy.gatewaySocketPath); }
    catch (error) {
      if (missing(error)) return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_socket_missing' });
      throw gatewayError(
        'elfinder_gateway_socket_unavailable',
        'elFinder gateway socket could not be inspected',
      );
    }
    if (!info?.isSocket?.() || info.isSymbolicLink?.()
      || info.uid !== ROOT_UID || info.gid !== group.gid
      || modeOf(info) !== elFinderNginxTemplatePolicy.gatewaySocketMode) {
      return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_socket_drift' });
    }
    return Object.freeze({ satisfied: true });
  }

  async function health() {
    try {
      const result = await run(CURL, [
        '--fail',
        '--silent',
        '--show-error',
        '--max-time', '5',
        '--output', '/dev/null',
        '--unix-socket', elFinderNginxTemplatePolicy.gatewaySocketPath,
        'http://localhost/',
      ], { timeout: 10_000 });
      boundedOutput(result);
      return true;
    } catch {
      return false;
    }
  }

  async function inspect() {
    const assets = await inspectAssets();
    if (!assets.satisfied) return assets;
    const group = await resolveGatewayGroup();
    if (!group) return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_group_missing' });
    const config = await inspectConfig();
    if (!config.satisfied) return config;
    if (!await configTest()) return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_config_invalid' });
    if (!await serviceActive()) return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_nginx_inactive' });
    const socket = await inspectSocket(group);
    if (!socket.satisfied) return socket;
    if (!await health()) return Object.freeze({ satisfied: false, reason: 'elfinder_gateway_health_failed' });
    return Object.freeze({
      satisfied: true,
      adapter: 'elfinder-nginx-gateway',
      configPath: elFinderNginxTemplatePolicy.configPath,
      configSha256: desiredSha,
      gatewaySocketPath: elFinderNginxTemplatePolicy.gatewaySocketPath,
      gatewaySocketMode: elFinderNginxTemplatePolicy.gatewaySocketMode,
      gatewaySocketGroup: elFinderNginxTemplatePolicy.gatewaySocketGroup,
    });
  }

  async function inspectLiveConfigForSnapshot() {
    try {
      const info = await lstatFn(elFinderNginxTemplatePolicy.configPath);
      if (!info?.isFile?.() || info.isSymbolicLink?.() || info.uid !== ROOT_UID || info.gid !== ROOT_GID
        || modeOf(info) !== elFinderNginxTemplatePolicy.configMode) {
        throw gatewayError(
          'elfinder_gateway_config_unsafe',
          'Existing elFinder Nginx configuration is unsafe',
        );
      }
      const value = await readFileFn(elFinderNginxTemplatePolicy.configPath);
      return Object.freeze({
        exists: true,
        sha256: sha256(value),
        bytes: value.length,
        mode: modeOf(info),
        value,
      });
    } catch (error) {
      if (missing(error)) return Object.freeze({ exists: false, sha256: null, bytes: 0, mode: null, value: null });
      throw error;
    }
  }

  function validateManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => ![
        'version', 'desiredSha256', 'previousExists', 'previousSha256', 'previousBytes', 'previousMode',
      ].includes(key))
      || value.version !== STATE_VERSION || value.desiredSha256 !== desiredSha
      || typeof value.previousExists !== 'boolean'
      || (value.previousExists
        ? (typeof value.previousSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousSha256)
          || !Number.isSafeInteger(value.previousBytes) || value.previousBytes < 1
          || value.previousMode !== elFinderNginxTemplatePolicy.configMode)
        : (value.previousSha256 !== null || value.previousBytes !== 0 || value.previousMode !== null))) {
      throw gatewayError(
        'elfinder_gateway_snapshot_invalid',
        'elFinder Nginx rollback snapshot is invalid',
      );
    }
    return Object.freeze({ ...value });
  }

  async function loadSnapshot() {
    let raw;
    try { raw = await readFileFn(manifestPath, 'utf8'); }
    catch (error) {
      if (missing(error)) return null;
      throw gatewayError(
        'elfinder_gateway_snapshot_unavailable',
        'elFinder Nginx rollback snapshot could not be read',
      );
    }
    let manifest;
    try { manifest = validateManifest(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof ElFinderNginxGatewayError) throw error;
      throw gatewayError('elfinder_gateway_snapshot_invalid', 'elFinder Nginx rollback snapshot is invalid');
    }
    if (manifest.previousExists) {
      let info;
      let previous;
      try {
        [info, previous] = await Promise.all([lstatFn(previousPath), readFileFn(previousPath)]);
      } catch {
        throw gatewayError(
          'elfinder_gateway_snapshot_invalid',
          'elFinder Nginx rollback file is unavailable',
        );
      }
      if (!info?.isFile?.() || info.isSymbolicLink?.() || info.uid !== ROOT_UID || info.gid !== ROOT_GID
        || modeOf(info) !== PRIVATE_FILE_MODE
        || previous.length !== manifest.previousBytes || sha256(previous) !== manifest.previousSha256) {
        throw gatewayError(
          'elfinder_gateway_snapshot_invalid',
          'elFinder Nginx rollback file has changed',
        );
      }
      return Object.freeze({ manifest, previous });
    }
    return Object.freeze({ manifest, previous: null });
  }

  async function ensurePrivateDirectory(target) {
    try {
      const info = await lstatFn(target);
      if (!info?.isDirectory?.() || info.isSymbolicLink?.()
        || info.uid !== ROOT_UID || info.gid !== ROOT_GID) {
        throw gatewayError(
          'elfinder_gateway_state_directory_unsafe',
          'elFinder gateway state directory is unsafe',
        );
      }
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdirFn(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const created = await lstatFn(target);
      if (!created?.isDirectory?.() || created.isSymbolicLink?.()) {
        throw gatewayError(
          'elfinder_gateway_state_directory_unsafe',
          'elFinder gateway state directory is unsafe',
        );
      }
    }
    await chownFn(target, ROOT_UID, ROOT_GID);
    await chmodFn(target, PRIVATE_DIRECTORY_MODE);
  }

  async function prepareSnapshot() {
    const existing = await loadSnapshot();
    if (existing) return existing;

    const previous = await inspectLiveConfigForSnapshot();
    await ensurePrivateDirectory(stateRoot);
    await ensurePrivateDirectory(transactionDirectory);

    if (previous.exists) {
      await atomicWrite(previousPath, previous.value, PRIVATE_FILE_MODE);
    }
    const manifest = validateManifest({
      version: STATE_VERSION,
      desiredSha256: desiredSha,
      previousExists: previous.exists,
      previousSha256: previous.sha256,
      previousBytes: previous.bytes,
      previousMode: previous.mode,
    });
    await atomicWrite(manifestPath, `${JSON.stringify(manifest)}\n`, PRIVATE_FILE_MODE);
    return Object.freeze({ manifest, previous: previous.exists ? previous.value : null });
  }

  async function ensureGatewayDirectory(group) {
    try {
      const info = await lstatFn(GATEWAY_DIRECTORY);
      if (!info?.isDirectory?.() || info.isSymbolicLink?.()) {
        throw gatewayError(
          'elfinder_gateway_directory_unsafe',
          'YunPanel gateway runtime directory is unsafe',
        );
      }
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdirFn(GATEWAY_DIRECTORY, { recursive: true, mode: GATEWAY_DIRECTORY_MODE });
    }
    await chownFn(GATEWAY_DIRECTORY, ROOT_UID, group.gid);
    await chmodFn(GATEWAY_DIRECTORY, GATEWAY_DIRECTORY_MODE);
  }

  async function installDesiredConfig() {
    const parent = path.dirname(elFinderNginxTemplatePolicy.configPath);
    const parentInfo = await lstatFn(parent);
    if (!parentInfo?.isDirectory?.() || parentInfo.isSymbolicLink?.()
      || parentInfo.uid !== ROOT_UID || (modeOf(parentInfo) & 0o002) !== 0) {
      throw gatewayError(
        'elfinder_gateway_config_directory_unsafe',
        'Nginx configuration directory is unsafe',
      );
    }
    await atomicWrite(
      elFinderNginxTemplatePolicy.configPath,
      desiredContent,
      elFinderNginxTemplatePolicy.configMode,
    );
  }

  async function activateNginx() {
    if (!await configTest()) {
      throw gatewayError('elfinder_gateway_config_invalid', 'Generated elFinder Nginx configuration is invalid');
    }
    try {
      if (!await serviceActive()) {
        await run(SYSTEMCTL, ['enable', '--now', elFinderNginxTemplatePolicy.serviceUnit], {
          timeout: 60_000,
        });
      } else {
        await run(SYSTEMCTL, ['reload', elFinderNginxTemplatePolicy.serviceUnit], {
          timeout: 30_000,
        });
      }
    } catch {
      throw gatewayError(
        'elfinder_gateway_nginx_activation_failed',
        'Nginx could not activate the elFinder gateway',
      );
    }
  }

  async function fixGatewaySocket(group) {
    let info;
    // systemctl reload returns before Nginx's new workers finish binding the Unix listener.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        info = await lstatFn(elFinderNginxTemplatePolicy.gatewaySocketPath);
        break;
      } catch (error) {
        if (!missing(error)) {
          throw gatewayError('elfinder_gateway_socket_unavailable', 'elFinder gateway socket could not be inspected');
        }
        if (attempt < 49) await sleepFn(100);
      }
    }
    if (!info) {
      throw gatewayError('elfinder_gateway_socket_missing', 'Nginx did not create the elFinder gateway socket');
    }
    if (!info?.isSocket?.() || info.isSymbolicLink?.()) {
      throw gatewayError(
        'elfinder_gateway_socket_unsafe',
        'elFinder gateway socket path is unsafe',
      );
    }
    await chownFn(elFinderNginxTemplatePolicy.gatewaySocketPath, ROOT_UID, group.gid);
    await chmodFn(elFinderNginxTemplatePolicy.gatewaySocketPath, elFinderNginxTemplatePolicy.gatewaySocketMode);
    const verified = await inspectSocket(group);
    if (!verified.satisfied) {
      throw gatewayError(
        'elfinder_gateway_socket_drift',
        'elFinder gateway socket permissions could not be verified',
      );
    }
  }

  async function restoreSnapshot(snapshot) {
    if (snapshot.manifest.previousExists) {
      await atomicWrite(
        elFinderNginxTemplatePolicy.configPath,
        snapshot.previous,
        snapshot.manifest.previousMode,
      );
    } else {
      await rmFn(elFinderNginxTemplatePolicy.configPath, { force: true });
    }
    if (!await configTest()) {
      throw gatewayError(
        'elfinder_gateway_rollback_config_invalid',
        'Previous Nginx configuration could not be validated',
      );
    }
    if (await serviceActive()) {
      try {
        await run(SYSTEMCTL, ['reload', elFinderNginxTemplatePolicy.serviceUnit], { timeout: 30_000 });
      } catch {
        throw gatewayError(
          'elfinder_gateway_rollback_reload_failed',
          'Previous Nginx configuration could not be reloaded',
        );
      }
    }
  }

  async function apply() {
    const assets = await inspectAssets();
    if (!assets.satisfied) {
      throw gatewayError(
        assets.reason,
        'elFinder shared application assets are not installed',
      );
    }
    const group = await resolveGatewayGroup();
    if (!group) {
      throw gatewayError(
        'elfinder_gateway_group_missing',
        'YunPanel web gateway group is unavailable',
      );
    }
    await ensureGatewayDirectory(group);
    const snapshot = await prepareSnapshot();

    try {
      const config = await inspectConfig();
      if (!config.satisfied) await installDesiredConfig();
      await activateNginx();
      await fixGatewaySocket(group);
      if (!await health()) {
        throw gatewayError(
          'elfinder_gateway_health_failed',
          'elFinder private gateway health check failed',
        );
      }
      const verified = await inspect();
      if (!verified.satisfied) {
        throw gatewayError(
          'elfinder_gateway_apply_unverified',
          'elFinder private gateway activation could not be verified',
        );
      }
      return Object.freeze({ ...verified, applied: true });
    } catch (error) {
      try {
        await restoreSnapshot(snapshot);
      } catch {
        throw gatewayError(
          'elfinder_gateway_rollback_failed',
          'elFinder gateway activation failed and previous Nginx state could not be restored',
        );
      }
      if (error instanceof ElFinderNginxGatewayError) throw error;
      throw gatewayError(
        'elfinder_gateway_apply_failed',
        'elFinder private gateway activation failed',
      );
    }
  }

  return Object.freeze({ inspect, apply });
}

export const elFinderNginxGatewayInternals = Object.freeze({
  sha256,
  modeOf,
  parseGroup,
  requiredAssets: REQUIRED_ASSETS,
  stateRoot: STATE_ROOT,
  gatewayDirectory: GATEWAY_DIRECTORY,
});
