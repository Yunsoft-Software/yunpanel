import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/system-upgrades';
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[A-Za-z0-9.+:~_-]{1,100}$/;
const RECEIPT_KEYS = new Set([
  'version', 'recordedAt', 'serverId', 'jobId', 'packageName', 'installedVersion', 'candidateVersion',
  'updateAvailable', 'previousVersion', 'upgraded', 'restartScheduled',
]);

export class SystemUpgradeReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SystemUpgradeReceiptError';
    this.code = code;
  }
}

function normalizeVersion(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new SystemUpgradeReceiptError('system_upgrade_receipt_version_invalid', `${label} version is invalid`);
  }
  return value;
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))
    || value.version !== STORE_VERSION
    || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.serverId !== 'string' || !SERVER_ID_PATTERN.test(value.serverId)
    || typeof value.jobId !== 'string' || !JOB_ID_PATTERN.test(value.jobId)
    || value.packageName !== 'yunpanel'
    || typeof value.updateAvailable !== 'boolean'
    || typeof value.upgraded !== 'boolean'
    || typeof value.restartScheduled !== 'boolean') {
    throw new SystemUpgradeReceiptError('system_upgrade_receipt_invalid', 'System upgrade receipt metadata is invalid');
  }

  const installedVersion = normalizeVersion(value.installedVersion, 'installed');
  const candidateVersion = normalizeVersion(value.candidateVersion, 'candidate', { nullable: true });
  const previousVersion = normalizeVersion(value.previousVersion, 'previous');
  const expectedUpdate = Boolean(candidateVersion && installedVersion !== candidateVersion);
  if (value.updateAvailable !== expectedUpdate) {
    throw new SystemUpgradeReceiptError('system_upgrade_receipt_state_invalid', 'System upgrade receipt package state is inconsistent');
  }
  if (value.upgraded) {
    if (installedVersion === previousVersion || value.restartScheduled !== true) {
      throw new SystemUpgradeReceiptError('system_upgrade_receipt_transition_invalid', 'System upgrade receipt version transition is inconsistent');
    }
  } else if (installedVersion !== previousVersion || value.restartScheduled !== false) {
    throw new SystemUpgradeReceiptError('system_upgrade_receipt_transition_invalid', 'No-op system upgrade receipt is inconsistent');
  }

  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: value.recordedAt,
    serverId: value.serverId,
    jobId: value.jobId.toLowerCase(),
    packageName: 'yunpanel',
    installedVersion,
    candidateVersion,
    updateAvailable: value.updateAvailable,
    previousVersion,
    upgraded: value.upgraded,
    restartScheduled: value.restartScheduled,
  });
}

export function createSystemUpgradeReceiptStore({ root = DEFAULT_ROOT, now = () => Date.now() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof now !== 'function') {
    throw new SystemUpgradeReceiptError('system_upgrade_receipt_dependencies_invalid', 'System upgrade receipt store configuration is invalid');
  }

  function receiptPath(serverId, jobId) {
    if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
      || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
      throw new SystemUpgradeReceiptError('system_upgrade_receipt_identity_invalid', 'System upgrade receipt identity is invalid');
    }
    return path.join(root, serverId, `${jobId.toLowerCase()}.json`);
  }

  async function write({ serverId, jobId, result }) {
    if (!result || result.packageName !== 'yunpanel' || result.installed !== true) {
      throw new SystemUpgradeReceiptError('system_upgrade_receipt_result_invalid', 'System upgrade result is not safe recovery evidence');
    }
    const receipt = normalize({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      serverId,
      jobId,
      packageName: result.packageName,
      installedVersion: result.installedVersion,
      candidateVersion: result.candidateVersion ?? null,
      updateAvailable: result.updateAvailable,
      previousVersion: result.previousVersion,
      upgraded: result.upgraded,
      restartScheduled: result.restartScheduled,
    });
    const directory = path.join(root, receipt.serverId);
    const target = receiptPath(receipt.serverId, receipt.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
    return receipt;
  }

  async function read(serverId, jobId) {
    const target = receiptPath(serverId, jobId);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(target, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new SystemUpgradeReceiptError('system_upgrade_receipt_read_failed', 'System upgrade receipt could not be read');
    }
    return normalize(parsed);
  }

  return Object.freeze({ write, read, receiptPath });
}

export const systemUpgradeReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalize,
});
