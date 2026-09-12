import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  mailTemplatePolicy,
  previewManagedMailApplyPlan,
} from '@yunpanel/config-templates';

const DEFAULT_BACKUP_ROOT = '/var/lib/yunpanel/recovery/mail-config';
const DIRECTORY_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;
const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const POSTFIX_MAIN_CF_PATH = '/etc/postfix/main.cf';

const PLAN_ARTIFACT_PATHS = Object.freeze([
  mailTemplatePolicy.postfixVirtualDomainMapPath,
  mailTemplatePolicy.postfixVirtualMailboxMapPath,
  mailTemplatePolicy.postfixVirtualAliasMapPath,
  mailTemplatePolicy.dovecotPasswdFilePath,
  mailTemplatePolicy.dovecotAuthConfigPath,
  mailTemplatePolicy.dovecotMailConfigPath,
  mailTemplatePolicy.rspamdProxyConfigPath,
]);
const POSTFIX_COMPILED_PATHS = Object.freeze([
  `${mailTemplatePolicy.postfixVirtualDomainMapPath}.db`,
  `${mailTemplatePolicy.postfixVirtualMailboxMapPath}.db`,
  `${mailTemplatePolicy.postfixVirtualAliasMapPath}.db`,
]);
const BACKUP_TARGET_PATHS = Object.freeze([
  mailTemplatePolicy.postfixVirtualDomainMapPath,
  POSTFIX_COMPILED_PATHS[0],
  mailTemplatePolicy.postfixVirtualMailboxMapPath,
  POSTFIX_COMPILED_PATHS[1],
  mailTemplatePolicy.postfixVirtualAliasMapPath,
  POSTFIX_COMPILED_PATHS[2],
  POSTFIX_MAIN_CF_PATH,
  mailTemplatePolicy.dovecotPasswdFilePath,
  mailTemplatePolicy.dovecotAuthConfigPath,
  mailTemplatePolicy.dovecotMailConfigPath,
  mailTemplatePolicy.rspamdProxyConfigPath,
]);

export class MailConfigBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailConfigBackupError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeTransactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_PATTERN.test(value)) {
    throw new MailConfigBackupError('mail_backup_transaction_invalid', 'Managed mail backup transaction id is invalid');
  }
  return value;
}

function assertRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new MailConfigBackupError('mail_backup_root_invalid', 'Managed mail backup root must be an absolute normalized path');
  }
}

function backupName(index, targetPath) {
  return `${String(index).padStart(2, '0')}-${path.basename(targetPath)}.bak`;
}

function assertPlanArtifactSet(plan) {
  if (!plan || !Array.isArray(plan.artifacts) || plan.artifacts.length !== PLAN_ARTIFACT_PATHS.length) {
    throw new MailConfigBackupError('mail_backup_artifact_set_invalid', 'Managed mail apply plan artifact set is incomplete');
  }
  for (let index = 0; index < PLAN_ARTIFACT_PATHS.length; index += 1) {
    if (plan.artifacts[index]?.path !== PLAN_ARTIFACT_PATHS[index]) {
      throw new MailConfigBackupError('mail_backup_artifact_set_invalid', 'Managed mail apply plan artifact order is invalid');
    }
  }
}

function publicManifest(manifest) {
  return structuredClone(manifest);
}

