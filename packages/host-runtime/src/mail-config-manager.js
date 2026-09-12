import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  mailTemplatePolicy,
  previewManagedMailApplyPlan,
} from '@yunpanel/config-templates';

const DEFAULT_STAGING_ROOT = '/var/lib/yunpanel/staging/mail';
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const PRIVATE_MODE = 0o600;
const PUBLIC_MODE = 0o640;
const DIRECTORY_MODE = 0o700;

const ALLOWED_ARTIFACT_PATHS = Object.freeze([
  mailTemplatePolicy.postfixVirtualDomainMapPath,
  mailTemplatePolicy.postfixVirtualMailboxMapPath,
  mailTemplatePolicy.postfixVirtualAliasMapPath,
  mailTemplatePolicy.dovecotPasswdFilePath,
  mailTemplatePolicy.dovecotAuthConfigPath,
  mailTemplatePolicy.dovecotMailConfigPath,
  mailTemplatePolicy.rspamdProxyConfigPath,
]);
const ALLOWED_ARTIFACT_SET = new Set(ALLOWED_ARTIFACT_PATHS);

export class MailConfigManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailConfigManagerError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function assertAbsoluteRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new MailConfigManagerError('mail_staging_root_invalid', 'Managed mail staging root must be an absolute normalized path');
  }
}

function artifactName(index, targetPath) {
  return `${String(index).padStart(2, '0')}-${path.basename(targetPath)}`;
}

function normalizeSensitiveArtifacts(values) {
  if (!Array.isArray(values)) {
    throw new MailConfigManagerError('mail_sensitive_artifacts_invalid', 'Sensitive mail artifacts must be an array');
  }
  const result = new Map();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || typeof value.path !== 'string' || typeof value.content !== 'string') {
      throw new MailConfigManagerError('mail_sensitive_artifact_invalid', 'Sensitive mail artifact metadata is invalid');
    }
    if (result.has(value.path)) {
      throw new MailConfigManagerError('mail_sensitive_artifact_duplicate', 'Sensitive mail artifact paths must be unique');
    }
    result.set(value.path, value.content);
  }
  return result;
}

function buildStageManifest(preview, sensitiveArtifacts) {
  const plan = previewManagedMailApplyPlan(preview);
  const privateContent = normalizeSensitiveArtifacts(sensitiveArtifacts);
  const previewByPath = new Map(preview.artifacts.map((artifact) => [artifact.path, artifact]));
  const requiredSensitive = new Set(plan.artifacts.filter((artifact) => artifact.sensitive).map((artifact) => artifact.path));

  for (const providedPath of privateContent.keys()) {
    if (!requiredSensitive.has(providedPath)) {
      throw new MailConfigManagerError('mail_sensitive_artifact_unexpected', 'Unexpected sensitive mail artifact was provided');
    }
  }
  for (const requiredPath of requiredSensitive) {
    if (!privateContent.has(requiredPath)) {
      throw new MailConfigManagerError('mail_sensitive_artifact_missing', 'Required sensitive mail artifact is missing');
    }
  }

  const artifacts = plan.artifacts.map((artifact, index) => {
    if (!ALLOWED_ARTIFACT_SET.has(artifact.path)) {
      throw new MailConfigManagerError('mail_artifact_path_forbidden', 'Managed mail artifact path is not allowlisted');
    }
    if (artifact.path !== ALLOWED_ARTIFACT_PATHS[index]) {
      throw new MailConfigManagerError('mail_artifact_order_invalid', 'Managed mail artifact order is not canonical');
    }
    const source = previewByPath.get(artifact.path);
    const content = artifact.sensitive ? privateContent.get(artifact.path) : source?.content;
    if (typeof content !== 'string') {
      throw new MailConfigManagerError('mail_artifact_content_missing', 'Managed mail artifact content is unavailable');
    }
    if (sha256(content) !== artifact.sha256) {
      throw new MailConfigManagerError('mail_artifact_digest_mismatch', 'Managed mail artifact content does not match its preview digest');
    }
    return Object.freeze({
      targetPath: artifact.path,
      stagedName: artifactName(index, artifact.path),
      sha256: artifact.sha256,
      bytes: Buffer.byteLength(content),
      mode: artifact.sensitive ? PRIVATE_MODE : PUBLIC_MODE,
      sensitive: artifact.sensitive,
      content,
    });
  });

  if (artifacts.length !== ALLOWED_ARTIFACT_PATHS.length
    || new Set(artifacts.map((artifact) => artifact.targetPath)).size !== ALLOWED_ARTIFACT_PATHS.length) {
    throw new MailConfigManagerError('mail_artifact_set_invalid', 'Managed mail preview does not contain the complete artifact set');
  }

  return {
    plan,
    artifacts,
    manifest: Object.freeze({
      version: MANIFEST_VERSION,
      planSha256: plan.sha256,
      previewSha256: plan.previewSha256,
      artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({
        targetPath: artifact.targetPath,
        stagedName: artifact.stagedName,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        mode: artifact.mode,
        sensitive: artifact.sensitive,
      }))),
    }),
  };
}

