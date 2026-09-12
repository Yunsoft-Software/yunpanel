import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  managedDkimDnsRecord,
  mailDkimTemplatePolicy,
} from '@yunpanel/config-templates';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const STORE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const PHASE_PREPARED = 'rotation_prepared';
const PHASE_PENDING = 'dns_retirement_pending';
const PHASES = new Set([PHASE_PREPARED, PHASE_PENDING]);

export class MailDkimRetirementRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDkimRetirementRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value) {
  try { return assertUuid(value, 'mailDomainId'); }
  catch { throw new MailDkimRetirementRegistryError('invalid_mail_domain_id', 'mailDomainId is invalid'); }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailDkimRetirementRegistryError(
      'invalid_mail_dkim_retirement_revision',
      'expectedRevision must be a positive integer',
    );
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailDkimRetirementRegistryError('mail_dkim_retirement_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function selector(value) {
  if (typeof value !== 'string' || !mailDkimTemplatePolicy.selectorPattern.test(value)) {
    throw new MailDkimRetirementRegistryError('invalid_mail_dkim_selector', 'DKIM selector is invalid');
  }
  return value;
}

function keyRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailDkimRetirementRegistryError('mail_dkim_retirement_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function canonicalKey(value, code = 'mail_dkim_retirement_key_invalid') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.mailDomainId !== 'string' || typeof value.domainName !== 'string'
    || typeof value.selector !== 'string' || typeof value.publicKey !== 'string'
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new MailDkimRetirementRegistryError(code, 'DKIM key metadata is invalid', 409);
  }
  const id = uuid(value.mailDomainId);
  const normalizedSelector = selector(value.selector);
  let dnsRecord;
  try {
    dnsRecord = managedDkimDnsRecord({
      domain: value.domainName,
      selector: normalizedSelector,
      publicKey: value.publicKey,
    });
  } catch {
    throw new MailDkimRetirementRegistryError(code, 'DKIM key metadata is invalid', 409);
  }
  return Object.freeze({
    mailDomainId: id,
    domainName: value.domainName,
    selector: normalizedSelector,
    publicKey: value.publicKey,
    revision: value.revision,
    dnsRecord,
  });
}

