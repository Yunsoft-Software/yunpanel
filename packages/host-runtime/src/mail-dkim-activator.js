import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  mailDkimTemplatePolicy,
  previewRspamdDkimSigningConfig,
} from '@yunpanel/config-templates';
import { parseManagedRspamdIdentity } from './mail-rspamd-identity.js';

const execFileAsync = promisify(execFile);
const DEFAULT_BACKUP_ROOT = '/var/lib/yunpanel/recovery/mail-dkim';
const GETENT = '/usr/bin/getent';
const RSPAMADM = '/usr/bin/rspamadm';
const SYSTEMCTL = '/usr/bin/systemctl';
const ROOT_UID = 0;
const ROOT_GID = 0;
const PRIVATE_MODE = 0o600;
const PUBLIC_CONFIG_MODE = 0o640;
const LIVE_KEY_MODE = 0o640;
const LIVE_KEY_DIRECTORY_MODE = 0o750;
const BACKUP_DIRECTORY_MODE = 0o700;
const MAX_OUTPUT = 128 * 1024;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const TRANSACTION_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_VERSION = 1;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const LIVE_KEY_PARENT = path.dirname(mailDkimTemplatePolicy.keyRoot);

export class MailDkimActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDkimActivationError';
    this.code = code;
  }
}

function activationError(code, message) {
  return new MailDkimActivationError(code, message);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function transactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_PATTERN.test(value)) {
    throw activationError('mail_dkim_transaction_invalid', 'DKIM activation transaction id is invalid');
  }
  return value;
}

function publicKeyFromPrivate(privateKeyPem) {
  try {
    return createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
  } catch {
    throw activationError('mail_dkim_private_key_invalid', 'DKIM private key material is invalid');
  }
}

function normalizeBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || Object.keys(bundle).length !== 2 || !bundle.preview || !Array.isArray(bundle.keys)
    || bundle.keys.length < 1 || bundle.keys.length > mailDkimTemplatePolicy.maxDomains) {
    throw activationError('mail_dkim_bundle_invalid', 'DKIM activation bundle is invalid');
  }
  const keys = bundle.keys.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 4
      || typeof entry.domain !== 'string' || typeof entry.selector !== 'string'
      || typeof entry.publicKey !== 'string' || typeof entry.privateKey !== 'string'
      || Buffer.byteLength(entry.privateKey) < 256 || Buffer.byteLength(entry.privateKey) > MAX_PRIVATE_KEY_BYTES) {
      throw activationError('mail_dkim_bundle_invalid', 'DKIM activation key material is invalid');
    }
    if (publicKeyFromPrivate(entry.privateKey) !== entry.publicKey) {
      throw activationError('mail_dkim_private_key_mismatch', 'DKIM private key does not match public metadata');
    }
    return Object.freeze({ ...entry });
  });
  let expected;
  try {
    expected = previewRspamdDkimSigningConfig(keys.map(({ domain, selector, publicKey }) => ({
      domain, selector, publicKey,
    })));
  } catch {
    throw activationError('mail_dkim_bundle_invalid', 'DKIM public signing configuration is invalid');
  }
  if (bundle.preview.sha256 !== expected.sha256
    || bundle.preview.artifact?.path !== expected.artifact.path
    || bundle.preview.artifact?.sha256 !== expected.artifact.sha256
    || bundle.preview.artifact?.content !== expected.artifact.content) {
    throw activationError('mail_dkim_preview_stale', 'DKIM activation preview does not match private material');
  }
  const normalizedKeys = keys
    .map((entry) => Object.freeze({
      ...entry,
      targetPath: mailDkimTemplatePolicy.keyPath(entry.domain, entry.selector),
    }))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return Object.freeze({ preview: expected, keys: Object.freeze(normalizedKeys) });
}

function backupName(index, targetPath) {
  return `${String(index).padStart(2, '0')}-${path.basename(targetPath)}.bak`;
}