function normalizeManifest(value, { transactionId, planSha256 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== MANIFEST_VERSION
    || value.transactionId !== transactionId || value.planSha256 !== planSha256
    || typeof value.previewSha256 !== 'string' || !CHECKSUM_PATTERN.test(value.previewSha256)
    || !Array.isArray(value.artifacts) || value.artifacts.length !== BACKUP_TARGET_PATHS.length) {
    throw new MailConfigBackupError('mail_backup_manifest_invalid', 'Managed mail backup manifest is invalid');
  }
  const artifacts = value.artifacts.map((artifact, index) => {
    const targetPath = BACKUP_TARGET_PATHS[index];
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || artifact.targetPath !== targetPath || typeof artifact.present !== 'boolean') {
      throw new MailConfigBackupError('mail_backup_manifest_invalid', 'Managed mail backup artifact metadata is invalid');
    }
    if (!artifact.present) {
      if (artifact.backupName !== null || artifact.sha256 !== null || artifact.bytes !== 0
        || artifact.mode !== null || artifact.uid !== null || artifact.gid !== null) {
        throw new MailConfigBackupError('mail_backup_manifest_invalid', 'Absent managed mail backup artifact metadata is invalid');
      }
      return Object.freeze({ ...artifact });
    }
    if (artifact.backupName !== backupName(index, targetPath)
      || typeof artifact.sha256 !== 'string' || !CHECKSUM_PATTERN.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
      || !Number.isSafeInteger(artifact.mode) || artifact.mode < 0 || artifact.mode > 0o7777
      || !Number.isSafeInteger(artifact.uid) || artifact.uid < 0
      || !Number.isSafeInteger(artifact.gid) || artifact.gid < 0) {
      throw new MailConfigBackupError('mail_backup_manifest_invalid', 'Present managed mail backup artifact metadata is invalid');
    }
    return Object.freeze({ ...artifact });
  });
  return Object.freeze({
    version: MANIFEST_VERSION,
    transactionId,
    planSha256,
    previewSha256: value.previewSha256,
    artifacts: Object.freeze(artifacts),
  });
}