function publicRecord(record) {
  return Object.freeze({
    mailDomainId: record.mailDomainId,
    domainName: record.domainName,
    previousSelector: record.previousSelector,
    previousDnsRecord: managedDkimDnsRecord({
      domain: record.domainName,
      selector: record.previousSelector,
      publicKey: record.previousPublicKey,
    }),
    targetSelector: record.targetSelector,
    previousKeyRevision: record.previousKeyRevision,
    currentKeyRevision: record.currentKeyRevision,
    phase: record.phase,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validatePersisted(record) {
  const fields = new Set([
    'mailDomainId', 'domainName', 'previousSelector', 'previousPublicKey', 'targetSelector',
    'previousKeyRevision', 'currentKeyRevision', 'phase', 'revision', 'createdAt', 'updatedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || !PHASES.has(record.phase) || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MailDkimRetirementRegistryError(
      'mail_dkim_retirement_state_invalid',
      'DKIM retirement state is invalid',
      409,
    );
  }
  const id = uuid(record.mailDomainId);
  const previousSelector = selector(record.previousSelector);
  const targetSelector = selector(record.targetSelector);
  if (previousSelector === targetSelector) {
    throw new MailDkimRetirementRegistryError(
      'mail_dkim_retirement_state_invalid',
      'DKIM retirement selectors must differ',
      409,
    );
  }
  try {
    managedDkimDnsRecord({
      domain: record.domainName,
      selector: previousSelector,
      publicKey: record.previousPublicKey,
    });
  } catch {
    throw new MailDkimRetirementRegistryError(
      'mail_dkim_retirement_state_invalid',
      'DKIM retirement DNS metadata is invalid',
      409,
    );
  }
  const previousKeyRevision = keyRevision(record.previousKeyRevision, 'previousKeyRevision');
  const currentKeyRevision = record.currentKeyRevision === null
    ? null
    : keyRevision(record.currentKeyRevision, 'currentKeyRevision');
  if ((record.phase === PHASE_PREPARED && currentKeyRevision !== null)
    || (record.phase === PHASE_PENDING && currentKeyRevision !== previousKeyRevision + 1)) {
    throw new MailDkimRetirementRegistryError(
      'mail_dkim_retirement_state_invalid',
      'DKIM retirement key revisions are inconsistent',
      409,
    );
  }
  return {
    mailDomainId: id,
    domainName: record.domainName,
    previousSelector,
    previousPublicKey: record.previousPublicKey,
    targetSelector,
    previousKeyRevision,
    currentKeyRevision,
    phase: record.phase,
    revision: record.revision,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
}

export function createMailDkimRetirementRegistry({
  filePath = null,
  now = () => Date.now(),
  getDkimKey = async () => null,
} = {}) {
  if (typeof now !== 'function' || typeof getDkimKey !== 'function'
    || (filePath !== null && (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath))) {
    throw new MailDkimRetirementRegistryError(
      'mail_dkim_retirement_dependencies_invalid',
      'DKIM retirement registry dependencies are invalid',
      503,
    );
  }

  let state = { version: STORE_VERSION, retirements: [] };
  let initialized = false;
  let mutationChain = Promise.resolve();

  async function persist(nextState) {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    await writeFile(temporary, `${JSON.stringify(nextState, null, 2)}\n`, {
      encoding: 'utf8',
      mode: STORE_MODE,
    });
    await rename(temporary, filePath);
    await chmod(filePath, STORE_MODE);
  }

  async function currentKey(mailDomainId) {
    let key;
    try { key = await getDkimKey(mailDomainId); }
    catch {
      throw new MailDkimRetirementRegistryError(
        'mail_dkim_retirement_key_unavailable',
        'Current DKIM key state could not be verified',
        503,
      );
    }
    if (!key) {
      throw new MailDkimRetirementRegistryError(
        'mail_dkim_retirement_key_missing',
        'Current DKIM key state is unavailable',
        409,
      );
    }
    return canonicalKey(key);
  }

  async function reconcileRecord(record) {
    const current = await currentKey(record.mailDomainId);
    if (current.domainName !== record.domainName) {
      throw new MailDkimRetirementRegistryError(
        'mail_dkim_retirement_state_invalid',
        'DKIM retirement domain no longer matches current key state',
        409,
      );
    }
    if (record.phase === PHASE_PREPARED) {
      if (current.revision === record.previousKeyRevision
        && current.selector === record.previousSelector
        && current.publicKey === record.previousPublicKey) {
        return Object.freeze({ action: 'remove', record: null });
      }
      if (current.revision === record.previousKeyRevision + 1 && current.selector === record.targetSelector) {
        const updatedAt = new Date(now()).toISOString();
        return Object.freeze({
          action: 'replace',
          record: {
            ...record,
            phase: PHASE_PENDING,
            currentKeyRevision: current.revision,
            revision: record.revision + 1,
            updatedAt,
          },
        });
      }
      throw new MailDkimRetirementRegistryError(
        'mail_dkim_retirement_state_invalid',
        'Prepared DKIM rotation cannot be reconciled with current key state',
        409,
      );
    }
    if (current.revision !== record.currentKeyRevision || current.selector !== record.targetSelector) {
      throw new MailDkimRetirementRegistryError(
        'mail_dkim_retirement_state_invalid',
        'Pending DKIM retirement no longer matches current key state',
        409,
      );
    }
    return Object.freeze({ action: 'keep', record });
  }

  async function reconcileAll(nextState) {
    const retirements = [];
    let changed = false;
    for (const record of nextState.retirements) {
      const result = await reconcileRecord(record);
      if (result.action === 'remove') {
        changed = true;
        continue;
      }
      if (result.action === 'replace') changed = true;
      retirements.push(result.record);
    }
    if (changed) {
      nextState.retirements = retirements;
      await persist(nextState);
    }
    return changed;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.retirements)
          || Object.keys(parsed).length !== 2
          || Object.keys(parsed).some((field) => !['version', 'retirements'].includes(field))) {
          throw new MailDkimRetirementRegistryError(
            'mail_dkim_retirement_state_invalid',
            'DKIM retirement store is invalid',
            409,
          );
        }
        const retirements = parsed.retirements.map(validatePersisted);
        if (new Set(retirements.map((record) => record.mailDomainId)).size !== retirements.length) {
          throw new MailDkimRetirementRegistryError(
            'mail_dkim_retirement_state_invalid',
            'DKIM retirement identities are not unique',
            409,
          );
        }
        state = { version: STORE_VERSION, retirements };
        await reconcileAll(state);
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

  async function getRetirement(mailDomainId) {
    await ensureInitialized();
    const id = uuid(mailDomainId);
    const existing = state.retirements.find((record) => record.mailDomainId === id);
    if (!existing) return null;
    const next = structuredClone(state);
    const index = next.retirements.findIndex((record) => record.mailDomainId === id);
    const result = await reconcileRecord(next.retirements[index]);
    if (result.action === 'remove') {
      next.retirements.splice(index, 1);
      await persist(next);
      state = next;
      return null;
    }
    if (result.action === 'replace') {
      next.retirements[index] = result.record;
      await persist(next);
      state = next;
      return publicRecord(result.record);
    }
    return publicRecord(existing);
  }

  async function prepareRotation(mailDomainId, { expectedKeyRevision, targetSelector } = {}) {
    await ensureInitialized();
    const id = uuid(mailDomainId);
    const expected = revision(expectedKeyRevision);
    const target = selector(targetSelector);
    const stale = await getRetirement(id);
    if (stale) {
      throw new MailDkimRetirementRegistryError(
        'mail_dkim_retirement_pending',
        'Previous DKIM selector DNS retirement must complete before another rotation',
        409,
      );
    }
    const current = await currentKey(id);
    if (current.revision !== expected) {
      throw new MailDkimRetirementRegistryError(
        'stale_mail_dkim_revision',
        'DKIM key state changed; refresh and retry',
        409,
      );
    }
    if (current.selector === target) {
      throw new MailDkimRetirementRegistryError(
        'mail_dkim_rotation_selector_unchanged',
        'DKIM rotation requires a new selector',
        409,
      );
    }
    return mutate(async (next) => {
      if (next.retirements.some((record) => record.mailDomainId === id)) {
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_retirement_pending',
          'Previous DKIM selector DNS retirement must complete before another rotation',
          409,
        );
      }
      const currentTime = new Date(now()).toISOString();
      const record = {
        mailDomainId: id,
        domainName: current.domainName,
        previousSelector: current.selector,
        previousPublicKey: current.publicKey,
        targetSelector: target,
        previousKeyRevision: current.revision,
        currentKeyRevision: null,
        phase: PHASE_PREPARED,
        revision: 1,
        createdAt: currentTime,
        updatedAt: currentTime,
      };
      next.retirements.push(record);
      return publicRecord(record);
    });
  }

  async function confirmRotation(mailDomainId) {
    await ensureInitialized();
    const id = uuid(mailDomainId);
    return mutate(async (next) => {
      const index = next.retirements.findIndex((record) => record.mailDomainId === id);
      if (index < 0) {
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_retirement_not_found',
          'DKIM rotation retirement state was not found',
          404,
        );
      }
      const result = await reconcileRecord(next.retirements[index]);
      if (result.action === 'remove') {
        next.retirements.splice(index, 1);
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_rotation_not_committed',
          'DKIM rotation did not commit current key state',
          409,
        );
      }
      if (result.action === 'replace') next.retirements[index] = result.record;
      const record = next.retirements[index];
      if (record.phase !== PHASE_PENDING) {
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_rotation_not_committed',
          'DKIM rotation did not commit current key state',
          409,
        );
      }
      return publicRecord(record);
    });
  }

  async function clearRetirement(mailDomainId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const id = uuid(mailDomainId);
    const expected = revision(expectedRevision);
    return mutate(async (next) => {
      const index = next.retirements.findIndex((record) => record.mailDomainId === id);
      if (index < 0) {
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_retirement_not_found',
          'DKIM retirement state was not found',
          404,
        );
      }
      const result = await reconcileRecord(next.retirements[index]);
      if (result.action === 'remove') {
        next.retirements.splice(index, 1);
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_retirement_not_found',
          'DKIM retirement state is no longer pending',
          404,
        );
      }
      if (result.action === 'replace') next.retirements[index] = result.record;
      const record = next.retirements[index];
      if (record.revision !== expected) {
        throw new MailDkimRetirementRegistryError(
          'stale_mail_dkim_retirement_revision',
          'DKIM retirement state changed; refresh and retry',
          409,
        );
      }
      if (record.phase !== PHASE_PENDING) {
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_retirement_not_ready',
          'DKIM retirement state is not ready to clear',
          409,
        );
      }
      const expectedConfirmation = `clear-dkim-retirement:${id}:${record.previousSelector}:${record.revision}`;
      if (confirmation !== expectedConfirmation) {
        throw new MailDkimRetirementRegistryError(
          'mail_dkim_retirement_confirmation_mismatch',
          'DKIM retirement confirmation does not match',
          409,
        );
      }
      const publicValue = publicRecord(record);
      next.retirements.splice(index, 1);
      return publicValue;
    });
  }

  return Object.freeze({
    init,
    getRetirement,
    prepareRotation,
    confirmRotation,
    clearRetirement,
  });
}

export const mailDkimRetirementRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  storeMode: STORE_MODE,
  directoryMode: DIRECTORY_MODE,
  phases: Object.freeze([PHASE_PREPARED, PHASE_PENDING]),
  validatePersisted,
});
