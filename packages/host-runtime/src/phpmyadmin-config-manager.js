import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  phpMyAdminFpmTemplatePolicy,
  phpMyAdminNginxTemplatePolicy,
  phpMyAdminSignonTemplatePolicy,
} from '@yunpanel/config-templates';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STAGE_DIRECTORY_MODE = 0o700;
const STAGED_ARTIFACT_MODE = 0o640;
const FPM_PREVIEW_KEYS = new Set([
  'version', 'sha256', 'artifact', 'socketPath', 'serviceUnit', 'runtimeUser', 'runtimeGroup',
  'temporaryDirectory', 'sessionDirectory',
]);
const NGINX_PREVIEW_KEYS = new Set([
  'version', 'sha256', 'artifact', 'documentRoot', 'fpmSocketPath', 'gatewaySocketPath',
  'gatewaySocketMode', 'gatewaySocketOwner', 'gatewaySocketGroup', 'signonBridgePath',
  'internalSignonPath', 'internalLogoutPath', 'healthPath', 'serviceUnit',
]);
const SIGNON_CONFIG_PREVIEW_KEYS = new Set([
  'version', 'sha256', 'artifact', 'signonSession', 'gatewayBasePath',
]);
const SIGNON_BRIDGE_PREVIEW_KEYS = new Set([
  'version', 'sha256', 'artifact', 'handoffSocketPath', 'signonSession',
  'internalSignonPath', 'internalLogoutPath', 'gatewayBasePath',
]);
const ARTIFACT_KEYS = new Set(['path', 'sha256', 'bytes', 'sensitive', 'mode']);

export class PhpMyAdminConfigManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpMyAdminConfigManagerError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key));
}

function validateArtifactPreview(preview, { path: expectedPath, mode, previewKeys }, code) {
  if (!exactKeys(preview, previewKeys) || preview.version !== 1
    || typeof preview.sha256 !== 'string' || !SHA256_PATTERN.test(preview.sha256)
    || !exactKeys(preview.artifact, ARTIFACT_KEYS)
    || preview.artifact.path !== expectedPath
    || preview.artifact.sha256 !== preview.sha256
    || preview.artifact.sensitive !== false
    || preview.artifact.mode !== mode
    || !Number.isSafeInteger(preview.artifact.bytes) || preview.artifact.bytes < 1) {
    throw new PhpMyAdminConfigManagerError(code, 'phpMyAdmin configuration preview is invalid');
  }
  return preview;
}

function validateFpmPreview(preview) {
  const value = validateArtifactPreview(preview, {
    path: phpMyAdminFpmTemplatePolicy.poolPath,
    mode: phpMyAdminFpmTemplatePolicy.poolMode,
    previewKeys: FPM_PREVIEW_KEYS,
  }, 'phpmyadmin_fpm_preview_invalid');
  if (value.socketPath !== phpMyAdminFpmTemplatePolicy.socketPath
    || value.serviceUnit !== phpMyAdminFpmTemplatePolicy.serviceUnit
    || value.runtimeUser !== phpMyAdminFpmTemplatePolicy.runtimeUser
    || value.runtimeGroup !== phpMyAdminFpmTemplatePolicy.runtimeGroup
    || value.temporaryDirectory !== phpMyAdminFpmTemplatePolicy.temporaryDirectory
    || value.sessionDirectory !== phpMyAdminFpmTemplatePolicy.sessionDirectory) {
    throw new PhpMyAdminConfigManagerError('phpmyadmin_fpm_preview_invalid', 'phpMyAdmin FPM preview is invalid');
  }
  return value;
}

function validateNginxPreview(preview) {
  const value = validateArtifactPreview(preview, {
    path: phpMyAdminNginxTemplatePolicy.configPath,
    mode: phpMyAdminNginxTemplatePolicy.configMode,
    previewKeys: NGINX_PREVIEW_KEYS,
  }, 'phpmyadmin_nginx_preview_invalid');
  if (value.documentRoot !== phpMyAdminNginxTemplatePolicy.documentRoot
    || value.fpmSocketPath !== phpMyAdminNginxTemplatePolicy.fpmSocketPath
    || value.gatewaySocketPath !== phpMyAdminNginxTemplatePolicy.gatewaySocketPath
    || value.gatewaySocketMode !== phpMyAdminNginxTemplatePolicy.gatewaySocketMode
    || value.gatewaySocketOwner !== phpMyAdminNginxTemplatePolicy.gatewaySocketOwner
    || value.gatewaySocketGroup !== phpMyAdminNginxTemplatePolicy.gatewaySocketGroup
    || value.signonBridgePath !== phpMyAdminNginxTemplatePolicy.signonBridgePath
    || value.internalSignonPath !== phpMyAdminNginxTemplatePolicy.internalSignonPath
    || value.internalLogoutPath !== phpMyAdminNginxTemplatePolicy.internalLogoutPath
    || value.serviceUnit !== phpMyAdminNginxTemplatePolicy.serviceUnit
    || value.healthPath !== phpMyAdminNginxTemplatePolicy.healthPath) {
    throw new PhpMyAdminConfigManagerError('phpmyadmin_nginx_preview_invalid', 'phpMyAdmin Nginx preview is invalid');
  }
  return value;
}

