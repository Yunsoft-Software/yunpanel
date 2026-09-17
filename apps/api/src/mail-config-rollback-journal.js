import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/mail-config-rollback-journal';
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,120}$/;
const STATUS_SET = new Set(['restoring_source', 'restored', 'compensated', 'failed']);
const TERMINAL_STATUSES = new Set(['restored', 'compensated', 'failed']);
const JOURNAL_KEYS = Object.freeze([
  'version', 'createdAt', 'updatedAt', 'serverId', 'jobId', 'mailDomainId', 'sourceApplyJobId',
  'previousRevision', 'expectedCurrentRevision', 'currentStatus', 'targetStatus', 'previewDigest',
  'currentConfigurationSha256', 'sourcePlanSha256', 'backupSha256',
  'compensationBackupSha256', 'status', 'lastErrorCode',
]);
const BEGIN_KEYS = Object.freeze(JOURNAL_KEYS.filter(
  (key) => !['version', 'createdAt', 'updatedAt', 'status', 'lastErrorCode'].includes(key),
));

export class MailConfigRollbackJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailConfigRollbackJournalError';
    this.code = code;
  }
}

function normalizeIdentity(serverId, jobId) {
  if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)
    || typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    throw new MailConfigRollbackJournalError('mail_config_rollback_journal_identity_invalid', 'Managed mail rollback journal identity is invalid');
  }
  return { serverId, jobId };
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailConfigRollbackJournalError('mail_config_rollback_journal_invalid', 'Managed mail rollback journal timestamp is invalid');
  }
  return value;
}

function checksum(value, field) {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) {
    throw new MailConfigRollbackJournalError('mail_config_rollback_journal_invalid', `Managed mail rollback journal ${field} is invalid`);
  }
  return value;
}

function normalizeJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORE_VERSION
    || Object.keys(value).length !== JOURNAL_KEYS.length
    || Object.keys(value).some((key) => !JOURNAL_KEYS.includes(key))) {
    throw new MailConfigRollbackJournalError('mail_config_rollback_journal_invalid', 'Managed mail rollback journal is invalid');
  }
  const identity = normalizeIdentity(value.serverId, value.jobId);
  const statusesValid = ['disabled', 'enabled'].includes(value.currentStatus)
    && ['disabled', 'enabled'].includes(value.targetStatus);
  const changedStatus = statusesValid && value.currentStatus !== value.targetStatus;
  const terminalFailure = ['compensated', 'failed'].includes(value.status);
  if (typeof value.mailDomainId !== 'string' || !UUID_PATTERN.test(value.mailDomainId)
    || typeof value.sourceApplyJobId !== 'string' || !JOB_ID_PATTERN.test(value.sourceApplyJobId)
    || !Number.isSafeInteger(value.previousRevision) || value.previousRevision < 1
    || !Number.isSafeInteger(value.expectedCurrentRevision) || value.expectedCurrentRevision < 1
    || value.expectedCurrentRevision !== value.previousRevision + (changedStatus ? 1 : 0)
    || !statusesValid || !STATUS_SET.has(value.status)
    || (terminalFailure ? !ERROR_CODE_PATTERN.test(value.lastErrorCode ?? '') : value.lastErrorCode !== null)) {
    throw new MailConfigRollbackJournalError('mail_config_rollback_journal_invalid', 'Managed mail rollback journal state is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    ...identity,
    mailDomainId: value.mailDomainId.toLowerCase(),
    sourceApplyJobId: value.sourceApplyJobId,
    previousRevision: value.previousRevision,
    expectedCurrentRevision: value.expectedCurrentRevision,
    currentStatus: value.currentStatus,
    targetStatus: value.targetStatus,
    previewDigest: checksum(value.previewDigest, 'previewDigest'),
    currentConfigurationSha256: checksum(value.currentConfigurationSha256, 'currentConfigurationSha256'),
    sourcePlanSha256: checksum(value.sourcePlanSha256, 'sourcePlanSha256'),
    backupSha256: checksum(value.backupSha256, 'backupSha256'),
    compensationBackupSha256: checksum(value.compensationBackupSha256, 'compensationBackupSha256'),
    status: value.status,
    lastErrorCode: value.lastErrorCode,
  });
}