export function createMailDkimActivator({
  backupRoot = DEFAULT_BACKUP_ROOT,
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
  rmdirFn = rmdir,
  writeFileFn = writeFile,
} = {}) {
  if (typeof backupRoot !== 'string' || !path.isAbsolute(backupRoot) || path.normalize(backupRoot) !== backupRoot) {
    throw activationError('mail_dkim_backup_root_invalid', 'DKIM recovery root must be an absolute normalized path');
  }
  let activationChain = Promise.resolve();

  async function runCommand(file, args, code, message) {
    try {
      const result = await run(file, args, { timeout: 30_000, maxBuffer: MAX_OUTPUT });
      if (Buffer.byteLength(String(result?.stdout ?? '')) > MAX_OUTPUT
        || Buffer.byteLength(String(result?.stderr ?? '')) > MAX_OUTPUT) throw new Error('bounded output exceeded');
      return result;
    } catch {
      throw activationError(code, message);
    }
  }

  async function resolveRspamdIdentity() {
    const result = await runCommand(
      GETENT,
      ['passwd', '_rspamd'],
      'mail_dkim_rspamd_identity_unavailable',
      'Rspamd service identity could not be verified',
    );
    const identity = parseManagedRspamdIdentity(result?.stdout ?? result);
    if (!identity) {
      throw activationError('mail_dkim_rspamd_identity_invalid', 'Rspamd service identity is invalid');
    }
    return identity;
  }

  async function atomicReplace(targetPath, content, { mode, uid, gid }) {
    const temporary = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporary, content, { mode });
      await renameFn(temporary, targetPath);
      await chownFn(targetPath, uid, gid);
      await chmodFn(targetPath, mode);
    } catch (error) {
      try { await rmFn(temporary, { force: true }); } catch {}
      throw error;
    }
  }

  async function inspectDirectory(directoryPath) {
    try {
      const metadata = await lstatFn(directoryPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw activationError('mail_dkim_live_directory_unsafe', 'DKIM live directory is unsafe');
      }
      return Object.freeze({
        path: directoryPath,
        present: true,
        mode: metadata.mode & 0o7777,
        uid: metadata.uid,
        gid: metadata.gid,
      });
    } catch (error) {
      if (isMissing(error)) return Object.freeze({ path: directoryPath, present: false, mode: null, uid: null, gid: null });
      if (error instanceof MailDkimActivationError) throw error;
      throw activationError('mail_dkim_live_directory_unavailable', 'DKIM live directory could not be inspected');
    }
  }

  async function assertRspamdDirectoriesSafe() {
    for (const directoryPath of ['/etc/rspamd', '/etc/rspamd/local.d']) {
      const snapshot = await inspectDirectory(directoryPath);
      if (!snapshot.present) {
        throw activationError('mail_dkim_required_directory_missing', 'Required Rspamd configuration directory is unavailable');
      }
    }
  }

  async function snapshotArtifact(targetPath, index, directory) {
    let metadata;
    try { metadata = await lstatFn(targetPath); }
    catch (error) {
      if (isMissing(error)) {
        return Object.freeze({
          targetPath,
          present: false,
          backupName: null,
          sha256: null,
          bytes: 0,
          mode: null,
          uid: null,
          gid: null,
        });
      }
      throw activationError('mail_dkim_live_artifact_unavailable', 'DKIM live artifact could not be inspected');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw activationError('mail_dkim_live_artifact_unsafe', 'DKIM live artifact is not a safe regular file');
    }
    let content;
    try { content = await readFileFn(targetPath); }
    catch { throw activationError('mail_dkim_live_artifact_unavailable', 'DKIM live artifact could not be read'); }
    const name = backupName(index, targetPath);
    await atomicReplace(path.join(directory, name), content, {
      mode: PRIVATE_MODE,
      uid: ROOT_UID,
      gid: ROOT_GID,
    });
    return Object.freeze({
      targetPath,
      present: true,
      backupName: name,
      sha256: sha256(content),
      bytes: content.length,
      mode: metadata.mode & 0o7777,
      uid: metadata.uid,
      gid: metadata.gid,
    });
  }

  async function createBackup(bundle, tx) {
    const directory = path.join(backupRoot, tx);
    await mkdirFn(backupRoot, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
    await chmodFn(backupRoot, BACKUP_DIRECTORY_MODE);
    await mkdirFn(directory, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
    await chmodFn(directory, BACKUP_DIRECTORY_MODE);

    const directorySnapshots = Object.freeze([
      await inspectDirectory(LIVE_KEY_PARENT),
      await inspectDirectory(mailDkimTemplatePolicy.keyRoot),
    ]);
    const targetPaths = [
      mailDkimTemplatePolicy.configPath,
      ...bundle.keys.map((entry) => entry.targetPath),
    ];
    const artifacts = [];
    for (let index = 0; index < targetPaths.length; index += 1) {
      artifacts.push(await snapshotArtifact(targetPaths[index], index, directory));
    }
    const manifest = Object.freeze({
      version: MANIFEST_VERSION,
      transactionId: tx,
      previewSha256: bundle.preview.sha256,
      artifacts: Object.freeze(artifacts),
      directories: directorySnapshots,
    });
    await atomicReplace(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: PRIVATE_MODE,
      uid: ROOT_UID,
      gid: ROOT_GID,
    });
    return manifest;
  }

  async function ensureLiveKeyDirectories(rspamdGid, onMutation) {
    for (const directoryPath of [LIVE_KEY_PARENT, mailDkimTemplatePolicy.keyRoot]) {
      const snapshot = await inspectDirectory(directoryPath);
      if (!snapshot.present) {
        onMutation();
        try { await mkdirFn(directoryPath, { mode: LIVE_KEY_DIRECTORY_MODE }); }
        catch { throw activationError('mail_dkim_directory_create_failed', 'DKIM key directory could not be created'); }
      }
      if (directoryPath === mailDkimTemplatePolicy.keyRoot) {
        try {
          await chownFn(directoryPath, ROOT_UID, rspamdGid);
          await chmodFn(directoryPath, LIVE_KEY_DIRECTORY_MODE);
        } catch {
          throw activationError('mail_dkim_directory_permission_failed', 'DKIM key directory permissions could not be secured');
        }
      }
    }
  }

  async function replaceLive(bundle, rspamdGid, onMutation) {
    onMutation();
    try {
      await atomicReplace(mailDkimTemplatePolicy.configPath, bundle.preview.artifact.content, {
        mode: PUBLIC_CONFIG_MODE,
        uid: ROOT_UID,
        gid: ROOT_GID,
      });
    } catch {
      throw activationError('mail_dkim_config_replace_failed', 'Rspamd DKIM signing configuration could not be replaced');
    }
    for (const key of bundle.keys) {
      onMutation();
      try {
        await atomicReplace(key.targetPath, key.privateKey, {
          mode: LIVE_KEY_MODE,
          uid: ROOT_UID,
          gid: rspamdGid,
        });
      } catch {
        throw activationError('mail_dkim_key_replace_failed', 'Rspamd DKIM private key could not be replaced');
      }
    }
  }

  async function assertLive(bundle, rspamdGid) {
    const config = await lstatFn(mailDkimTemplatePolicy.configPath);
    if (!config.isFile() || config.isSymbolicLink() || config.uid !== ROOT_UID || config.gid !== ROOT_GID
      || (config.mode & 0o7777) !== PUBLIC_CONFIG_MODE
      || sha256(await readFileFn(mailDkimTemplatePolicy.configPath)) !== bundle.preview.artifact.sha256) {
      throw activationError('mail_dkim_live_state_invalid', 'Rspamd DKIM signing config does not match desired state');
    }
    for (const key of bundle.keys) {
      const metadata = await lstatFn(key.targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== ROOT_UID || metadata.gid !== rspamdGid
        || (metadata.mode & 0o7777) !== LIVE_KEY_MODE) {
        throw activationError('mail_dkim_live_state_invalid', 'Rspamd DKIM private key permissions do not match desired state');
      }
      const content = await readFileFn(key.targetPath, 'utf8');
      if (publicKeyFromPrivate(content) !== key.publicKey) {
        throw activationError('mail_dkim_live_state_invalid', 'Rspamd DKIM private key does not match desired public key');
      }
    }
  }

  async function restoreArtifact(directory, artifact) {
    if (!artifact.present) {
      try { await rmFn(artifact.targetPath, { force: true }); }
      catch { throw activationError('mail_dkim_restore_failed', 'DKIM rollback could not remove a new artifact'); }
      return;
    }
    const source = path.join(directory, artifact.backupName);
    let content;
    try {
      const metadata = await lstatFn(source);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== PRIVATE_MODE) throw new Error('unsafe backup');
      content = await readFileFn(source);
      if (content.length !== artifact.bytes || sha256(content) !== artifact.sha256) throw new Error('backup drift');
    } catch {
      throw activationError('mail_dkim_restore_failed', 'DKIM rollback backup artifact is unavailable');
    }
    try {
      await atomicReplace(artifact.targetPath, content, {
        mode: artifact.mode,
        uid: artifact.uid,
        gid: artifact.gid,
      });
    } catch {
      throw activationError('mail_dkim_restore_failed', 'DKIM rollback could not restore a previous artifact');
    }
  }

  async function restoreDirectories(manifest) {
    for (const directory of [...manifest.directories].reverse()) {
      if (directory.present) continue;
      try { await rmdirFn(directory.path); }
      catch (error) {
        if (isMissing(error)) continue;
        throw activationError('mail_dkim_restore_failed', 'DKIM rollback could not remove a newly-created directory');
      }
    }
  }

  async function rollback(manifest) {
    const directory = path.join(backupRoot, manifest.transactionId);
    for (const artifact of [...manifest.artifacts].reverse()) await restoreArtifact(directory, artifact);
    await restoreDirectories(manifest);
    await runCommand(RSPAMADM, ['configtest'], 'mail_dkim_restore_validation_failed', 'Restored Rspamd configuration is invalid');
    await runCommand(SYSTEMCTL, ['reload', 'rspamd'], 'mail_dkim_restore_reload_failed', 'Rspamd could not reload restored DKIM state');
    await runCommand(SYSTEMCTL, ['is-active', '--quiet', 'rspamd'], 'mail_dkim_restore_health_failed', 'Rspamd is not healthy after DKIM rollback');
  }

  async function activateNow(input, { transactionId: requestedTransactionId } = {}) {
    const bundle = normalizeBundle(input);
    const tx = transactionId(requestedTransactionId);
    await assertRspamdDirectoriesSafe();
    const rspamd = await resolveRspamdIdentity();
    const manifest = await createBackup(bundle, tx);
    let mutationStarted = false;
    const markMutation = () => { mutationStarted = true; };
    try {
      await ensureLiveKeyDirectories(rspamd.gid, markMutation);
      await replaceLive(bundle, rspamd.gid, markMutation);
      await runCommand(RSPAMADM, ['configtest'], 'mail_dkim_config_validation_failed', 'Rspamd DKIM signing configuration is invalid');
      await runCommand(SYSTEMCTL, ['reload', 'rspamd'], 'mail_dkim_reload_failed', 'Rspamd could not reload DKIM signing configuration');
      await runCommand(SYSTEMCTL, ['is-active', '--quiet', 'rspamd'], 'mail_dkim_health_failed', 'Rspamd is not healthy after DKIM activation');
      await assertLive(bundle, rspamd.gid);
      return Object.freeze({
        version: 1,
        previewSha256: bundle.preview.sha256,
        applied: true,
        sideEffects: true,
      });
    } catch (error) {
      if (!mutationStarted) throw error;
      try { await rollback(manifest); }
      catch { throw activationError('mail_dkim_rollback_failed', 'DKIM activation failed and rollback could not be confirmed'); }
      if (error instanceof MailDkimActivationError) throw error;
      throw activationError('mail_dkim_activation_failed', 'DKIM activation failed and previous state was restored');
    }
  }

  function activate(bundle, options = {}) {
    const operation = activationChain.catch(() => {}).then(() => activateNow(bundle, options));
    activationChain = operation;
    return operation;
  }

  return Object.freeze({ activate });
}

export const mailDkimActivatorInternals = Object.freeze({
  defaultBackupRoot: DEFAULT_BACKUP_ROOT,
  liveKeyParent: LIVE_KEY_PARENT,
  privateMode: PRIVATE_MODE,
  publicConfigMode: PUBLIC_CONFIG_MODE,
  liveKeyMode: LIVE_KEY_MODE,
  liveKeyDirectoryMode: LIVE_KEY_DIRECTORY_MODE,
  maxPrivateKeyBytes: MAX_PRIVATE_KEY_BYTES,
  normalizeBundle,
  publicKeyFromPrivate,
});
