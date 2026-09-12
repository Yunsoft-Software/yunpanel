import { createHash, randomBytes } from 'node:crypto';
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
import { previewManagedMailApplyPlan } from '@yunpanel/config-templates';
import { createMailConfigBackupManager, mailConfigBackupInternals } from './mail-config-backup.js';
import { createMailConfigManager } from './mail-config-manager.js';
import { createMailReadinessInspector } from './mail-readiness-inspector.js';

const execFileAsync = promisify(execFile);
const ROOT_UID = 0;
const ROOT_GID = 0;
const NEW_MANAGED_DIRECTORY_MODE = 0o750;
const MAX_OUTPUT = 128 * 1024;
const UNMANAGED_REQUIRED_DIRECTORIES = Object.freeze([
  '/etc/postfix',
  '/etc/dovecot/conf.d',
  '/etc/rspamd/local.d',
]);

export class MailConfigActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailConfigActivationError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function activationError(code, message) {
  return new MailConfigActivationError(code, message);
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

export function createMailConfigActivator({
  configManager = createMailConfigManager(),
  backupManager = createMailConfigBackupManager(),
  readinessInspector = createMailReadinessInspector(),
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
  if (!configManager || typeof configManager.inspectStagedConfiguration !== 'function'
    || typeof configManager.stageDirectory !== 'function') {
    throw activationError('mail_config_manager_invalid', 'Managed mail staging manager is unavailable');
  }
  if (!backupManager || typeof backupManager.inspectBackup !== 'function'
    || typeof backupManager.transactionDirectory !== 'function') {
    throw activationError('mail_backup_manager_invalid', 'Managed mail backup manager is unavailable');
  }
  if (!readinessInspector || typeof readinessInspector.inspect !== 'function') {
    throw activationError('mail_readiness_inspector_invalid', 'Managed mail readiness inspector is unavailable');
  }

  let activationChain = Promise.resolve();

  async function runCommand(command, code, message) {
    try {
      const result = await run(command.file, command.args, { timeout: 30_000, maxBuffer: MAX_OUTPUT });
      if (Buffer.byteLength(String(result?.stdout ?? '')) > MAX_OUTPUT
        || Buffer.byteLength(String(result?.stderr ?? '')) > MAX_OUTPUT) {
        throw new Error('bounded output exceeded');
      }
      return result;
    } catch {
      throw activationError(code, message);
    }
  }

  async function atomicReplace(targetPath, content, { mode, uid = ROOT_UID, gid = ROOT_GID } = {}) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { mode });
      await renameFn(temporaryPath, targetPath);
      await chownFn(targetPath, uid, gid);
      await chmodFn(targetPath, mode);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function inspectLiveArtifact(artifact) {
    try {
      const metadata = await lstatFn(artifact.targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
      if (!artifact.present) return false;
      if ((metadata.mode & 0o7777) !== artifact.mode || metadata.uid !== artifact.uid || metadata.gid !== artifact.gid) return false;
      const content = await readFileFn(artifact.targetPath);
      return content.length === artifact.bytes && sha256(content) === artifact.sha256;
    } catch (error) {
      return !artifact.present && isMissing(error);
    }
  }

  async function inspectManagedDirectory(directory) {
    try {
      const metadata = await lstatFn(directory.path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
      if (!directory.present) return false;
      return (metadata.mode & 0o7777) === directory.mode
        && metadata.uid === directory.uid
        && metadata.gid === directory.gid;
    } catch (error) {
      return !directory.present && isMissing(error);
    }
  }

  async function assertLiveMatchesBackup(backup) {
    for (const directory of backup.directories) {
      if (!(await inspectManagedDirectory(directory))) {
        throw activationError('mail_live_state_changed', 'Managed mail live directory state changed after backup');
      }
    }
    for (const artifact of backup.artifacts) {
      if (!(await inspectLiveArtifact(artifact))) {
        throw activationError('mail_live_state_changed', 'Managed mail live file state changed after backup');
      }
    }
  }

  async function assertRequiredDirectoriesSafe() {
    for (const directoryPath of UNMANAGED_REQUIRED_DIRECTORIES) {
      try {
        const metadata = await lstatFn(directoryPath);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe directory');
      } catch {
        throw activationError('mail_required_directory_unsafe', 'Required mail service configuration directory is unavailable or unsafe');
      }
    }
  }

  async function createManagedDirectories(backup, onCreated) {
    for (const directory of backup.directories) {
      if (directory.present) continue;
      try {
        await mkdirFn(directory.path, { mode: NEW_MANAGED_DIRECTORY_MODE });
        onCreated();
        await chownFn(directory.path, ROOT_UID, ROOT_GID);
        await chmodFn(directory.path, NEW_MANAGED_DIRECTORY_MODE);
      } catch (error) {
        if (error instanceof MailConfigActivationError) throw error;
        throw activationError('mail_directory_create_failed', 'Managed mail configuration directory could not be created');
      }
    }
  }

  async function readStagedArtifact(stageDirectory, artifact) {
    const stagedPath = path.join(stageDirectory, artifact.stagedName);
    try {
      const metadata = await lstatFn(stagedPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('unsafe stage');
      const content = await readFileFn(stagedPath);
      if (content.length !== artifact.bytes || sha256(content) !== artifact.sha256
        || (metadata.mode & 0o777) !== artifact.mode) {
        throw new Error('changed stage');
      }
      return content;
    } catch {
      throw activationError('mail_stage_changed', 'Managed mail staged artifact changed before activation');
    }
  }

  async function replaceManagedArtifacts(stage, planSha256, onMutation) {
    const stageDirectory = configManager.stageDirectory(planSha256);
    for (const artifact of stage.artifacts) {
      const content = await readStagedArtifact(stageDirectory, artifact);
      try {
        const parent = await lstatFn(path.dirname(artifact.targetPath));
        if (!parent.isDirectory() || parent.isSymbolicLink()) {
          throw activationError('mail_live_parent_unsafe', 'Managed mail target parent is not a safe directory');
        }
      } catch (error) {
        if (error instanceof MailConfigActivationError) throw error;
        throw activationError('mail_live_parent_unavailable', 'Managed mail target directory is unavailable');
      }
      try {
        const existing = await lstatFn(artifact.targetPath);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw activationError('mail_live_target_unsafe', 'Managed mail target is not a regular file');
        }
      } catch (error) {
        if (!isMissing(error)) {
          if (error instanceof MailConfigActivationError) throw error;
          throw activationError('mail_live_target_inspection_failed', 'Managed mail target could not be inspected');
        }
      }
      onMutation();
      try {
        await atomicReplace(artifact.targetPath, content, {
          mode: artifact.mode,
          uid: ROOT_UID,
          gid: ROOT_GID,
        });
      } catch {
        throw activationError('mail_live_replace_failed', 'Managed mail configuration could not be replaced');
      }
    }
  }

  async function assertPostfixParameters(plan) {
    for (const parameter of plan.postfixParameters) {
      let result;
      try {
        result = await run('/usr/sbin/postconf', ['-h', parameter.name], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      } catch {
        throw activationError('mail_postfix_verify_failed', 'Managed Postfix parameter could not be verified');
      }
      const output = String(result?.stdout ?? result ?? '').trim();
      if (Buffer.byteLength(output) > MAX_OUTPUT || output !== parameter.value) {
        throw activationError('mail_postfix_verify_failed', 'Managed Postfix parameter did not match the requested value');
      }
    }
  }

  async function assertCompiledMapsSafe() {
    for (const compiledPath of mailConfigBackupInternals.postfixCompiledPaths) {
      try {
        const metadata = await lstatFn(compiledPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('unsafe compiled map');
      } catch {
        throw activationError('mail_postmap_output_invalid', 'Postfix map compilation did not produce a safe database file');
      }
    }
  }

  async function runApplyCommands(plan) {
    for (const command of plan.stages.compile) {
      await runCommand(command, 'mail_postmap_failed', 'Postfix managed map compilation failed');
    }
    await assertCompiledMapsSafe();
    for (const command of plan.stages.configurePostfix) {
      await runCommand(command, 'mail_postconf_failed', 'Postfix managed parameter update failed');
    }
    await assertPostfixParameters(plan);
    for (const command of plan.stages.validate) {
      await runCommand(command, 'mail_config_validation_failed', 'Managed mail configuration validation failed');
    }
    for (const command of plan.stages.reload) {
      await runCommand(command, 'mail_service_reload_failed', 'Managed mail service reload failed');
    }
    for (const command of plan.stages.health) {
      await runCommand(command, 'mail_service_health_failed', 'Managed mail service did not become healthy');
    }
  }

  async function restoreBackupFile(backupDirectory, artifact) {
    if (!artifact.present) {
      try { await rmFn(artifact.targetPath, { force: true }); }
      catch { throw activationError('mail_restore_failed', 'Managed mail rollback could not remove a newly-created file'); }
      return;
    }
    let content;
    try {
      const source = path.join(backupDirectory, artifact.backupName);
      const metadata = await lstatFn(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('unsafe backup');
      content = await readFileFn(source);
      if (content.length !== artifact.bytes || sha256(content) !== artifact.sha256) throw new Error('changed backup');
    } catch {
      throw activationError('mail_restore_failed', 'Managed mail rollback backup artifact is unavailable');
    }
    try {
      await atomicReplace(artifact.targetPath, content, {
        mode: artifact.mode,
        uid: artifact.uid,
        gid: artifact.gid,
      });
    } catch {
      throw activationError('mail_restore_failed', 'Managed mail rollback could not restore a previous file');
    }
  }

  async function removeCreatedDirectories(backup) {
    for (const directory of [...backup.directories].reverse()) {
      if (directory.present) continue;
      try { await rmdirFn(directory.path); }
      catch (error) {
        if (isMissing(error)) continue;
        throw activationError('mail_restore_failed', 'Managed mail rollback could not remove a newly-created directory');
      }
    }
  }

  async function rollback(preview, plan, backup, transactionId) {
    const backupDirectory = backupManager.transactionDirectory(transactionId);
    for (const artifact of [...backup.artifacts].reverse()) {
      await restoreBackupFile(backupDirectory, artifact);
    }
    await removeCreatedDirectories(backup);
    for (const command of plan.rollback.validate) {
      await runCommand(command, 'mail_restore_validation_failed', 'Restored mail configuration validation failed');
    }
    for (const command of plan.rollback.reload) {
      await runCommand(command, 'mail_restore_reload_failed', 'Restored mail service reload failed');
    }
    for (const command of plan.rollback.health) {
      await runCommand(command, 'mail_restore_health_failed', 'Restored mail service did not become healthy');
    }
    const readiness = await readinessInspector.inspect(preview);
    if (!readiness.ready || readiness.previewSha256 !== preview.sha256) {
      throw activationError('mail_restore_readiness_failed', 'Restored mail host readiness could not be confirmed');
    }
    await assertLiveMatchesBackup(backup);
  }

  async function activateNow(preview, { transactionId } = {}) {
    const plan = previewManagedMailApplyPlan(preview);
    const readiness = await readinessInspector.inspect(preview);
    if (!readiness.ready || readiness.previewSha256 !== preview.sha256) {
      throw activationError('mail_host_not_ready', 'Managed mail host readiness requirements are not satisfied');
    }

    const [staged, backedUp] = await Promise.all([
      configManager.inspectStagedConfiguration(preview),
      backupManager.inspectBackup(preview, { transactionId }),
    ]);
    if (!staged?.satisfied || !backedUp?.satisfied) {
      throw activationError('mail_activation_prerequisite_missing', 'Managed mail staging or pre-apply backup is missing');
    }
    const stage = staged.result;
    const backup = backedUp.result;
    if (stage.planSha256 !== plan.sha256 || backup.planSha256 !== plan.sha256
      || stage.previewSha256 !== preview.sha256 || backup.previewSha256 !== preview.sha256) {
      throw activationError('mail_activation_prerequisite_stale', 'Managed mail staging or backup belongs to a different configuration');
    }

    await assertRequiredDirectoriesSafe();
    await assertLiveMatchesBackup(backup);

    let mutationStarted = false;
    const markMutation = () => { mutationStarted = true; };
    try {
      await createManagedDirectories(backup, markMutation);
      await replaceManagedArtifacts(stage, plan.sha256, markMutation);
      await runApplyCommands(plan);
      const finalReadiness = await readinessInspector.inspect(preview);
      if (!finalReadiness.ready || finalReadiness.previewSha256 !== preview.sha256) {
        throw activationError('mail_post_apply_readiness_failed', 'Managed mail host readiness failed after activation');
      }
      return Object.freeze({
        version: 1,
        previewSha256: preview.sha256,
        planSha256: plan.sha256,
        readinessSha256: finalReadiness.sha256,
        applied: true,
        sideEffects: true,
      });
    } catch (error) {
      if (!mutationStarted) throw error;
      try { await rollback(preview, plan, backup, transactionId); }
      catch {
        throw activationError('mail_config_rollback_failed', 'Managed mail activation failed and the previous configuration could not be confirmed');
      }
      if (error instanceof MailConfigActivationError) throw error;
      throw activationError('mail_config_activation_failed', 'Managed mail activation failed and the previous configuration was restored');
    }
  }

  function activateConfiguration(preview, options = {}) {
    const runActivation = activationChain.catch(() => {}).then(() => activateNow(preview, options));
    activationChain = runActivation;
    return runActivation;
  }

  return Object.freeze({ activateConfiguration });
}

export const mailConfigActivatorInternals = Object.freeze({
  unmanagedRequiredDirectories: UNMANAGED_REQUIRED_DIRECTORIES,
  newManagedDirectoryMode: NEW_MANAGED_DIRECTORY_MODE,
});
