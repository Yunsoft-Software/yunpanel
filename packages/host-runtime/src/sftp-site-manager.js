import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  renderWebsiteSftpMatch,
  renderWebsiteSftpMountUnit,
  sftpSitePaths,
  sftpTemplatePolicy,
} from '@yunpanel/config-templates/sftp';
import { createApplicationIdentity } from './application-identity.js';
import { createWebsiteIdentityPathManager } from './website-identity-path-manager.js';

const execFileAsync = promisify(execFile);
const SYSTEMD_ESCAPE_PATH = '/usr/bin/systemd-escape';
const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const SSHD_PATH = '/usr/sbin/sshd';
const INSTALL_PATH = '/usr/bin/install';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/sftp-sites';
const RECEIPT_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SftpSiteManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SftpSiteManagerError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function modeOf(value) {
  return Number(value?.mode ?? 0) & 0o777;
}

function operationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new SftpSiteManagerError('sftp_operation_invalid', 'SFTP Website operation id is invalid');
  }
  return value.toLowerCase();
}

function normalizeIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['websiteId', 'applicationId', 'unixUser'].includes(key))
    || typeof value.websiteId !== 'string' || !UUID_PATTERN.test(value.websiteId)) {
    throw new SftpSiteManagerError('sftp_site_intent_invalid', 'SFTP Website intent is invalid');
  }
  let identity;
  try { identity = createApplicationIdentity(value.applicationId); }
  catch { throw new SftpSiteManagerError('sftp_site_application_invalid', 'SFTP Website Application identity is invalid'); }
  if (value.unixUser !== identity.unixUser) {
    throw new SftpSiteManagerError('sftp_site_identity_mismatch', 'SFTP Website Unix identity does not match the Application');
  }
  let paths;
  try { paths = sftpSitePaths({ applicationId: identity.applicationId, unixUser: identity.unixUser }); }
  catch { throw new SftpSiteManagerError('sftp_site_paths_invalid', 'SFTP Website paths are invalid'); }
  if (paths.sourceDirectory !== identity.paths.workspace.sftpRoot) {
    throw new SftpSiteManagerError('sftp_site_path_drift', 'SFTP source root does not match the Website path contract');
  }
  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    applicationId: identity.applicationId,
    unixUser: identity.unixUser,
    identity,
    paths,
    sshdConfig: renderWebsiteSftpMatch({ applicationId: identity.applicationId, unixUser: identity.unixUser }),
    mountUnit: renderWebsiteSftpMountUnit({ applicationId: identity.applicationId, unixUser: identity.unixUser }),
  });
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function normalizeUnitName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 7 || name.length > 255 || !name.endsWith('.mount') || name.includes('/') || /[\r\n\u0000]/.test(name)) {
    throw new SftpSiteManagerError('sftp_mount_unit_invalid', 'systemd returned an invalid SFTP mount unit name');
  }
  return name;
}

function receiptValue(value, { id, spec, unitName } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== RECEIPT_VERSION || value.operationId !== id
    || value.websiteId !== spec.websiteId || value.applicationId !== spec.applicationId
    || value.unixUser !== spec.unixUser || value.unitName !== unitName
    || value.sshdSha256 !== sha256(spec.sshdConfig) || value.mountSha256 !== sha256(spec.mountUnit)
    || !['prepared', 'active', 'compensated'].includes(value.state)) {
    throw new SftpSiteManagerError('sftp_receipt_invalid', 'SFTP Website operation receipt is invalid');
  }
  return Object.freeze({ ...value });
}