function validateSignonConfigPreview(preview) {
  const value = validateArtifactPreview(preview, {
    path: phpMyAdminSignonTemplatePolicy.configPath,
    mode: phpMyAdminSignonTemplatePolicy.configMode,
    previewKeys: SIGNON_CONFIG_PREVIEW_KEYS,
  }, 'phpmyadmin_signon_config_preview_invalid');
  if (value.signonSession !== phpMyAdminSignonTemplatePolicy.signonSession
    || value.gatewayBasePath !== phpMyAdminSignonTemplatePolicy.gatewayBasePath) {
    throw new PhpMyAdminConfigManagerError(
      'phpmyadmin_signon_config_preview_invalid',
      'phpMyAdmin signon config preview is invalid',
    );
  }
  return value;
}

function validateSignonBridgePreview(preview) {
  const value = validateArtifactPreview(preview, {
    path: phpMyAdminSignonTemplatePolicy.bridgePath,
    mode: phpMyAdminSignonTemplatePolicy.bridgeMode,
    previewKeys: SIGNON_BRIDGE_PREVIEW_KEYS,
  }, 'phpmyadmin_signon_bridge_preview_invalid');
  if (value.handoffSocketPath !== phpMyAdminSignonTemplatePolicy.handoffSocketPath
    || value.signonSession !== phpMyAdminSignonTemplatePolicy.signonSession
    || value.internalSignonPath !== phpMyAdminSignonTemplatePolicy.internalSignonPath
    || value.internalLogoutPath !== phpMyAdminSignonTemplatePolicy.internalLogoutPath
    || value.gatewayBasePath !== phpMyAdminSignonTemplatePolicy.gatewayBasePath) {
    throw new PhpMyAdminConfigManagerError(
      'phpmyadmin_signon_bridge_preview_invalid',
      'phpMyAdmin signon bridge preview is invalid',
    );
  }
  return value;
}

