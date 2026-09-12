import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MailTemplateError, normalizeMailboxAddress } from '@yunpanel/config-templates';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const MAX_ALIASES = 10_000;
const MAX_DESTINATIONS = 20;

export class MailAliasRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailAliasRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    const code = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    throw new MailAliasRegistryError(`invalid_${code}`, `${field} is invalid`);
  }
}

function address(value, code = 'invalid_mail_alias_address') {
  try { return normalizeMailboxAddress(value); }
  catch (error) {
    if (error instanceof MailTemplateError) throw new MailAliasRegistryError(code, error.message);
    throw error;
  }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailAliasRegistryError('invalid_mail_alias_revision', 'expectedRevision must be a positive integer');
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailAliasRegistryError('mail_alias_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function destinations(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_DESTINATIONS) {
    throw new MailAliasRegistryError(
      'invalid_mail_alias_destinations',
      `destinations must contain 1 to ${MAX_DESTINATIONS} email addresses`,
    );
  }
  const normalized = [...new Set(values.map((value) => address(value, 'invalid_mail_alias_destination').address))].sort();
  if (normalized.length < 1) {
    throw new MailAliasRegistryError('invalid_mail_alias_destinations', 'At least one alias destination is required');
  }
  return Object.freeze(normalized);
}