export function createMailConfigRollbackJournal({
  root = DEFAULT_ROOT,
  now = () => Date.now(),
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new MailConfigRollbackJournalError('mail_config_rollback_journal_root_invalid', 'Managed mail rollback journal root must be an absolute normalized path');
  }
  let writeChain = Promise.resolve();

  function journalPath(serverId, jobId) {
    const identity = normalizeIdentity(serverId, jobId);
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }

  async function persist(journal) {
    const normalized = normalizeJournal(journal);
    const directory = path.join(root, normalized.serverId);
    const target = journalPath(normalized.serverId, normalized.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdirFn(root, { recursive: true, mode: 0o700 });
      await chmodFn(root, 0o700);
      await mkdirFn(directory, { recursive: true, mode: 0o700 });
      await chmodFn(directory, 0o700);
      await writeFileFn(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await renameFn(temporary, target);
      await chmodFn(target, 0o600);
    });
    await writeChain;
    return normalized;
  }

  async function read(serverId, jobId) {
    const target = journalPath(serverId, jobId);
    let metadata;
    try {
      metadata = await lstatFn(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
        throw new MailConfigRollbackJournalError('mail_config_rollback_journal_unsafe', 'Managed mail rollback journal is not a protected regular file');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof MailConfigRollbackJournalError) throw error;
      throw new MailConfigRollbackJournalError('mail_config_rollback_journal_read_failed', 'Managed mail rollback journal could not be inspected');
    }
    try { return normalizeJournal(JSON.parse(await readFileFn(target, 'utf8'))); }
    catch (error) {
      if (error instanceof MailConfigRollbackJournalError) throw error;
      throw new MailConfigRollbackJournalError('mail_config_rollback_journal_invalid', 'Managed mail rollback journal could not be read');
    }
  }

  async function begin(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== BEGIN_KEYS.length
      || Object.keys(input).some((key) => !BEGIN_KEYS.includes(key))) {
      throw new MailConfigRollbackJournalError('mail_config_rollback_journal_invalid', 'Managed mail rollback journal input is invalid');
    }
    const existing = await read(input.serverId, input.jobId);
    if (existing) {
      throw new MailConfigRollbackJournalError('mail_config_rollback_journal_conflict', 'Managed mail rollback journal already exists and requires recovery');
    }
    const createdAt = new Date(now()).toISOString();
    return persist({
      version: STORE_VERSION,
      createdAt,
      updatedAt: createdAt,
      ...input,
      status: 'restoring_source',
      lastErrorCode: null,
    });
  }

  async function transition(serverId, jobId, { status, lastErrorCode = null } = {}) {
    const current = await read(serverId, jobId);
    if (!current) {
      throw new MailConfigRollbackJournalError('mail_config_rollback_journal_missing', 'Managed mail rollback journal was not found');
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new MailConfigRollbackJournalError('mail_config_rollback_journal_terminal', 'Managed mail rollback journal is already terminal');
    }
    if (!TERMINAL_STATUSES.has(status)) {
      throw new MailConfigRollbackJournalError('mail_config_rollback_journal_transition_invalid', 'Managed mail rollback journal transition is invalid');
    }
    const updatedAt = new Date(Math.max(now(), Date.parse(current.updatedAt) + 1)).toISOString();
    return persist({ ...current, status, lastErrorCode, updatedAt });
  }

  return Object.freeze({ begin, read, transition, journalPath });
}

export const mailConfigRollbackJournalInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  statuses: Object.freeze([...STATUS_SET]),
  normalizeJournal,
});