export function createPhpMyAdminConfigManager({
  stagingRoot = '/var/lib/yunpanel/staging/phpmyadmin',
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot)
    || stagingRoot === path.parse(stagingRoot).root) {
    throw new PhpMyAdminConfigManagerError(
      'phpmyadmin_staging_root_invalid',
      'phpMyAdmin staging root is invalid',
    );
  }
  const resolvedRoot = path.resolve(stagingRoot);

  function stageDirectory(previewSha256) {
    if (typeof previewSha256 !== 'string' || !SHA256_PATTERN.test(previewSha256)) {
      throw new PhpMyAdminConfigManagerError(
        'phpmyadmin_preview_digest_invalid',
        'phpMyAdmin preview digest is invalid',
      );
    }
    return path.join(resolvedRoot, previewSha256);
  }

  function stagedFpmPath(previewSha256) {
    return path.join(stageDirectory(previewSha256), 'yunpanel-phpmyadmin-fpm.conf');
  }

  function stagedNginxPath(previewSha256) {
    return path.join(stageDirectory(previewSha256), 'yunpanel-phpmyadmin-nginx.conf');
  }

  function stagedSignonConfigPath(previewSha256) {
    return path.join(stageDirectory(previewSha256), 'zz-yunpanel.php');
  }

  function stagedSignonBridgePath(previewSha256) {
    return path.join(stageDirectory(previewSha256), 'yunpanel-phpmyadmin-signon.php');
  }

  async function ensureSafeDirectory(directory) {
    try {
      const metadata = await lstatFn(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new PhpMyAdminConfigManagerError(
          'phpmyadmin_staging_directory_unsafe',
          'phpMyAdmin staging directory is unsafe',
        );
      }
      await mkdirFn(directory, { recursive: true, mode: STAGE_DIRECTORY_MODE });
      const created = await lstatFn(directory);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new PhpMyAdminConfigManagerError(
          'phpmyadmin_staging_directory_unsafe',
          'phpMyAdmin staging directory is unsafe',
        );
      }
    }
    await chmodFn(directory, STAGE_DIRECTORY_MODE);
  }

  async function atomicWrite(targetPath, content) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, {
        encoding: 'utf8', mode: STAGED_ARTIFACT_MODE, flag: 'wx',
      });
      await renameFn(temporaryPath, targetPath);
      await chmodFn(targetPath, STAGED_ARTIFACT_MODE);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function stageArtifact({ preview, content, validate, targetPath, resultKey, mismatchCode }) {
    const expected = validate(preview);
    if (typeof content !== 'string' || Buffer.byteLength(content) !== expected.artifact.bytes
      || sha256(content) !== expected.artifact.sha256) {
      throw new PhpMyAdminConfigManagerError(
        mismatchCode,
        'phpMyAdmin staged material does not match the approved preview',
      );
    }
    await ensureSafeDirectory(resolvedRoot);
    await ensureSafeDirectory(stageDirectory(expected.sha256));
    try { await atomicWrite(targetPath(expected.sha256), content); }
    catch {
      throw new PhpMyAdminConfigManagerError(
        'phpmyadmin_staging_failed',
        'phpMyAdmin configuration could not be staged',
      );
    }
    return Object.freeze({
      version: 1,
      previewSha256: expected.sha256,
      [resultKey]: expected.artifact.sha256,
      bytes: expected.artifact.bytes,
      staged: true,
    });
  }

  async function inspectArtifact({ preview, validate, targetPath, resultKey }) {
    const expected = validate(preview);
    try {
      const filePath = targetPath(expected.sha256);
      const metadata = await lstatFn(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || (metadata.mode & 0o7777) !== STAGED_ARTIFACT_MODE) {
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
      throw new PhpMyAdminConfigManagerError(
        'phpmyadmin_staging_inspection_failed',
        'phpMyAdmin staged configuration could not be inspected',
      );
    }
  }

  return Object.freeze({
    stageFpmPool: (preview, content) => stageArtifact({
      preview,
      content,
      validate: validateFpmPreview,
      targetPath: stagedFpmPath,
      resultKey: 'fpmSha256',
      mismatchCode: 'phpmyadmin_fpm_material_mismatch',
    }),
    stageNginxConfig: (preview, content) => stageArtifact({
      preview,
      content,
      validate: validateNginxPreview,
      targetPath: stagedNginxPath,
      resultKey: 'nginxSha256',
      mismatchCode: 'phpmyadmin_nginx_material_mismatch',
    }),
    inspectStagedFpmPool: (preview) => inspectArtifact({
      preview,
      validate: validateFpmPreview,
      targetPath: stagedFpmPath,
      resultKey: 'fpmSha256',
    }),
    inspectStagedNginxConfig: (preview) => inspectArtifact({
      preview,
      validate: validateNginxPreview,
      targetPath: stagedNginxPath,
      resultKey: 'nginxSha256',
    }),
    stageSignonConfig: (preview, content) => stageArtifact({
      preview,
      content,
      validate: validateSignonConfigPreview,
      targetPath: stagedSignonConfigPath,
      resultKey: 'signonConfigSha256',
      mismatchCode: 'phpmyadmin_signon_config_material_mismatch',
    }),
    stageSignonBridge: (preview, content) => stageArtifact({
      preview,
      content,
      validate: validateSignonBridgePreview,
      targetPath: stagedSignonBridgePath,
      resultKey: 'signonBridgeSha256',
      mismatchCode: 'phpmyadmin_signon_bridge_material_mismatch',
    }),
    inspectStagedSignonConfig: (preview) => inspectArtifact({
      preview,
      validate: validateSignonConfigPreview,
      targetPath: stagedSignonConfigPath,
      resultKey: 'signonConfigSha256',
    }),
    inspectStagedSignonBridge: (preview) => inspectArtifact({
      preview,
      validate: validateSignonBridgePreview,
      targetPath: stagedSignonBridgePath,
      resultKey: 'signonBridgeSha256',
    }),
    stageDirectory,
    stagedFpmPath,
    stagedNginxPath,
    stagedSignonConfigPath,
    stagedSignonBridgePath,
  });
}

export const phpMyAdminConfigManagerInternals = Object.freeze({
  validateFpmPreview,
  validateNginxPreview,
  validateSignonConfigPreview,
  validateSignonBridgePreview,
  sha256,
  stageDirectoryMode: STAGE_DIRECTORY_MODE,
  stagedArtifactMode: STAGED_ARTIFACT_MODE,
});