function normalizeManifest(value, expectedPlanSha256 = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== MANIFEST_VERSION
    || typeof value.planSha256 !== 'string' || !CHECKSUM_PATTERN.test(value.planSha256)
    || typeof value.previewSha256 !== 'string' || !CHECKSUM_PATTERN.test(value.previewSha256)
    || !Array.isArray(value.artifacts) || value.artifacts.length !== ALLOWED_ARTIFACT_PATHS.length) {
    throw new MailConfigManagerError('mail_stage_manifest_invalid', 'Managed mail staging manifest is invalid');
  }
  if (expectedPlanSha256 !== null && value.planSha256 !== expectedPlanSha256) {
    throw new MailConfigManagerError('mail_stage_manifest_stale', 'Managed mail staging manifest belongs to a different apply plan');
  }
  const seen = new Set();
  const artifacts = value.artifacts.map((artifact, index) => {
    const expectedPath = ALLOWED_ARTIFACT_PATHS[index];
    const expectedName = artifactName(index, expectedPath);
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || artifact.targetPath !== expectedPath || artifact.stagedName !== expectedName
      || typeof artifact.sha256 !== 'string' || !CHECKSUM_PATTERN.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
      || ![PRIVATE_MODE, PUBLIC_MODE].includes(artifact.mode)
      || typeof artifact.sensitive !== 'boolean' || seen.has(artifact.targetPath)) {
      throw new MailConfigManagerError('mail_stage_manifest_invalid', 'Managed mail staging manifest artifact is invalid');
    }
    seen.add(artifact.targetPath);
    return Object.freeze({ ...artifact });
  });
  return Object.freeze({
    version: MANIFEST_VERSION,
    planSha256: value.planSha256,
    previewSha256: value.previewSha256,
    artifacts: Object.freeze(artifacts),
  });
}

export function createMailConfigManager({
  stagingRoot = DEFAULT_STAGING_ROOT,
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  assertAbsoluteRoot(stagingRoot);
  let stageChain = Promise.resolve();

  async function atomicWrite(targetPath, content, { mode, encoding = null } = {}) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const options = { mode };
    if (encoding) options.encoding = encoding;
    await writeFileFn(temporaryPath, content, options);
    await renameFn(temporaryPath, targetPath);
    await chmodFn(targetPath, mode);
  }

  function stageDirectory(planSha256) {
    if (typeof planSha256 !== 'string' || !CHECKSUM_PATTERN.test(planSha256)) {
      throw new MailConfigManagerError('mail_plan_digest_invalid', 'Managed mail apply plan digest is invalid');
    }
    return path.join(stagingRoot, planSha256);
  }

  async function stageNow(preview, { sensitiveArtifacts = [] } = {}) {
    const prepared = buildStageManifest(preview, sensitiveArtifacts);
    const directory = stageDirectory(prepared.plan.sha256);
    await mkdirFn(stagingRoot, { recursive: true, mode: DIRECTORY_MODE });
    await chmodFn(stagingRoot, DIRECTORY_MODE);
    await mkdirFn(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmodFn(directory, DIRECTORY_MODE);

    for (const artifact of prepared.artifacts) {
      await atomicWrite(path.join(directory, artifact.stagedName), artifact.content, {
        mode: artifact.mode,
        encoding: 'utf8',
      });
    }
    await atomicWrite(path.join(directory, MANIFEST_FILE), `${JSON.stringify(prepared.manifest, null, 2)}\n`, {
      mode: PRIVATE_MODE,
      encoding: 'utf8',
    });

    return structuredClone(prepared.manifest);
  }

  function stageConfiguration(preview, options = {}) {
    const run = stageChain.catch(() => {}).then(() => stageNow(preview, options));
    stageChain = run;
    return run;
  }

  async function inspectStagedConfiguration(preview) {
    const plan = previewManagedMailApplyPlan(preview);
    const directory = stageDirectory(plan.sha256);
    let manifest;
    try {
      const manifestPath = path.join(directory, MANIFEST_FILE);
      const metadata = await lstatFn(manifestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new MailConfigManagerError('mail_stage_manifest_invalid', 'Managed mail staging manifest is not a regular file');
      }
      manifest = normalizeManifest(JSON.parse(await readFileFn(manifestPath, 'utf8')), plan.sha256);
    } catch (error) {
      if (error?.code === 'ENOENT') return { satisfied: false, result: null };
      if (error instanceof MailConfigManagerError) throw error;
      throw new MailConfigManagerError('mail_stage_manifest_invalid', 'Managed mail staging manifest could not be inspected');
    }
    if (manifest.previewSha256 !== plan.previewSha256) return { satisfied: false, result: null };

    for (const artifact of manifest.artifacts) {
      const stagedPath = path.join(directory, artifact.stagedName);
      let metadata;
      let content;
      try {
        metadata = await lstatFn(stagedPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) return { satisfied: false, result: null };
        content = await readFileFn(stagedPath);
      } catch (error) {
        if (error?.code === 'ENOENT') return { satisfied: false, result: null };
        throw new MailConfigManagerError('mail_stage_artifact_inspection_failed', 'Managed mail staged artifact could not be inspected');
      }
      if (content.length !== artifact.bytes || sha256(content) !== artifact.sha256
        || (metadata.mode & 0o777) !== artifact.mode) {
        return { satisfied: false, result: null };
      }
    }
    return { satisfied: true, result: structuredClone(manifest) };
  }

  return Object.freeze({
    stageConfiguration,
    inspectStagedConfiguration,
    stageDirectory,
  });
}

export const mailConfigManagerInternals = Object.freeze({
  allowedArtifactPaths: ALLOWED_ARTIFACT_PATHS,
  defaultStagingRoot: DEFAULT_STAGING_ROOT,
  directoryMode: DIRECTORY_MODE,
  privateMode: PRIVATE_MODE,
  publicMode: PUBLIC_MODE,
  normalizeManifest,
  buildStageManifest,
});
