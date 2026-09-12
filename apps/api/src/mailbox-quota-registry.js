import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const MIN_QUOTA_BYTES = 1024 * 1024;
const MAX_QUOTA_BYTES = 16 * 1024 * 1024 * 1024 * 1024;

export class MailboxQuotaRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailboxQuotaRegistryError';
    this.code = code;
    this.status = status;
  }
}

function mailboxId(value) {
  try { return assertUuid(value, 'mailboxId'); }
  catch { throw new MailboxQuotaRegistryError('invalid_mailbox_id', 'mailboxId is invalid'); }
}

function quotaBytes(value) {
  if (!Number.isSafeInteger(value) || value < MIN_QUOTA_BYTES || value > MAX_QUOTA_BYTES) {
    throw new MailboxQuotaRegistryError(
      'invalid_mailbox_quota_bytes',
      `quotaBytes must be an integer between ${MIN_QUOTA_BYTES} and ${MAX_QUOTA_BYTES}`,
    );
  }
  return value;
}

function expectedRevision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new MailboxQuotaRegistryError(
      'invalid_mailbox_quota_revision',
      `expectedRevision must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailboxQuotaRegistryError('mailbox_quota_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function publicPolicy(record) {
  return Object.freeze({
    mailboxId: record.mailboxId,
    quotaBytes: record.quotaBytes,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validatePersisted(record) {
  const keys = ['mailboxId', 'quotaBytes', 'revision', 'createdAt', 'updatedAt'];
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))
    || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MailboxQuotaRegistryError('mailbox_quota_state_invalid', 'Mailbox quota state is invalid', 409);
  }
  return {
    mailboxId: mailboxId(record.mailboxId),
    quotaBytes: quotaBytes(record.quotaBytes),
    revision: record.revision,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
}

export function createMailboxQuotaRegistry({
  filePath = null,
  now = () => Date.now(),
  getMailbox = async () => null,
} = {}) {
  if (typeof now !== 'function' || typeof getMailbox !== 'function') {
    throw new MailboxQuotaRegistryError('mailbox_quota_dependencies_invalid', 'Mailbox quota registry dependencies are invalid', 503);
  }
  if (filePath !== null && (typeof filePath !== 'string' || !path.isAbsolute(filePath))) {
    throw new MailboxQuotaRegistryError('mailbox_quota_store_path_invalid', 'Mailbox quota store path must be absolute', 500);
  }

  let state = { version: STORE_VERSION, policies: [] };
  let initialized = false;
  let mutationChain = Promise.resolve();

  async function persist(nextState) {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.policies)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((key) => !['version', 'policies'].includes(key))) {
          throw new MailboxQuotaRegistryError('mailbox_quota_state_invalid', 'Mailbox quota store is invalid', 409);
        }
        const policies = parsed.policies.map(validatePersisted);
        if (new Set(policies.map((record) => record.mailboxId)).size !== policies.length) {
          throw new MailboxQuotaRegistryError('mailbox_quota_state_invalid', 'Mailbox quota identities are not unique', 409);
        }
        state = { version: STORE_VERSION, policies };
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          if (error instanceof MailboxQuotaRegistryError) throw error;
          throw new MailboxQuotaRegistryError('mailbox_quota_state_invalid', 'Mailbox quota store could not be read', 409);
        }
        await persist(state);
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function requireMailbox(id) {
    let mailbox;
    try { mailbox = await getMailbox(id); }
    catch { throw new MailboxQuotaRegistryError('mailbox_state_unavailable', 'Mailbox state could not be verified', 503); }
    if (!mailbox || mailbox.id !== id) {
      throw new MailboxQuotaRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
    }
    return mailbox;
  }

  function mutate(operation) {
    const result = mutationChain.then(async () => {
      const next = structuredClone(state);
      const output = await operation(next);
      await persist(next);
      state = next;
      return output;
    });
    mutationChain = result.catch(() => {});
    return result;
  }

  async function getQuota(mailboxIdValue) {
    await ensureInitialized();
    const id = mailboxId(mailboxIdValue);
    await requireMailbox(id);
    const record = state.policies.find((candidate) => candidate.mailboxId === id);
    return record ? publicPolicy(record) : null;
  }

  async function listQuotas() {
    await ensureInitialized();
    return state.policies
      .slice()
      .sort((left, right) => left.mailboxId.localeCompare(right.mailboxId))
      .map(publicPolicy);
  }

  async function setQuota(mailboxIdValue, { expectedRevision: requestedRevision, quotaBytes: requestedBytes } = {}) {
    await ensureInitialized();
    const id = mailboxId(mailboxIdValue);
    const expected = expectedRevision(requestedRevision, { allowZero: true });
    const bytes = quotaBytes(requestedBytes);
    await requireMailbox(id);
    return mutate(async (next) => {
      const record = next.policies.find((candidate) => candidate.mailboxId === id);
      if (!record) {
        if (expected !== 0) {
          throw new MailboxQuotaRegistryError('stale_mailbox_quota_revision', 'Mailbox quota state changed; refresh and retry', 409);
        }
        const current = new Date(now()).toISOString();
        const created = { mailboxId: id, quotaBytes: bytes, revision: 1, createdAt: current, updatedAt: current };
        next.policies.push(created);
        return publicPolicy(created);
      }
      if (record.revision !== expected) {
        throw new MailboxQuotaRegistryError('stale_mailbox_quota_revision', 'Mailbox quota state changed; refresh and retry', 409);
      }
      if (record.quotaBytes === bytes) {
        throw new MailboxQuotaRegistryError('mailbox_quota_no_change', 'Mailbox quota is unchanged', 409);
      }
      record.quotaBytes = bytes;
      record.revision += 1;
      record.updatedAt = new Date(now()).toISOString();
      return publicPolicy(record);
    });
  }

  async function clearQuota(mailboxIdValue, { expectedRevision: requestedRevision, confirmation } = {}) {
    await ensureInitialized();
    const id = mailboxId(mailboxIdValue);
    const expected = expectedRevision(requestedRevision);
    await requireMailbox(id);
    return mutate(async (next) => {
      const index = next.policies.findIndex((candidate) => candidate.mailboxId === id);
      if (index < 0) throw new MailboxQuotaRegistryError('mailbox_quota_not_found', 'Mailbox quota is not configured', 404);
      const record = next.policies[index];
      if (record.revision !== expected) {
        throw new MailboxQuotaRegistryError('stale_mailbox_quota_revision', 'Mailbox quota state changed; refresh and retry', 409);
      }
      if (confirmation !== `clear-mailbox-quota:${id}`) {
        throw new MailboxQuotaRegistryError('mailbox_quota_confirmation_mismatch', 'Mailbox quota removal confirmation does not match', 409);
      }
      next.policies.splice(index, 1);
    });
  }

  async function removeOrphan(mailboxIdValue) {
    await ensureInitialized();
    const id = mailboxId(mailboxIdValue);
    return mutate(async (next) => {
      const index = next.policies.findIndex((candidate) => candidate.mailboxId === id);
      if (index < 0) return false;
      next.policies.splice(index, 1);
      return true;
    });
  }

  return Object.freeze({ init, getQuota, listQuotas, setQuota, clearQuota, removeOrphan });
}

export const mailboxQuotaRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  minQuotaBytes: MIN_QUOTA_BYTES,
  maxQuotaBytes: MAX_QUOTA_BYTES,
  quotaBytes,
  validatePersisted,
});
