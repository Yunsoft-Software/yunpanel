import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { roundcubeTemplatePolicy } from '@yunpanel/config-templates';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STAGE_DIRECTORY_MODE = 0o700;
const STAGED_CONFIG_MODE = 0o600;

export class RoundcubeConfigManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeConfigManagerError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function validatePreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || typeof preview.sha256 !== 'string' || !SHA256_PATTERN.test(preview.sha256)
    || !preview.artifact || preview.artifact.path !== roundcubeTemplatePolicy.configPath
    || preview.artifact.sha256 !== preview.sha256
    || preview.artifact.sensitive !== true
    || preview.artifact.mode !== roundcubeTemplatePolicy.configMode
    || !Number.isSafeInteger(preview.artifact.bytes) || preview.artifact.bytes < 1) {
    throw new RoundcubeConfigManagerError('roundcube_preview_invalid', 'Roundcube configuration preview is invalid');
  }
  return preview;
}

export function createRoundcubeConfigManager({
  stagingRoot = '/var/lib/yunpanel/staging/roundcube',
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot) || stagingRoot === path.parse(stagingRoot).root) {
    throw new RoundcubeConfigManagerError('roundcube_staging_root_invalid', 'Roundcube staging root is invalid');
  }
  const resolvedRoot = path.resolve(stagingRoot);

  function stageDirectory(previewSha256) {
    if (typeof previewSha256 !== 'string' || !SHA256_PATTERN.test(previewSha256)) {
      throw new RoundcubeConfigManagerError('roundcube_preview_digest_invalid', 'Roundcube preview digest is invalid');
    }
    return path.join(resolvedRoot, previewSha256);
  }

  function stagedConfigPath(previewSha256) {
    return path.join(stageDirectory(previewSha256), 'config.inc.php');
  }

  async function ensureSafeDirectory(directory, mode) {
    try {
      const metadata = await lstatFn(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new RoundcubeConfigManagerError('roundcube_staging_directory_unsafe', 'Roundcube staging directory is unsafe');
      }
      await mkdirFn(directory, { recursive: true, mode });
      const created = await lstatFn(directory);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new RoundcubeConfigManagerError('roundcube_staging_directory_unsafe', 'Roundcube staging directory is unsafe');
      }
    }
    await chmodFn(directory, mode);
  }

  async function atomicWrite(targetPath, content) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode: STAGED_CONFIG_MODE, flag: 'wx' });
      await renameFn(temporaryPath, targetPath);
      await chmodFn(targetPath, STAGED_CONFIG_MODE);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function stageConfiguration(preview, configContent) {
    const expected = validatePreview(preview);
    if (typeof configContent !== 'string'
      || Buffer.byteLength(configContent) !== expected.artifact.bytes
      || sha256(configContent) !== expected.artifact.sha256) {
      throw new RoundcubeConfigManagerError(
        'roundcube_sensitive_material_mismatch',
        'Roundcube private configuration does not match the approved preview',
      );
    }
    await ensureSafeDirectory(resolvedRoot, STAGE_DIRECTORY_MODE);
    const directory = stageDirectory(expected.sha256);
    await ensureSafeDirectory(directory, STAGE_DIRECTORY_MODE);
    try {
      await atomicWrite(stagedConfigPath(expected.sha256), configContent);
    } catch (error) {
      if (error instanceof RoundcubeConfigManagerError) throw error;
      throw new RoundcubeConfigManagerError('roundcube_staging_failed', 'Roundcube private configuration could not be staged');
    }
    return Object.freeze({
      version: 1,
      previewSha256: expected.sha256,
      configSha256: expected.artifact.sha256,
      bytes: expected.artifact.bytes,
      staged: true,
    });
  }

  async function inspectStagedConfiguration(preview) {
    const expected = validatePreview(preview);
    try {
      const filePath = stagedConfigPath(expected.sha256);
      const metadata = await lstatFn(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || (metadata.mode & 0o7777) !== STAGED_CONFIG_MODE) {
        return Object.freeze({ satisfied: false, result: null });
      }
      const content = await readFileFn(filePath);
      if (content.length !== expected.artifact.bytes || sha256(content) !== expected.artifact.sha256) {
        return Object.freeze({ satisfied: false, result: null });
      }
      return Object.freeze({
        satisfied: true,
        result: Object.freeze({
          version: 1,
          previewSha256: expected.sha256,
          configSha256: expected.artifact.sha256,
          bytes: expected.artifact.bytes,
          staged: true,
        }),
      });
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ satisfied: false, result: null });
      throw new RoundcubeConfigManagerError('roundcube_staging_inspection_failed', 'Roundcube staged configuration could not be inspected');
    }
  }

  return Object.freeze({
    stageConfiguration,
    inspectStagedConfiguration,
    stageDirectory,
    stagedConfigPath,
  });
}

export const roundcubeConfigManagerInternals = Object.freeze({
  validatePreview,
  sha256,
  stageDirectoryMode: STAGE_DIRECTORY_MODE,
  stagedConfigMode: STAGED_CONFIG_MODE,
});