function publicAlias(record) {
  return Object.freeze({
    id: record.id,
    mailDomainId: record.mailDomainId,
    source: record.source,
    destinations: Object.freeze([...record.destinations]),
    enabled: record.enabled,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validatePersisted(record) {
  const fields = new Set([
    'id', 'mailDomainId', 'source', 'destinations', 'enabled', 'revision', 'createdAt', 'updatedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || typeof record.enabled !== 'boolean' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MailAliasRegistryError('mail_alias_state_invalid', 'Mail alias state is invalid', 409);
  }
  const normalizedSource = address(record.source).address;
  const normalizedDestinations = destinations(record.destinations);
  if (record.source !== normalizedSource
    || record.destinations.length !== normalizedDestinations.length
    || record.destinations.some((value, index) => value !== normalizedDestinations[index])) {
    throw new MailAliasRegistryError('mail_alias_state_invalid', 'Mail alias addresses are not canonical', 409);
  }
  if (normalizedDestinations.includes(normalizedSource)) {
    throw new MailAliasRegistryError('mail_alias_state_invalid', 'Mail alias cannot forward to itself', 409);
  }
  return {
    id: uuid(record.id, 'mailAliasId'),
    mailDomainId: uuid(record.mailDomainId, 'mailDomainId'),
    source: normalizedSource,
    destinations: [...normalizedDestinations],
    enabled: record.enabled,
    revision: record.revision,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
}

function assertNoEnabledCycles(records) {
  const enabled = records.filter((record) => record.enabled);
  const bySource = new Map(enabled.map((record) => [record.source, record]));
  const visiting = new Set();
  const visited = new Set();

  function visit(source) {
    if (visiting.has(source)) {
      throw new MailAliasRegistryError('mail_alias_cycle', 'Enabled mail aliases must not contain forwarding cycles', 409);
    }
    if (visited.has(source)) return;
    visiting.add(source);
    for (const destination of bySource.get(source)?.destinations ?? []) {
      if (bySource.has(destination)) visit(destination);
    }
    visiting.delete(source);
    visited.add(source);
  }

  for (const source of bySource.keys()) visit(source);
}

export function createMailAliasRegistry({
  filePath = null,
  now = () => Date.now(),
  getMailDomain = async () => null,
  listMailboxes = async () => [],
} = {}) {
  if (typeof now !== 'function' || typeof getMailDomain !== 'function' || typeof listMailboxes !== 'function') {
    throw new MailAliasRegistryError('mail_alias_dependencies_invalid', 'Mail alias registry dependencies are invalid', 503);
  }
  let state = { version: STORE_VERSION, aliases: [] };
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

  async function requireManagedDomain(mailDomainId) {
    let domain;
    try { domain = await getMailDomain(mailDomainId); }
    catch { throw new MailAliasRegistryError('mail_domain_unavailable', 'Mail domain could not be verified', 503); }
    if (!domain) throw new MailAliasRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    if (domain.managementMode !== 'local') {
      throw new MailAliasRegistryError('mail_domain_not_locally_managed', 'Mail domain is not locally managed', 409);
    }
    return domain;
  }

  function assertSourceDomain(source, domain) {
    if (address(source).domain !== domain.domainName) {
      throw new MailAliasRegistryError('mail_alias_domain_mismatch', 'Alias source must belong to the selected mail domain', 409);
    }
  }

  async function assertMailboxSourceAvailable(mailDomainId, source) {
    let mailboxes;
    try { mailboxes = await listMailboxes({ mailDomainId }); }
    catch { throw new MailAliasRegistryError('mailbox_state_unavailable', 'Mailbox state could not be verified', 503); }
    if (!Array.isArray(mailboxes)) {
      throw new MailAliasRegistryError('mailbox_state_unavailable', 'Mailbox state could not be verified', 503);
    }
    if (mailboxes.some((mailbox) => mailbox?.address === source)) {
      throw new MailAliasRegistryError('mail_alias_mailbox_conflict', 'An address cannot be both a mailbox and an alias source', 409);
    }
  }

  async function validateRelationships(records) {
    if (records.length > MAX_ALIASES
      || new Set(records.map((record) => record.id)).size !== records.length
      || new Set(records.map((record) => record.source)).size !== records.length) {
      throw new MailAliasRegistryError('mail_alias_state_invalid', 'Mail alias identities are not unique', 409);
    }
    for (const record of records) {
      const domain = await requireManagedDomain(record.mailDomainId);
      assertSourceDomain(record.source, domain);
      await assertMailboxSourceAvailable(record.mailDomainId, record.source);
    }
    assertNoEnabledCycles(records);
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.aliases)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'aliases'].includes(field))) {
          throw new MailAliasRegistryError('mail_alias_state_invalid', 'Mail alias store is invalid', 409);
        }
        const aliases = parsed.aliases.map(validatePersisted);
        await validateRelationships(aliases);
        state = { version: STORE_VERSION, aliases };
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
      await validateRelationships(next.aliases);
      await persist(next);
      state = next;
      return output;
    });
    mutationChain = result.catch(() => {});
    return result;
  }

  async function createAlias({ mailDomainId, source: requestedSource, destinations: requestedDestinations } = {}) {
    await ensureInitialized();
    const normalizedDomainId = uuid(mailDomainId, 'mailDomainId');
    const normalizedSource = address(requestedSource).address;
    const normalizedDestinations = destinations(requestedDestinations);
    if (normalizedDestinations.includes(normalizedSource)) {
      throw new MailAliasRegistryError('mail_alias_self_forward', 'Mail alias cannot forward to itself', 409);
    }
    return mutate(async (next) => {
      if (next.aliases.length >= MAX_ALIASES) {
        throw new MailAliasRegistryError('too_many_mail_aliases', `At most ${MAX_ALIASES} mail aliases are supported`, 409);
      }
      const domain = await requireManagedDomain(normalizedDomainId);
      assertSourceDomain(normalizedSource, domain);
      if (next.aliases.some((record) => record.source === normalizedSource)) {
        throw new MailAliasRegistryError('mail_alias_already_exists', 'Mail alias source already exists', 409);
      }
      await assertMailboxSourceAvailable(normalizedDomainId, normalizedSource);
      const current = new Date(now()).toISOString();
      const record = {
        id: randomUUID(),
        mailDomainId: normalizedDomainId,
        source: normalizedSource,
        destinations: [...normalizedDestinations],
        enabled: true,
        revision: 1,
        createdAt: current,
        updatedAt: current,
      };
      next.aliases.push(record);
      return publicAlias(record);
    });
  }

  async function listAliases({ mailDomainId = null } = {}) {
    await ensureInitialized();
    const normalizedDomainId = mailDomainId === null ? null : uuid(mailDomainId, 'mailDomainId');
    return state.aliases
      .filter((record) => normalizedDomainId === null || record.mailDomainId === normalizedDomainId)
      .sort((left, right) => left.source.localeCompare(right.source))
      .map(publicAlias);
  }

  async function getAlias(mailAliasId) {
    await ensureInitialized();
    const normalizedId = uuid(mailAliasId, 'mailAliasId');
    const record = state.aliases.find((candidate) => candidate.id === normalizedId);
    return record ? publicAlias(record) : null;
  }

  async function updateAlias(mailAliasId, { expectedRevision, destinations: requestedDestinations, enabled } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(mailAliasId, 'mailAliasId');
    const expected = revision(expectedRevision);
    const normalizedDestinations = destinations(requestedDestinations);
    if (typeof enabled !== 'boolean') {
      throw new MailAliasRegistryError('invalid_mail_alias_enabled', 'enabled must be a boolean');
    }
    return mutate(async (next) => {
      const record = next.aliases.find((candidate) => candidate.id === normalizedId);
      if (!record) throw new MailAliasRegistryError('mail_alias_not_found', 'Mail alias was not found', 404);
      if (record.revision !== expected) {
        throw new MailAliasRegistryError('stale_mail_alias_revision', 'Mail alias state changed; refresh and retry', 409);
      }
      if (normalizedDestinations.includes(record.source)) {
        throw new MailAliasRegistryError('mail_alias_self_forward', 'Mail alias cannot forward to itself', 409);
      }
      await requireManagedDomain(record.mailDomainId);
      await assertMailboxSourceAvailable(record.mailDomainId, record.source);
      const unchanged = record.enabled === enabled
        && record.destinations.length === normalizedDestinations.length
        && record.destinations.every((value, index) => value === normalizedDestinations[index]);
      if (unchanged) throw new MailAliasRegistryError('mail_alias_no_change', 'Mail alias state is unchanged', 409);
      record.destinations = [...normalizedDestinations];
      record.enabled = enabled;
      record.revision += 1;
      record.updatedAt = new Date(now()).toISOString();
      return publicAlias(record);
    });
  }

  async function deleteAlias(mailAliasId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const normalizedId = uuid(mailAliasId, 'mailAliasId');
    const expected = revision(expectedRevision);
    return mutate(async (next) => {
      const index = next.aliases.findIndex((candidate) => candidate.id === normalizedId);
      if (index < 0) throw new MailAliasRegistryError('mail_alias_not_found', 'Mail alias was not found', 404);
      const record = next.aliases[index];
      if (record.revision !== expected) {
        throw new MailAliasRegistryError('stale_mail_alias_revision', 'Mail alias state changed; refresh and retry', 409);
      }
      if (confirmation !== `delete-mail-alias:${record.source}`) {
        throw new MailAliasRegistryError('mail_alias_confirmation_mismatch', 'Mail alias deletion confirmation does not match', 409);
      }
      await requireManagedDomain(record.mailDomainId);
      next.aliases.splice(index, 1);
    });
  }

  async function materializeEnabledAliases() {
    await ensureInitialized();
    return Object.freeze(state.aliases
      .filter((record) => record.enabled)
      .sort((left, right) => left.source.localeCompare(right.source))
      .map((record) => Object.freeze({
        source: record.source,
        destinations: Object.freeze([...record.destinations]),
      })));
  }

  return Object.freeze({
    init,
    createAlias,
    listAliases,
    getAlias,
    updateAlias,
    deleteAlias,
    materializeEnabledAliases,
  });
}

export const mailAliasRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  maxAliases: MAX_ALIASES,
  maxDestinations: MAX_DESTINATIONS,
  validatePersisted,
  assertNoEnabledCycles,
});
