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
import {
  mailForwardingTemplatePolicy,
  mailSubmissionTemplatePolicy,
  previewManagedMailApplyPlan,
} from '@yunpanel/config-templates';
import { createMailConfigBackupManager, mailConfigBackupInternals } from './mail-config-backup.js';
import { createMailConfigManager } from './mail-config-manager.js';
import { createMailReadinessInspector } from './mail-readiness-inspector.js';
import { parseManagedSystemIdentity, parseManagedVmailIdentity } from './mail-vmail-identity.js';

const execFileAsync = promisify(execFile);
const ROOT_UID = 0;
const ROOT_GID = 0;
const NEW_MANAGED_DIRECTORY_MODE = 0o750;
const SIEVE_SHARED_MODE = 0o640;
const SUBMISSION_SOCKET_MODE = 0o660;
const GETENT = '/usr/bin/getent';
const POSTCONF = '/usr/sbin/postconf';
const MAX_OUTPUT = 128 * 1024;
const UNMANAGED_REQUIRED_DIRECTORIES = Object.freeze([
  '/etc/postfix',
  '/etc/dovecot',
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

function boundedOutput(result) {
  const stdout = String(result?.stdout ?? result ?? '');
  const stderr = String(result?.stderr ?? '');
  if (Buffer.byteLength(stdout) > MAX_OUTPUT || Buffer.byteLength(stderr) > MAX_OUTPUT) {
    throw new Error('bounded output exceeded');
  }
  return stdout.trim();
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
      boundedOutput(result);
      return result;
    } catch {
      throw activationError(code, message);
    }
  }

  async function resolveSystemIdentity(name, code, message) {
    try {
      const result = await run(GETENT, ['passwd', name], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      const output = boundedOutput(result);
      const identity = name === 'vmail'
        ? parseManagedVmailIdentity(output)
        : parseManagedSystemIdentity(output, name);
      if (!identity) throw new Error('invalid system identity');
      return identity;
    } catch {
      throw activationError(code, message);
    }
  }

  const resolveVmailIdentity = () => resolveSystemIdentity(
    'vmail',
    'mail_vmail_identity_unavailable',
    'Managed vmail identity could not be resolved safely',
  );
  const resolvePostfixIdentity = () => resolveSystemIdentity(
    'postfix',
    'mail_postfix_identity_unavailable',
    'Managed postfix identity could not be resolved safely',
  );

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

  async function replaceManagedArtifacts(stage, planSha256, onMutation, vmailGid) {
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
          gid: artifact.targetPath === mailForwardingTemplatePolicy.sievePath ? vmailGid : ROOT_GID,
        });
      } catch {
        throw activationError('mail_live_replace_failed', 'Managed mail configuration could not be replaced');
      }
    }
  }

  async function assertPostfixParameters(plan) {
    for (const parameter of plan.postfixParameters) {
      let output;
      try {
        output = boundedOutput(await run(POSTCONF, ['-h', parameter.name], { timeout: 10_000, maxBuffer: MAX_OUTPUT }));
      } catch {
        throw activationError('mail_postfix_verify_failed', 'Managed Postfix parameter could not be verified');
      }
      if (output !== parameter.value) {
        throw activationError('mail_postfix_verify_failed', 'Managed Postfix parameter did not match the requested value');
      }
    }
  }

  async function assertPostfixMasterServices(plan) {
    for (const service of plan.postfixMasterServices) {
      const identity = `${service.service}/${service.type}`;
      let serviceOutput;
      try {
        serviceOutput = boundedOutput(await run(POSTCONF, ['-M', identity], { timeout: 10_000, maxBuffer: MAX_OUTPUT }));
      } catch {
        throw activationError('mail_postfix_master_verify_failed', 'Managed Postfix submission service could not be verified');
      }
      if (serviceOutput.replace(/\s+/g, ' ') !== service.definition.replace(/\s+/g, ' ')) {
        throw activationError('mail_postfix_master_verify_failed', 'Managed Postfix submission service did not match requested state');
      }
      for (const parameter of service.parameters) {
        const key = `${identity}/${parameter.name}`;
        const expected = `${key}=${parameter.value}`;
        let output;
        try {
          output = boundedOutput(await run(POSTCONF, ['-P', key], { timeout: 10_000, maxBuffer: MAX_OUTPUT }));
        } catch {
          throw activationError('mail_postfix_master_verify_failed', 'Managed Postfix submission override could not be verified');
        }
        if (output !== expected) {
          throw activationError('mail_postfix_master_verify_failed', 'Managed Postfix submission override did not match requested state');
        }
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

  async function secureCompiledSieve(vmailGid) {
    const compiledPath = mailConfigBackupInternals.sieveCompiledPath;
    try {
      let metadata = await lstatFn(compiledPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('unsafe compiled sieve');
      await chownFn(compiledPath, ROOT_UID, vmailGid);
      await chmodFn(compiledPath, SIEVE_SHARED_MODE);
      metadata = await lstatFn(compiledPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.uid !== ROOT_UID || metadata.gid !== vmailGid
        || (metadata.mode & 0o7777) !== SIEVE_SHARED_MODE) {
        throw new Error('compiled sieve metadata mismatch');
      }
    } catch {
      throw activationError('mail_sieve_output_invalid', 'Mailbox forwarding compilation did not produce a safe Sieve binary');
    }
  }

  async function assertSubmissionSocketSafe(postfixIdentity) {
    try {
      const metadata = await lstatFn(mailSubmissionTemplatePolicy.dovecotAuthSocket);
      if (!metadata.isSocket() || metadata.isSymbolicLink()
        || metadata.uid !== postfixIdentity.uid || metadata.gid !== postfixIdentity.gid
        || (metadata.mode & 0o7777) !== SUBMISSION_SOCKET_MODE) {
        throw new Error('submission socket metadata mismatch');
      }
    } catch {
      throw activationError('mail_submission_socket_invalid', 'Dovecot submission authentication socket is unavailable or unsafe');
    }
  }

  async function runApplyCommands(plan, vmailGid, postfixIdentity) {
    for (const command of plan.stages.compile) {
      if (command.file === '/usr/bin/sievec') {
        await runCommand(command, 'mail_sieve_compile_failed', 'Managed mailbox forwarding script compilation failed');
      } else {
        await runCommand(command, 'mail_postmap_failed', 'Postfix managed map compilation failed');
      }
    }
    await assertCompiledMapsSafe();
    await secureCompiledSieve(vmailGid);
    for (const command of plan.stages.configurePostfix) {
      await runCommand(command, 'mail_postconf_failed', 'Postfix managed parameter update failed');
    }
    await assertPostfixParameters(plan);
    for (const command of plan.stages.configurePostfixMaster) {
      await runCommand(command, 'mail_postfix_master_apply_failed', 'Postfix submission service update failed');
    }
    await assertPostfixMasterServices(plan);
    for (const command of plan.stages.validate) {
      await runCommand(command, 'mail_config_validation_failed', 'Managed mail configuration validation failed');
    }
    for (const command of plan.stages.reload) {
      await runCommand(command, 'mail_service_reload_failed', 'Managed mail service reload failed');
    }
    for (const command of plan.stages.health) {
      await runCommand(command, 'mail_service_health_failed', 'Managed mail service did not become healthy');
    }
    await assertSubmissionSocketSafe(postfixIdentity);
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

    const [vmailIdentity, postfixIdentity] = await Promise.all([
      resolveVmailIdentity(),
      resolvePostfixIdentity(),
    ]);
    await assertRequiredDirectoriesSafe();
    await assertLiveMatchesBackup(backup);

    let mutationStarted = false;
    const markMutation = () => { mutationStarted = true; };
    try {
      await createManagedDirectories(backup, markMutation);
      await replaceManagedArtifacts(stage, plan.sha256, markMutation, vmailIdentity.gid);
      await runApplyCommands(plan, vmailIdentity.gid, postfixIdentity);
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
  sieveSharedMode: SIEVE_SHARED_MODE,
  submissionSocketMode: SUBMISSION_SOCKET_MODE,
});