export function createSftpSiteManager({
  receiptRoot = RECEIPT_ROOT,
  identityManager = createWebsiteIdentityPathManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    maxBuffer: 256 * 1024,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (!identityManager || typeof identityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function' || typeof renameFn !== 'function'
    || typeof rmFn !== 'function' || typeof writeFileFn !== 'function') {
    throw new SftpSiteManagerError('sftp_dependencies_invalid', 'SFTP Website manager dependencies are invalid');
  }

  async function unitNameFor(spec) {
    try {
      const result = await run(SYSTEMD_ESCAPE_PATH, ['--path', '--suffix=mount', spec.paths.mountDirectory], { timeout: 5_000 });
      return normalizeUnitName(result?.stdout);
    } catch (error) {
      if (error instanceof SftpSiteManagerError) throw error;
      throw new SftpSiteManagerError('sftp_mount_unit_unavailable', 'SFTP mount unit name could not be resolved');
    }
  }

  function unitPath(unitName) {
    return path.posix.join(sftpTemplatePolicy.systemdRoot, unitName);
  }

  function receiptPath(id) {
    return path.posix.join(receiptRoot, `${id}.json`);
  }

  async function atomicWrite(target, content, mode = 0o600) {
    const temporary = `${target}.${process.pid}.tmp`;
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, content, { encoding: 'utf8', mode });
      await renameFn(temporary, target);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function readOptional(target) {
    try { return await readFileFn(target, 'utf8'); }
    catch (error) {
      if (missing(error)) return null;
      throw new SftpSiteManagerError('sftp_artifact_unavailable', 'SFTP managed artifact could not be read');
    }
  }

  async function loadReceipt(id, spec, unitName) {
    const raw = await readOptional(receiptPath(id));
    if (raw === null) return null;
    try { return receiptValue(JSON.parse(raw), { id, spec, unitName }); }
    catch (error) {
      if (error instanceof SftpSiteManagerError) throw error;
      throw new SftpSiteManagerError('sftp_receipt_invalid', 'SFTP Website operation receipt is invalid');
    }
  }

  async function persistReceipt(id, spec, unitName, state) {
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    const receipt = {
      version: RECEIPT_VERSION,
      operationId: id,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      unixUser: spec.unixUser,
      unitName,
      sshdSha256: sha256(spec.sshdConfig),
      mountSha256: sha256(spec.mountUnit),
      state,
    };
    await atomicWrite(receiptPath(id), `${JSON.stringify(receipt)}\n`, 0o600);
    return receiptValue(receipt, { id, spec, unitName });
  }

  async function inspectIdentity(spec) {
    const value = await identityManager.inspect({
      user: spec.unixUser,
      homeDirectory: spec.identity.paths.workspace.homeDirectory,
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
    });
    if (!value?.satisfied) return value;
    if (value.user !== spec.unixUser || value.homeDirectory !== spec.paths.sourceDirectory
      || !Number.isSafeInteger(value.uid) || value.uid < 1 || !Number.isSafeInteger(value.gid) || value.gid < 1) {
      throw new SftpSiteManagerError('sftp_identity_drift', 'SFTP Website Unix identity drifted');
    }
    return value;
  }

  async function inspectRootDirectory(target) {
    let info;
    try { info = await lstatFn(target); }
    catch (error) {
      if (missing(error)) return false;
      throw new SftpSiteManagerError('sftp_chroot_unavailable', 'SFTP chroot directory could not be inspected');
    }
    if (!info?.isDirectory?.() || info.isSymbolicLink?.() || info.uid !== 0 || info.gid !== 0 || modeOf(info) !== 0o755) {
      throw new SftpSiteManagerError('sftp_chroot_drift', 'SFTP chroot directory ownership or mode drifted');
    }
    return true;
  }

  async function mountActive(unitName) {
    try {
      await run(SYSTEMCTL_PATH, ['is-active', '--quiet', unitName], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }

  async function validateSshd() {
    try { await run(SSHD_PATH, ['-t'], { timeout: 15_000 }); }
    catch { throw new SftpSiteManagerError('sftp_sshd_config_invalid', 'OpenSSH rejected the managed SFTP configuration'); }
  }

  async function inspect(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const id = operationId(rawOperationId);
    const unitName = await unitNameFor(spec);
    const receipt = await loadReceipt(id, spec, unitName);
    if (!receipt || receipt.state === 'compensated') {
      return Object.freeze({ satisfied: false, reason: 'sftp_site_not_active' });
    }
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) return Object.freeze({ satisfied: false, reason: identity?.reason ?? 'sftp_identity_unavailable' });

    if (!(await inspectRootDirectory(sftpTemplatePolicy.chrootRoot))
      || !(await inspectRootDirectory(spec.paths.chrootDirectory))) {
      return Object.freeze({ satisfied: false, reason: 'sftp_chroot_missing' });
    }
    const config = await readOptional(spec.paths.sshdConfigPath);
    const mount = await readOptional(unitPath(unitName));
    if (config === null || mount === null) return Object.freeze({ satisfied: false, reason: 'sftp_artifact_missing' });
    if (config !== spec.sshdConfig || mount !== spec.mountUnit) {
      throw new SftpSiteManagerError('sftp_artifact_drift', 'SFTP managed configuration drifted');
    }
    if (!(await mountActive(unitName))) return Object.freeze({ satisfied: false, reason: 'sftp_mount_inactive' });
    await validateSshd();

    return Object.freeze({
      satisfied: true,
      adapter: 'openssh-internal-sftp',
      websiteId: spec.websiteId,
      applicationId: spec.applicationId,
      unixUser: spec.unixUser,
      sourceDirectory: spec.paths.sourceDirectory,
      chrootDirectory: spec.paths.chrootDirectory,
      mountDirectory: spec.paths.mountDirectory,
      unitName,
      sshdConfigPath: spec.paths.sshdConfigPath,
      passwordAuthentication: false,
      publicKeyAuthentication: true,
      umask: sftpTemplatePolicy.umask,
    });
  }

  async function apply(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const id = operationId(rawOperationId);
    const unitName = await unitNameFor(spec);
    let receipt = await loadReceipt(id, spec, unitName);
    if (receipt?.state === 'compensated') {
      throw new SftpSiteManagerError('sftp_operation_compensated', 'Compensated SFTP Website operation cannot be re-applied');
    }
    const identity = await inspectIdentity(spec);
    if (!identity?.satisfied) throw new SftpSiteManagerError('sftp_identity_required', 'Website Unix identity must be ready before SFTP provisioning');

    if (!receipt) {
      const existingConfig = await readOptional(spec.paths.sshdConfigPath);
      const existingUnit = await readOptional(unitPath(unitName));
      if (existingConfig !== null || existingUnit !== null) {
        throw new SftpSiteManagerError('sftp_artifact_conflict', 'Existing SFTP artifacts are not owned by this operation');
      }
      receipt = await persistReceipt(id, spec, unitName, 'prepared');
    }

    try {
      for (const target of [sftpTemplatePolicy.chrootRoot, spec.paths.chrootDirectory, spec.paths.mountDirectory]) {
        await run(INSTALL_PATH, ['-d', '-o', 'root', '-g', 'root', '-m', '0755', target], { timeout: 10_000 });
      }
      await mkdirFn(sftpTemplatePolicy.systemdRoot, { recursive: true, mode: 0o755 });
      await mkdirFn(sftpTemplatePolicy.sshdDropInRoot, { recursive: true, mode: 0o755 });
      await atomicWrite(unitPath(unitName), spec.mountUnit, 0o600);
      await run(SYSTEMCTL_PATH, ['daemon-reload'], { timeout: 30_000 });
      await run(SYSTEMCTL_PATH, ['enable', '--now', unitName], { timeout: 60_000 });
      await atomicWrite(spec.paths.sshdConfigPath, spec.sshdConfig, 0o600);
      await validateSshd();
      await run(SYSTEMCTL_PATH, ['reload', sftpTemplatePolicy.sshServiceUnit], { timeout: 30_000 });
    } catch (error) {
      if (error instanceof SftpSiteManagerError) throw error;
      throw new SftpSiteManagerError('sftp_apply_failed', 'SFTP Website isolation could not be activated');
    }

    receipt = await persistReceipt(id, spec, unitName, 'active');
    const verified = await inspect(rawIntent, { operationId: id });
    if (!verified.satisfied) throw new SftpSiteManagerError('sftp_apply_unverified', 'SFTP Website isolation could not be verified');
    return Object.freeze({ ...verified, receiptState: receipt.state });
  }

  async function inspectCompensation(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const id = operationId(rawOperationId);
    const unitName = await unitNameFor(spec);
    const receipt = await loadReceipt(id, spec, unitName);
    if (!receipt || receipt.state === 'compensated') return Object.freeze({ satisfied: true, removed: true });
    const config = await readOptional(spec.paths.sshdConfigPath);
    const mount = await readOptional(unitPath(unitName));
    if (config === null && mount === null && !(await mountActive(unitName))) {
      return Object.freeze({ satisfied: true, removed: true });
    }
    if ((config !== null && config !== spec.sshdConfig) || (mount !== null && mount !== spec.mountUnit)) {
      return Object.freeze({ satisfied: false, reason: 'sftp_compensation_drift' });
    }
    return Object.freeze({ satisfied: false, reason: 'sftp_compensation_pending' });
  }

  async function compensate(rawIntent, { operationId: rawOperationId } = {}) {
    const spec = normalizeIntent(rawIntent);
    const id = operationId(rawOperationId);
    const unitName = await unitNameFor(spec);
    let receipt = await loadReceipt(id, spec, unitName);
    if (!receipt || receipt.state === 'compensated') return Object.freeze({ satisfied: true, removed: true });
    const before = await inspectCompensation(rawIntent, { operationId: id });
    if (before.satisfied) {
      receipt = await persistReceipt(id, spec, unitName, 'compensated');
      return Object.freeze({ ...before, receiptState: receipt.state });
    }
    if (before.reason === 'sftp_compensation_drift') {
      throw new SftpSiteManagerError('sftp_compensation_drift', 'SFTP managed artifacts changed and cannot be removed safely');
    }

    try {
      await rmFn(spec.paths.sshdConfigPath, { force: true });
      await validateSshd();
      await run(SYSTEMCTL_PATH, ['reload', sftpTemplatePolicy.sshServiceUnit], { timeout: 30_000 });
      await run(SYSTEMCTL_PATH, ['disable', '--now', unitName], { timeout: 60_000 });
      await rmFn(unitPath(unitName), { force: true });
      await run(SYSTEMCTL_PATH, ['daemon-reload'], { timeout: 30_000 });
      await rmFn(spec.paths.mountDirectory, { recursive: true, force: true });
      await rmFn(spec.paths.chrootDirectory, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof SftpSiteManagerError) throw error;
      throw new SftpSiteManagerError('sftp_compensation_failed', 'SFTP Website isolation could not be removed safely');
    }
    receipt = await persistReceipt(id, spec, unitName, 'compensated');
    const after = await inspectCompensation(rawIntent, { operationId: id });
    if (!after.satisfied) throw new SftpSiteManagerError('sftp_compensation_unverified', 'SFTP Website compensation could not be verified');
    return Object.freeze({ ...after, receiptState: receipt.state });
  }

  return Object.freeze({ inspect, apply, inspectCompensation, compensate });
}

export const sftpSiteManagerInternals = Object.freeze({
  normalizeIntent,
  normalizeUnitName,
  receiptValue,
  paths: Object.freeze({
    SYSTEMD_ESCAPE_PATH,
    SYSTEMCTL_PATH,
    SSHD_PATH,
    INSTALL_PATH,
    RECEIPT_ROOT,
  }),
});
