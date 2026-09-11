import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MailTemplateError, normalizeMailboxAddress } from '@yunpanel/config-templates';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';
import { hashMailboxPassword, mailboxPasswordInternals } from './mailbox-password.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

export class MailboxRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailboxRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    const code = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    throw new MailboxRegistryError(`invalid_${code}`, `${field} is invalid`);
  }
}

function address(value) {
  try { return normalizeMailboxAddress(value); }
  catch (error) {
    if (error instanceof MailTemplateError) {
      throw new MailboxRegistryError('invalid_mailbox_address', error.message);
    }
    throw error;
  }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailboxRegistryError('invalid_mailbox_revision', 'expectedRevision must be a positive integer');
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailboxRegistryError('mailbox_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function encryptionKey(value) {
  try { return normalizeEnvironmentMasterKey(value); }
  catch { throw new MailboxRegistryError('invalid_secret_master_key', 'Secret master key is invalid', 500); }
}

function aad(record) {
  return Buffer.from(['mailbox', record.id, record.mailDomainId, record.address].join(':'), 'utf8');
}

function encryptPasswordHash(key, record, passwordHash) {
  if (!key) throw new MailboxRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(record));
  const ciphertext = Buffer.concat([cipher.update(passwordHash, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptPasswordHash(key, record) {
  if (!key) throw new MailboxRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  try {
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    const ciphertext = Buffer.from(record.ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 64 || ciphertext.length > 512) {
      throw new Error('invalid envelope');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(record));
    decipher.setAuthTag(tag);
    const value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (!mailboxPasswordInternals.parseHash(value)) throw new Error('invalid password hash');
    return value;
  } catch (error) {
    if (error instanceof MailboxRegistryError) throw error;
    throw new MailboxRegistryError('secret_decryption_failed', 'Stored mailbox credential could not be decrypted', 500);
  }
}

function publicMailbox(record) {
  return Object.freeze({
    id: record.id,
    mailDomainId: record.mailDomainId,
    address: record.address,
    enabled: record.enabled,
    revision: record.revision,
    passwordConfigured: true,
    passwordUpdatedAt: record.passwordUpdatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validateEnvelope(record) {
  for (const [field, bytes] of [['iv', 12], ['tag', 16]]) {
    if (typeof record[field] !== 'string') {
      throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox credential envelope is invalid', 409);
    }
    const decoded = Buffer.from(record[field], 'base64');
    if (decoded.length !== bytes || decoded.toString('base64') !== record[field]) {
      throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox credential envelope is invalid', 409);
    }
  }
  if (typeof record.ciphertext !== 'string' || record.ciphertext.length < 64 || record.ciphertext.length > 768) {
    throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox credential envelope is invalid', 409);
  }
}

function validatePersisted(record) {
  const fields = new Set([
    'id', 'mailDomainId', 'address', 'enabled', 'revision', 'ciphertext', 'iv', 'tag',
    'passwordUpdatedAt', 'createdAt', 'updatedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || typeof record.enabled !== 'boolean' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox state is invalid', 409);
  }
  const normalizedAddress = address(record.address).address;
  if (normalizedAddress !== record.address) {
    throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox address is not canonical', 409);
  }
  validateEnvelope(record);
  return {
    id: uuid(record.id, 'mailboxId'),
    mailDomainId: uuid(record.mailDomainId, 'mailDomainId'),
    address: normalizedAddress,
    enabled: record.enabled,
    revision: record.revision,
    ciphertext: record.ciphertext,
    iv: record.iv,
    tag: record.tag,
    passwordUpdatedAt: timestamp(record.passwordUpdatedAt, 'passwordUpdatedAt'),
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
}

export function createMailboxRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  now = () => Date.now(),
  getMailDomain = async () => null,
} = {}) {
  const key = encryptionKey(masterKey);
  if (typeof now !== 'function' || typeof getMailDomain !== 'function') {
    throw new MailboxRegistryError('mailbox_dependencies_invalid', 'Mailbox registry dependencies are invalid', 503);
  }
  let state = { version: STORE_VERSION, mailboxes: [] };
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
  }

  async function requireManagedDomain(mailDomainId) {
    let domain;
    try { domain = await getMailDomain(mailDomainId); }
    catch { throw new MailboxRegistryError('mail_domain_unavailable', 'Mail domain could not be verified', 503); }
    if (!domain) throw new MailboxRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    if (domain.managementMode !== 'local') {
      throw new MailboxRegistryError('mail_domain_not_locally_managed', 'Mail domain is not locally managed', 409);
    }
    return domain;
  }

  function assertAddressDomain(mailboxAddress, domain) {
    if (mailboxAddress.domain !== domain.domainName) {
      throw new MailboxRegistryError('mailbox_domain_mismatch', 'Mailbox address must belong to the selected mail domain', 409);
    }
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.mailboxes)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'mailboxes'].includes(field))) {
          throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox store is invalid', 409);
        }
        const mailboxes = parsed.mailboxes.map(validatePersisted);
        if (new Set(mailboxes.map((record) => record.id)).size !== mailboxes.length
          || new Set(mailboxes.map((record) => record.address)).size !== mailboxes.length) {
          throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox identities are not unique', 409);
        }
        for (const record of mailboxes) {
          const domain = await requireManagedDomain(record.mailDomainId);
          assertAddressDomain(address(record.address), domain);
          decryptPasswordHash(key, record);
        }
        state = { version: STORE_VERSION, mailboxes };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist(state);
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
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

  async function createMailbox({ mailDomainId, address: requestedAddress, password } = {}) {
    await ensureInitialized();
    const normalizedDomainId = uuid(mailDomainId, 'mailDomainId');
    const normalizedAddress = address(requestedAddress);
    return mutate(async (next) => {
      const domain = await requireManagedDomain(normalizedDomainId);
      assertAddressDomain(normalizedAddress, domain);
      if (next.mailboxes.some((record) => record.address === normalizedAddress.address)) {
        throw new MailboxRegistryError('mailbox_already_exists', 'Mailbox address already exists', 409);
      }
      const current = new Date(now()).toISOString();
      const record = {
        id: randomUUID(),
        mailDomainId: normalizedDomainId,
        address: normalizedAddress.address,
        enabled: true,
        revision: 1,
        ciphertext: null,
        iv: null,
        tag: null,
        passwordUpdatedAt: current,
        createdAt: current,
        updatedAt: current,
      };
      Object.assign(record, encryptPasswordHash(key, record, await hashMailboxPassword(password)));
      next.mailboxes.push(record);
      return publicMailbox(record);
    });
  }

  async function listMailboxes({ mailDomainId = null } = {}) {
    await ensureInitialized();
    const normalizedDomainId = mailDomainId === null ? null : uuid(mailDomainId, 'mailDomainId');
    return state.mailboxes
      .filter((record) => normalizedDomainId === null || record.mailDomainId === normalizedDomainId)
      .sort((left, right) => left.address.localeCompare(right.address))
      .map(publicMailbox);
  }

  async function getMailbox(mailboxId) {
    await ensureInitialized();
    const normalizedId = uuid(mailboxId, 'mailboxId');
    const record = state.mailboxes.find((candidate) => candidate.id === normalizedId);
    return record ? publicMailbox(record) : null;
  }

  async function rotatePassword(mailboxId, { expectedRevision, password } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(mailboxId, 'mailboxId');
    const expected = revision(expectedRevision);
    return mutate(async (next) => {
      const record = next.mailboxes.find((candidate) => candidate.id === normalizedId);
      if (!record) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (record.revision !== expected) throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox state changed; refresh and retry', 409);
      await requireManagedDomain(record.mailDomainId);
      const current = new Date(now()).toISOString();
      Object.assign(record, encryptPasswordHash(key, record, await hashMailboxPassword(password)));
      record.revision += 1;
      record.passwordUpdatedAt = current;
      record.updatedAt = current;
      return publicMailbox(record);
    });
  }

  async function setEnabled(mailboxId, { expectedRevision, enabled } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(mailboxId, 'mailboxId');
    const expected = revision(expectedRevision);
    if (typeof enabled !== 'boolean') throw new MailboxRegistryError('invalid_mailbox_enabled', 'enabled must be a boolean');
    return mutate(async (next) => {
      const record = next.mailboxes.find((candidate) => candidate.id === normalizedId);
      if (!record) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (record.revision !== expected) throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox state changed; refresh and retry', 409);
      if (record.enabled === enabled) throw new MailboxRegistryError('mailbox_no_change', 'Mailbox enabled state is unchanged', 409);
      await requireManagedDomain(record.mailDomainId);
      record.enabled = enabled;
      record.revision += 1;
      record.updatedAt = new Date(now()).toISOString();
      return publicMailbox(record);
    });
  }

  async function deleteMailbox(mailboxId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(mailboxId, 'mailboxId');
    const expected = revision(expectedRevision);
    return mutate(async (next) => {
      const index = next.mailboxes.findIndex((candidate) => candidate.id === normalizedId);
      if (index < 0) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      const record = next.mailboxes[index];
      if (record.revision !== expected) throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox state changed; refresh and retry', 409);
      if (confirmation !== `delete-mailbox:${record.address}`) {
        throw new MailboxRegistryError('mailbox_confirmation_mismatch', 'Mailbox deletion confirmation does not match', 409);
      }
      await requireManagedDomain(record.mailDomainId);
      next.mailboxes.splice(index, 1);
    });
  }

  async function materializeEnabledAccounts() {
    await ensureInitialized();
    const accounts = [];
    for (const record of state.mailboxes.filter((candidate) => candidate.enabled)
      .sort((left, right) => left.address.localeCompare(right.address))) {
      await requireManagedDomain(record.mailDomainId);
      accounts.push(Object.freeze({
        address: record.address,
        passwordHash: decryptPasswordHash(key, record),
      }));
    }
    return Object.freeze(accounts);
  }

  return Object.freeze({
    init,
    createMailbox,
    listMailboxes,
    getMailbox,
    rotatePassword,
    setEnabled,
    deleteMailbox,
    materializeEnabledAccounts,
  });
}

export function rewrapMailboxSnapshot(snapshot, { currentMasterKey, nextMasterKey } = {}) {
  const currentKey = encryptionKey(currentMasterKey);
  const nextKey = encryptionKey(nextMasterKey);
  if (!currentKey || !nextKey) {
    throw new MailboxRegistryError('secret_store_unavailable', 'Current and next master keys are required', 503);
  }
  if (!snapshot || snapshot.version !== STORE_VERSION || !Array.isArray(snapshot.mailboxes)
    || Object.keys(snapshot).length !== 2 || Object.keys(snapshot).some((field) => !['version', 'mailboxes'].includes(field))) {
    throw new MailboxRegistryError('mailbox_state_invalid', 'Mailbox store is invalid', 409);
  }
  return {
    version: STORE_VERSION,
    mailboxes: snapshot.mailboxes.map((value) => {
      const record = validatePersisted(value);
      return { ...record, ...encryptPasswordHash(nextKey, record, decryptPasswordHash(currentKey, record)) };
    }),
  };
}

export const mailboxRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  validatePersisted,
  encryptPasswordHash,
  decryptPasswordHash,
});