export function createMailConfigBackupManager({
  backupRoot = DEFAULT_BACKUP_ROOT,
  liveLstatFn = lstat,
  liveReadFileFn = readFile,
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  assertRoot(backupRoot);
  let backupChain = Promise.resolve();

  function transactionDirectory(transactionId) {
    return path.join(backupRoot, normalizeTransactionId(transactionId));
  }

  async function atomicWrite(targetPath, content, { mode = BACKUP_FILE_MODE, encoding = null } = {}) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const options = { mode };
    if (encoding) options.encoding = encoding;
    await writeFileFn(temporaryPath, content, options);
    await renameFn(temporaryPath, targetPath);
    await chmodFn(targetPath, mode);
  }

  async function loadExistingManifest(directory, transactionId, planSha256) {
    const manifestPath = path.join(directory, MANIFEST_FILE);
    try {
      const metadata = await lstatFn(manifestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new MailConfigBackupError('mail_backup_manifest_invalid', 'Managed mail backup manifest is not a regular file');
      }
      return normalizeManifest(JSON.parse(await readFileFn(manifestPath, 'utf8')), { transactionId, planSha256 });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof MailConfigBackupError) throw error;
      throw new MailConfigBackupError('mail_backup_manifest_invalid', 'Managed mail backup manifest could not be read');
    }
  }

  async function inspectManifestFiles(directory, manifest) {
    for (const artifact of manifest.artifacts) {
      if (!artifact.present) continue;
      const target = path.join(directory, artifact.backupName);
      try {
        const metadata = await lstatFn(target);
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== BACKUP_FILE_MODE) {
          return false;
        }
        const content = await readFileFn(target);
        if (content.length !== artifact.bytes || sha256(content) !== artifact.sha256) return false;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw new MailConfigBackupError('mail_backup_inspection_failed', 'Managed mail backup artifact could not be inspected');
      }
    }
    return true;
  }

  async function backupNow(preview, { transactionId } = {}) {
    const normalizedTransactionId = normalizeTransactionId(transactionId);
    const plan = previewManagedMailApplyPlan(preview);
    assertPlanArtifactSet(plan);
    const directory = transactionDirectory(normalizedTransactionId);

    const existing = await loadExistingManifest(directory, normalizedTransactionId, plan.sha256);
    if (existing) {
      if (existing.previewSha256 !== plan.previewSha256 || !(await inspectManifestFiles(directory, existing))) {
        throw new MailConfigBackupError('mail_backup_existing_invalid', 'Existing managed mail backup cannot be safely reused');
      }
      return publicManifest(existing);
    }

    await mkdirFn(backupRoot, { recursive: true, mode: DIRECTORY_MODE });
    await chmodFn(backupRoot, DIRECTORY_MODE);
    await mkdirFn(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmodFn(directory, DIRECTORY_MODE);

    const artifacts = [];
    for (let index = 0; index < BACKUP_TARGET_PATHS.length; index += 1) {
      const targetPath = BACKUP_TARGET_PATHS[index];
      let metadata;
      try {
        metadata = await liveLstatFn(targetPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          if (targetPath === POSTFIX_MAIN_CF_PATH) {
            throw new MailConfigBackupError('mail_postfix_main_cf_missing', 'Postfix main.cf is required before managed mail apply can be backed up');
          }
          artifacts.push(Object.freeze({
            targetPath,
            present: false,
            backupName: null,
            sha256: null,
            bytes: 0,
            mode: null,
            uid: null,
            gid: null,
          }));
          continue;
        }
        throw new MailConfigBackupError('mail_live_artifact_inspection_failed', 'Managed mail live artifact could not be inspected');
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new MailConfigBackupError('mail_live_artifact_unsafe', 'Managed mail live artifact must be a regular non-symlink file');
      }
      let content;
      try { content = await liveReadFileFn(targetPath); }
      catch { throw new MailConfigBackupError('mail_live_artifact_read_failed', 'Managed mail live artifact could not be read'); }
      const name = backupName(index, targetPath);
      await atomicWrite(path.join(directory, name), content);
      artifacts.push(Object.freeze({
        targetPath,
        present: true,
        backupName: name,
        sha256: sha256(content),
        bytes: content.length,
        mode: metadata.mode & 0o7777,
        uid: metadata.uid,
        gid: metadata.gid,
      }));
    }

    const manifest = Object.freeze({
      version: MANIFEST_VERSION,
      transactionId: normalizedTransactionId,
      planSha256: plan.sha256,
      previewSha256: plan.previewSha256,
      artifacts: Object.freeze(artifacts),
    });
    await atomicWrite(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: BACKUP_FILE_MODE,
      encoding: 'utf8',
    });
    return publicManifest(manifest);
  }

  function backupConfiguration(preview, options = {}) {
    const run = backupChain.catch(() => {}).then(() => backupNow(preview, options));
    backupChain = run;
    return run;
  }

  async function inspectBackup(preview, { transactionId } = {}) {
    const normalizedTransactionId = normalizeTransactionId(transactionId);
    const plan = previewManagedMailApplyPlan(preview);
    assertPlanArtifactSet(plan);
    const directory = transactionDirectory(normalizedTransactionId);
    const manifest = await loadExistingManifest(directory, normalizedTransactionId, plan.sha256);
    if (!manifest || manifest.previewSha256 !== plan.previewSha256) return { satisfied: false, result: null };
    if (!(await inspectManifestFiles(directory, manifest))) return { satisfied: false, result: null };
    return { satisfied: true, result: publicManifest(manifest) };
  }

  return Object.freeze({
    backupConfiguration,
    inspectBackup,
    transactionDirectory,
  });
}

export const mailConfigBackupInternals = Object.freeze({
  defaultBackupRoot: DEFAULT_BACKUP_ROOT,
  planArtifactPaths: PLAN_ARTIFACT_PATHS,
  postfixCompiledPaths: POSTFIX_COMPILED_PATHS,
  targetPaths: BACKUP_TARGET_PATHS,
  postfixMainCfPath: POSTFIX_MAIN_CF_PATH,
  directoryMode: DIRECTORY_MODE,
  backupFileMode: BACKUP_FILE_MODE,
  normalizeTransactionId,
  normalizeManifest,
  assertPlanArtifactSet,
});
