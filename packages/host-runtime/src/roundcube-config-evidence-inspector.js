import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  roundcubeFpmTemplatePolicy,
  roundcubeTemplatePolicy,
} from '@yunpanel/config-templates';
import { parseManagedSystemIdentity } from './mail-vmail-identity.js';

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_OUTPUT = 128 * 1024;
const GETENT = '/usr/bin/getent';
const ID = '/usr/bin/id';
const PHP = '/usr/bin/php';
const PHP_FPM = '/usr/sbin/php-fpm8.3';
const SQLITE = '/usr/bin/sqlite3';
const SYSTEMCTL = '/usr/bin/systemctl';
const ROOT_UID = 0;
const ROOT_GID = 0;
const CONFIG_MODE = 0o640;
const FPM_MODE = 0o640;
const DATABASE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const SOCKET_MODE = 0o660;

export class RoundcubeConfigEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeConfigEvidenceError';
    this.code = code;
  }
}

function boundedOutput(result) {
  const stdout = String(result?.stdout ?? result ?? '');
  const stderr = String(result?.stderr ?? '');
  if (Buffer.byteLength(stdout) > MAX_OUTPUT || Buffer.byteLength(stderr) > MAX_OUTPUT) {
    throw new RoundcubeConfigEvidenceError(
      'roundcube_evidence_output_too_large',
      'Roundcube evidence command output exceeded its bound',
    );
  }
  return stdout.trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validPreview(preview) {
  return Boolean(preview && typeof preview === 'object' && !Array.isArray(preview)
    && preview.readyToApply === true
    && typeof preview.sha256 === 'string' && SHA256_PATTERN.test(preview.sha256)
    && typeof preview.configSha256 === 'string' && SHA256_PATTERN.test(preview.configSha256)
    && typeof preview.fpmSha256 === 'string' && SHA256_PATTERN.test(preview.fpmSha256)
    && preview.configuration?.artifact?.path === roundcubeTemplatePolicy.configPath
    && preview.configuration.artifact.sha256 === preview.configSha256
    && preview.fpm?.artifact?.path === roundcubeFpmTemplatePolicy.poolPath
    && preview.fpm.artifact.sha256 === preview.fpmSha256
    && preview.fpm.socketPath === roundcubeFpmTemplatePolicy.socketPath
    && preview.fpm.serviceUnit === roundcubeFpmTemplatePolicy.serviceUnit);
}

export function createRoundcubeConfigEvidenceInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  lstatFn = lstat,
  readFileFn = readFile,
} = {}) {
  async function identity(name) {
    try {
      const result = await run(GETENT, ['passwd', name], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      return parseManagedSystemIdentity(boundedOutput(result), name);
    } catch {
      return null;
    }
  }

  async function runtimeGroupReady() {
    try {
      const result = await run(ID, ['-nG', roundcubeFpmTemplatePolicy.runtimeUser], {
        timeout: 10_000, maxBuffer: MAX_OUTPUT,
      });
      return new Set(boundedOutput(result).split(/\s+/).filter(Boolean)).has('www-data');
    } catch {
      return false;
    }
  }

  async function exactFile(targetPath, expectedSha256, { uid, gid, mode }) {
    try {
      const metadata = await lstatFn(targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.uid !== uid || metadata.gid !== gid
        || (metadata.mode & 0o7777) !== mode) return false;
      const content = await readFileFn(targetPath);
      return sha256(content) === expectedSha256;
    } catch {
      return false;
    }
  }

  async function privateDirectory(targetPath, runtimeIdentity) {
    try {
      const metadata = await lstatFn(targetPath);
      return metadata.isDirectory() && !metadata.isSymbolicLink()
        && metadata.uid === runtimeIdentity.uid && metadata.gid === runtimeIdentity.gid
        && (metadata.mode & 0o7777) === PRIVATE_DIRECTORY_MODE;
    } catch {
      return false;
    }
  }

  async function databaseReady(runtimeIdentity) {
    try {
      const metadata = await lstatFn(roundcubeTemplatePolicy.databasePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1
        || metadata.uid !== runtimeIdentity.uid || metadata.gid !== runtimeIdentity.gid
        || (metadata.mode & 0o7777) !== DATABASE_MODE) return false;
      const result = await run(SQLITE, [roundcubeTemplatePolicy.databasePath, 'PRAGMA quick_check;'], {
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT,
        uid: runtimeIdentity.uid,
        gid: runtimeIdentity.gid,
      });
      return boundedOutput(result) === 'ok';
    } catch {
      return false;
    }
  }

  async function commandReady(file, args) {
    try {
      const result = await run(file, args, { timeout: 30_000, maxBuffer: MAX_OUTPUT });
      boundedOutput(result);
      return true;
    } catch {
      return false;
    }
  }

  async function socketReady(wwwIdentity) {
    try {
      const metadata = await lstatFn(roundcubeFpmTemplatePolicy.socketPath);
      return metadata.isSocket() && !metadata.isSymbolicLink()
        && metadata.uid === wwwIdentity.uid && metadata.gid === wwwIdentity.gid
        && (metadata.mode & 0o7777) === SOCKET_MODE;
    } catch {
      return false;
    }
  }

  async function inspect(preview) {
    if (!validPreview(preview)) {
      throw new RoundcubeConfigEvidenceError('roundcube_evidence_preview_invalid', 'Roundcube evidence preview is invalid');
    }
    const [runtimeIdentity, wwwIdentity, groupReady] = await Promise.all([
      identity(roundcubeFpmTemplatePolicy.runtimeUser),
      identity(roundcubeFpmTemplatePolicy.socketOwner),
      runtimeGroupReady(),
    ]);
    if (!runtimeIdentity || !wwwIdentity || !groupReady) return Object.freeze({ satisfied: false, result: null });
    if (!(await privateDirectory('/var/lib/yunpanel/roundcube', runtimeIdentity))
      || !(await privateDirectory(roundcubeTemplatePolicy.temporaryDirectory, runtimeIdentity))) {
      return Object.freeze({ satisfied: false, result: null });
    }
    if (!(await exactFile(roundcubeTemplatePolicy.configPath, preview.configSha256, {
      uid: ROOT_UID, gid: runtimeIdentity.gid, mode: CONFIG_MODE,
    }))) return Object.freeze({ satisfied: false, result: null });
    if (!(await exactFile(roundcubeFpmTemplatePolicy.poolPath, preview.fpmSha256, {
      uid: ROOT_UID, gid: ROOT_GID, mode: FPM_MODE,
    }))) return Object.freeze({ satisfied: false, result: null });
    if (!(await databaseReady(runtimeIdentity))) return Object.freeze({ satisfied: false, result: null });
    if (!(await commandReady(PHP, ['-l', roundcubeTemplatePolicy.configPath]))) {
      return Object.freeze({ satisfied: false, result: null });
    }
    if (!(await commandReady(PHP_FPM, ['-t']))) return Object.freeze({ satisfied: false, result: null });
    if (!(await commandReady(SYSTEMCTL, ['is-active', '--quiet', roundcubeFpmTemplatePolicy.serviceUnit]))) {
      return Object.freeze({ satisfied: false, result: null });
    }
    if (!(await socketReady(wwwIdentity))) return Object.freeze({ satisfied: false, result: null });

    return Object.freeze({
      satisfied: true,
      result: Object.freeze({
        version: 1,
        previewSha256: preview.sha256,
        configSha256: preview.configSha256,
        fpmSha256: preview.fpmSha256,
        databaseHealthy: true,
        applied: true,
        sideEffects: true,
      }),
    });
  }

  return Object.freeze({ inspect });
}

export const roundcubeConfigEvidenceInternals = Object.freeze({
  getentPath: GETENT,
  idPath: ID,
  phpPath: PHP,
  phpFpmPath: PHP_FPM,
  sqlitePath: SQLITE,
  systemctlPath: SYSTEMCTL,
  maxOutput: MAX_OUTPUT,
  configMode: CONFIG_MODE,
  fpmMode: FPM_MODE,
  databaseMode: DATABASE_MODE,
  privateDirectoryMode: PRIVATE_DIRECTORY_MODE,
  socketMode: SOCKET_MODE,
  validPreview,
  boundedOutput,
});
