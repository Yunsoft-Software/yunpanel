import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MailTemplateError, normalizeMailboxAddress } from '@yunpanel/config-templates';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const MAX_DESTINATIONS = 4;
const MODES = new Set(['copy', 'redirect']);

export class MailboxForwardingRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailboxForwardingRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field = 'mailboxId') {
  try { return assertUuid(value, field); }
  catch {
    throw new MailboxForwardingRegistryError('invalid_mailbox_id', 'mailboxId is invalid');
  }
}

function revision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new MailboxForwardingRegistryError(
      'invalid_mailbox_forwarding_revision',
      `expectedRevision must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function mode(value) {
  if (typeof value !== 'string' || !MODES.has(value)) {
    throw new MailboxForwardingRegistryError('invalid_mailbox_forwarding_mode', 'mode must be copy or redirect');
  }
  return value;
}

function address(value) {
  try { return normalizeMailboxAddress(value).address; }
  catch (error) {
    if (error instanceof MailTemplateError) {
      throw new MailboxForwardingRegistryError('invalid_mailbox_forwarding_destination', error.message);
    }
    throw error;
  }
}

function destinations(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_DESTINATIONS) {
    throw new MailboxForwardingRegistryError(
      'invalid_mailbox_forwarding_destinations',
      `destinations must contain 1 to ${MAX_DESTINATIONS} email addresses`,
    );
  }
  const normalized = [...new Set(values.map(address))].sort();
  if (normalized.length < 1 || normalized.length > MAX_DESTINATIONS) {
    throw new MailboxForwardingRegistryError(
      'invalid_mailbox_forwarding_destinations',
      `destinations must contain 1 to ${MAX_DESTINATIONS} unique email addresses`,
    );
  }
  return Object.freeze(normalized);
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailboxForwardingRegistryError('mailbox_forwarding_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function publicPolicy(record) {
  return Object.freeze({
    mailboxId: record.mailboxId,
    mode: record.mode,
    destinations: Object.freeze([...record.destinations]),
    enabled: record.enabled,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validatePersisted(record) {
  const fields = new Set(['mailboxId', 'mode', 'destinations', 'enabled', 'revision', 'createdAt', 'updatedAt']);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || typeof record.enabled !== 'boolean' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MailboxForwardingRegistryError('mailbox_forwarding_state_invalid', 'Mailbox forwarding state is invalid', 409);
  }
  const normalizedDestinations = destinations(record.destinations);
  if (normalizedDestinations.length !== record.destinations.length
    || normalizedDestinations.some((value, index) => value !== record.destinations[index])) {
    throw new MailboxForwardingRegistryError('mailbox_forwarding_state_invalid', 'Mailbox forwarding destinations are not canonical', 409);
  }
  return {
    mailboxId: uuid(record.mailboxId),
    mode: mode(record.mode),
    destinations: [...normalizedDestinations],
    enabled: record.enabled,
    revision: record.revision,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
}

function assertNoForwardingCycles(materialized) {
  const bySource = new Map(materialized.filter((policy) => policy.enabled).map((policy) => [policy.source, policy]));
  const visiting = new Set();
  const visited = new Set();
  function visit(source) {
    if (visiting.has(source)) {
      throw new MailboxForwardingRegistryError(
        'mailbox_forwarding_cycle',
        'Enabled mailbox forwarding policies must not contain forwarding cycles',
        409,
      );
    }
    if (visited.has(source)) return;
    visiting.add(source);
    const policy = bySource.get(source);
    for (const destination of policy?.destinations ?? []) {
      if (destination === source) {
        throw new MailboxForwardingRegistryError(
          'mailbox_forwarding_self_destination',
          'Mailbox cannot forward to its own address',
          409,
        );
      }
      if (bySource.has(destination)) visit(destination);
    }
    visiting.delete(source);
    visited.add(source);
  }
  for (const source of bySource.keys()) visit(source);
}

export function createMailboxForwardingRegistry({
  filePath = null,
  now = () => Date.now(),
  getMailbox = async () => null,
} = {}) {
  if (typeof now !== 'function' || typeof getMailbox !== 'function') {
    throw new MailboxForwardingRegistryError(
      'mailbox_forwarding_dependencies_invalid',
      'Mailbox forwarding registry dependencies are invalid',
      503,
    );
  }
  let state = { version: STORE_VERSION, forwardings: [] };
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

  async function mailbox(mailboxId) {
    let value;
    try { value = await getMailbox(mailboxId); }
    catch {
      throw new MailboxForwardingRegistryError('mailbox_unavailable', 'Mailbox could not be verified', 503);
    }
    if (!value || value.id !== mailboxId || typeof value.address !== 'string') {
      throw new MailboxForwardingRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
    }
    return value;
  }

  async function materialize(records = state.forwardings) {
    const result = [];
    for (const record of records) {
      const owner = await mailbox(record.mailboxId);
      const source = address(owner.address);
      result.push(Object.freeze({
        mailboxId: record.mailboxId,
        source,
        mode: record.mode,
        destinations: Object.freeze([...record.destinations]),
        enabled: record.enabled,
        revision: record.revision,
      }));
    }
    assertNoForwardingCycles(result);
    return Object.freeze(result.sort((left, right) => left.source.localeCompare(right.source)));
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.forwardings)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'forwardings'].includes(field))) {
          throw new MailboxForwardingRegistryError('mailbox_forwarding_state_invalid', 'Mailbox forwarding store is invalid', 409);
        }
        const forwardings = parsed.forwardings.map(validatePersisted);
        if (new Set(forwardings.map((record) => record.mailboxId)).size !== forwardings.length) {
          throw new MailboxForwardingRegistryError('mailbox_forwarding_state_invalid', 'Mailbox forwarding identities are not unique', 409);
        }
        await materialize(forwardings);
        state = { version: STORE_VERSION, forwardings };
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
      await materialize(next.forwardings);
      await persist(next);
      state = next;
      return output;
    });
    mutationChain = result.catch(() => {});
    return result;
  }

  async function getForwarding(mailboxId) {
    await ensureInitialized();
    const id = uuid(mailboxId);
    await mailbox(id);
    const record = state.forwardings.find((candidate) => candidate.mailboxId === id);
    return record ? publicPolicy(record) : null;
  }

  async function listForwardings() {
    await ensureInitialized();
    return state.forwardings
      .slice()
      .sort((left, right) => left.mailboxId.localeCompare(right.mailboxId))
      .map(publicPolicy);
  }

  async function setForwarding(mailboxId, {
    expectedRevision,
    mode: requestedMode,
    destinations: requestedDestinations,
    enabled = true,
  } = {}) {
    await ensureInitialized();
    const id = uuid(mailboxId);
    const normalizedMode = mode(requestedMode);
    const normalizedDestinations = destinations(requestedDestinations);
    if (typeof enabled !== 'boolean') {
      throw new MailboxForwardingRegistryError('invalid_mailbox_forwarding_enabled', 'enabled must be a boolean');
    }
    await mailbox(id);
    return mutate(async (next) => {
      const existing = next.forwardings.find((candidate) => candidate.mailboxId === id);
      const expected = revision(expectedRevision, { allowZero: existing == null });
      if (!existing) {
        if (expected !== 0) {
          throw new MailboxForwardingRegistryError(
            'stale_mailbox_forwarding_revision',
            'Mailbox forwarding state changed; refresh and retry',
            409,
          );
        }
        const current = new Date(now()).toISOString();
        const record = {
          mailboxId: id,
          mode: normalizedMode,
          destinations: [...normalizedDestinations],
          enabled,
          revision: 1,
          createdAt: current,
          updatedAt: current,
        };
        next.forwardings.push(record);
        return publicPolicy(record);
      }
      if (existing.revision !== expected) {
        throw new MailboxForwardingRegistryError(
          'stale_mailbox_forwarding_revision',
          'Mailbox forwarding state changed; refresh and retry',
          409,
        );
      }
      const unchanged = existing.mode === normalizedMode && existing.enabled === enabled
        && existing.destinations.length === normalizedDestinations.length
        && existing.destinations.every((value, index) => value === normalizedDestinations[index]);
      if (unchanged) {
        throw new MailboxForwardingRegistryError('mailbox_forwarding_no_change', 'Mailbox forwarding state is unchanged', 409);
      }
      existing.mode = normalizedMode;
      existing.destinations = [...normalizedDestinations];
      existing.enabled = enabled;
      existing.revision += 1;
      existing.updatedAt = new Date(now()).toISOString();
      return publicPolicy(existing);
    });
  }

  async function clearForwarding(mailboxId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const id = uuid(mailboxId);
    const expected = revision(expectedRevision);
    await mailbox(id);
    return mutate(async (next) => {
      const index = next.forwardings.findIndex((candidate) => candidate.mailboxId === id);
      if (index < 0) {
        throw new MailboxForwardingRegistryError('mailbox_forwarding_not_found', 'Mailbox forwarding policy was not found', 404);
      }
      const record = next.forwardings[index];
      if (record.revision !== expected) {
        throw new MailboxForwardingRegistryError(
          'stale_mailbox_forwarding_revision',
          'Mailbox forwarding state changed; refresh and retry',
          409,
        );
      }
      if (confirmation !== `clear-mailbox-forwarding:${id}`) {
        throw new MailboxForwardingRegistryError(
          'mailbox_forwarding_confirmation_mismatch',
          'Mailbox forwarding clear confirmation does not match',
          409,
        );
      }
      next.forwardings.splice(index, 1);
    });
  }

  async function removeOrphan(mailboxId) {
    await ensureInitialized();
    const id = uuid(mailboxId);
    return mutate(async (next) => {
      const index = next.forwardings.findIndex((candidate) => candidate.mailboxId === id);
      if (index < 0) return false;
      let exists = true;
      try { exists = Boolean(await getMailbox(id)); } catch { return false; }
      if (exists) return false;
      next.forwardings.splice(index, 1);
      return true;
    });
  }

  async function materializeEnabledForwardings() {
    await ensureInitialized();
    const result = await materialize(state.forwardings);
    return Object.freeze(result
      .filter((policy) => policy.enabled)
      .map((policy) => Object.freeze({
        mailboxId: policy.mailboxId,
        source: policy.source,
        mode: policy.mode,
        destinations: Object.freeze([...policy.destinations]),
      })));
  }

  return Object.freeze({
    init,
    getForwarding,
    listForwardings,
    setForwarding,
    clearForwarding,
    removeOrphan,
    materializeEnabledForwardings,
  });
}

export const mailboxForwardingRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  maxDestinations: MAX_DESTINATIONS,
  modes: Object.freeze([...MODES]),
  validatePersisted,
  assertNoForwardingCycles,
});
