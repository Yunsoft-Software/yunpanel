import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  roundcubeFpmTemplatePolicy,
  roundcubeNginxTemplatePolicy,
  roundcubeTemplatePolicy,
} from '@yunpanel/config-templates';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STAGE_DIRECTORY_MODE = 0o700;
const STAGED_CONFIG_MODE = 0o600;
const STAGED_PUBLIC_MODE = 0o640;

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

function validateArtifactPreview(preview, { path: expectedPath, sensitive, mode }, code) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || typeof preview.sha256 !== 'string' || !SHA256_PATTERN.test(preview.sha256)
    || !preview.artifact || preview.artifact.path !== expectedPath
    || preview.artifact.sha256 !== preview.sha256
    || preview.artifact.sensitive !== sensitive
    || preview.artifact.mode !== mode
    || !Number.isSafeInteger(preview.artifact.bytes) || preview.artifact.bytes < 1) {
    throw new RoundcubeConfigManagerError(code, 'Roundcube configuration preview is invalid');
  }
  return preview;
}

function validatePreview(preview) {
  return validateArtifactPreview(preview, {
    path: roundcubeTemplatePolicy.configPath,
    sensitive: true,
    mode: roundcubeTemplatePolicy.configMode,
  }, 'roundcube_preview_invalid');
}

function validateFpmPreview(preview) {
  return validateArtifactPreview(preview, {
    path: roundcubeFpmTemplatePolicy.poolPath,
    sensitive: false,
    mode: roundcubeFpmTemplatePolicy.poolMode,
  }, 'roundcube_fpm_preview_invalid');
}

function validateNginxPreview(preview) {
  return validateArtifactPreview(preview, {
    path: roundcubeNginxTemplatePolicy.configPath,
    sensitive: false,
    mode: roundcubeNginxTemplatePolicy.configMode,
  }, 'roundcube_nginx_preview_invalid');
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

  function stagedFpmPath(previewSha256) {
    return path.join(stageDirectory(previewSha256), 'yunpanel-roundcube-fpm.conf');
  }

  function stagedNginxPath(previewSha256) {
    return path.join(stageDirectory(previewSha256), 'yunpanel-roundcube-nginx.conf');
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

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode, flag: 'wx' });
      await renameFn(temporaryPath, targetPath);
      await chmodFn(targetPath, mode);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function stageArtifact({ preview, content, validate, targetPath, mode, mismatchCode, failureCode, resultKey }) {
    const expected = validate(preview);
    if (typeof content !== 'string'
      || Buffer.byteLength(content) !== expected.artifact.bytes
      || sha256(content) !== expected.artifact.sha256) {
      throw new RoundcubeConfigManagerError(mismatchCode, 'Roundcube staged material does not match the approved preview');
    }
    await ensureSafeDirectory(resolvedRoot, STAGE_DIRECTORY_MODE);
    const directory = stageDirectory(expected.sha256);
    await ensureSafeDirectory(directory, STAGE_DIRECTORY_MODE);
    try { await atomicWrite(targetPath(expected.sha256), content, mode); }
    catch {
      throw new RoundcubeConfigManagerError(failureCode, 'Roundcube configuration could not be staged');
    }
    return Object.freeze({
      version: 1,
      previewSha256: expected.sha256,
      [resultKey]: expected.artifact.sha256,
      bytes: expected.artifact.bytes,
      staged: true,
    });
  }

  async function inspectArtifact({ preview, validate, targetPath, mode, resultKey }) {
    const expected = validate(preview);
    try {
      const filePath = targetPath(expected.sha256);
      const metadata = await lstatFn(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== mode) {
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
          [resultKey]: expected.artifact.sha256,
          bytes: expected.artifact.bytes,
          staged: true,
        }),
      });
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ satisfied: false, result: null });
      throw new RoundcubeConfigManagerError('roundcube_staging_inspection_failed', 'Roundcube staged configuration could not be inspected');
    }
  }

  function stageConfiguration(preview, configContent) {
    return stageArtifact({
      preview,
      content: configContent,
      validate: validatePreview,
      targetPath: stagedConfigPath,
      mode: STAGED_CONFIG_MODE,
      mismatchCode: 'roundcube_sensitive_material_mismatch',
      failureCode: 'roundcube_staging_failed',
      resultKey: 'configSha256',
    });
  }

  function stageFpmPool(preview, content) {
    return stageArtifact({
      preview,
      content,
      validate: validateFpmPreview,
      targetPath: stagedFpmPath,
      mode: STAGED_PUBLIC_MODE,
      mismatchCode: 'roundcube_fpm_material_mismatch',
      failureCode: 'roundcube_fpm_staging_failed',
      resultKey: 'fpmSha256',
    });
  }

  function stageNginxConfig(preview, content) {
    return stageArtifact({
      preview,
      content,
      validate: validateNginxPreview,
      targetPath: stagedNginxPath,
      mode: STAGED_PUBLIC_MODE,
      mismatchCode: 'roundcube_nginx_material_mismatch',
      failureCode: 'roundcube_nginx_staging_failed',
      resultKey: 'nginxSha256',
    });
  }

  function inspectStagedConfiguration(preview) {
    return inspectArtifact({
      preview,
      validate: validatePreview,
      targetPath: stagedConfigPath,
      mode: STAGED_CONFIG_MODE,
      resultKey: 'configSha256',
    });
  }

  function inspectStagedFpmPool(preview) {
    return inspectArtifact({
      preview,
      validate: validateFpmPreview,
      targetPath: stagedFpmPath,
      mode: STAGED_PUBLIC_MODE,
      resultKey: 'fpmSha256',
    });
  }

  function inspectStagedNginxConfig(preview) {
    return inspectArtifact({
      preview,
      validate: validateNginxPreview,
      targetPath: stagedNginxPath,
      mode: STAGED_PUBLIC_MODE,
      resultKey: 'nginxSha256',
    });
  }

  return Object.freeze({
    stageConfiguration,
    stageFpmPool,
    stageNginxConfig,
    inspectStagedConfiguration,
    inspectStagedFpmPool,
    inspectStagedNginxConfig,
    stageDirectory,
    stagedConfigPath,
    stagedFpmPath,
    stagedNginxPath,
  });
}

export const roundcubeConfigManagerInternals = Object.freeze({
  validatePreview,
  validateFpmPreview,
  validateNginxPreview,
  sha256,
  stageDirectoryMode: STAGE_DIRECTORY_MODE,
  stagedConfigMode: STAGED_CONFIG_MODE,
  stagedPublicMode: STAGED_PUBLIC_MODE,
});