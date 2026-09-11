import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const STATES = new Set(['creating_website', 'website_created', 'binding_planned', 'bound', 'rolling_back', 'rolled_back']);

export class WebsiteMigrationLedgerError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMigrationLedgerError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new WebsiteMigrationLedgerError('website_migration_ledger_invalid', `${field} is invalid`, 400); }
}

function digest(value, field) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new WebsiteMigrationLedgerError('website_migration_ledger_invalid', `${field} is invalid`, 400);
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid Website migration ledger state');
  return value;
}

function normalizeEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Website migration ledger state');
  const allowed = new Set([
    'domainId', 'applicationId', 'websiteId', 'createdWebsite', 'sourcePreviewDigest', 'bindingPreviewDigest',
    'state', 'createdAt', 'updatedAt', 'rolledBackAt',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('invalid Website migration ledger state');
  if (typeof value.createdWebsite !== 'boolean' || !STATES.has(value.state)) throw new Error('invalid Website migration ledger state');
  const bindingPreviewDigest = value.bindingPreviewDigest == null ? null : digest(value.bindingPreviewDigest, 'bindingPreviewDigest');
  const rolledBackAt = value.rolledBackAt == null ? null : timestamp(value.rolledBackAt);
  if (value.state === 'rolled_back' && rolledBackAt === null) throw new Error('invalid Website migration ledger state');
  if (value.state !== 'rolled_back' && rolledBackAt !== null) throw new Error('invalid Website migration ledger state');
  if (['binding_planned', 'bound', 'rolling_back', 'rolled_back'].includes(value.state) && bindingPreviewDigest === null) {
    throw new Error('invalid Website migration ledger state');
  }
  return {
    domainId: uuid(value.domainId, 'domainId'),
    applicationId: uuid(value.applicationId, 'applicationId'),
    websiteId: uuid(value.websiteId, 'websiteId'),
    createdWebsite: value.createdWebsite,
    sourcePreviewDigest: digest(value.sourcePreviewDigest, 'sourcePreviewDigest'),
    bindingPreviewDigest,
    state: value.state,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    rolledBackAt,
  };
}

function publicEntry(entry) {
  return Object.freeze({ ...entry });
}

export function createWebsiteMigrationLedger({ filePath = null, now = () => Date.now() } = {}) {
  let state = { version: STORE_VERSION, entries: [] };
  let initialized = filePath === null;
  let writeChain = Promise.resolve();
  if (typeof now !== 'function') throw new WebsiteMigrationLedgerError('website_migration_ledger_dependencies_invalid', 'Website migration ledger dependencies are invalid', 503);

  function nowIso() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new WebsiteMigrationLedgerError('website_migration_ledger_clock_invalid', 'Website migration ledger clock is invalid', 503);
    return new Date(value).toISOString();
  }

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.entries)) throw new Error('invalid Website migration ledger state');
        const entries = parsed.entries.map(normalizeEntry);
        const domains = new Set();
        for (const entry of entries) {
          if (domains.has(entry.domainId)) throw new Error('duplicate Website migration ledger domain');
          domains.add(entry.domainId);
        }
        state = { version: STORE_VERSION, entries };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist();
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function requireEntry(domainId) {
    const normalized = uuid(domainId, 'domainId');
    const entry = state.entries.find((candidate) => candidate.domainId === normalized);
    if (!entry) throw new WebsiteMigrationLedgerError('website_migration_ledger_entry_not_found', 'Website migration ledger entry was not found', 404);
    return entry;
  }

  function assertIdentity(entry, { applicationId, websiteId }) {
    const application = uuid(applicationId, 'applicationId');
    const website = uuid(websiteId, 'websiteId');
    if (entry.applicationId !== application || entry.websiteId !== website) {
      throw new WebsiteMigrationLedgerError('website_migration_ledger_conflict', 'Website migration ledger identity conflicts with current operation');
    }
  }

  async function planWebsiteCreation({ domainId, applicationId, websiteId, sourcePreviewDigest } = {}) {
    await ensureInitialized();
    const domain = uuid(domainId, 'domainId');
    const application = uuid(applicationId, 'applicationId');
    const website = uuid(websiteId, 'websiteId');
    const sourceDigest = digest(sourcePreviewDigest, 'sourcePreviewDigest');
    const existing = state.entries.find((entry) => entry.domainId === domain) ?? null;
    if (existing) {
      assertIdentity(existing, { applicationId: application, websiteId: website });
      if (!existing.createdWebsite || existing.sourcePreviewDigest !== sourceDigest || existing.state === 'rolled_back') {
        throw new WebsiteMigrationLedgerError('website_migration_ledger_conflict', 'Website migration creation conflicts with existing ledger state');
      }
      return publicEntry(existing);
    }
    const time = nowIso();
    const entry = {
      domainId: domain,
      applicationId: application,
      websiteId: website,
      createdWebsite: true,
      sourcePreviewDigest: sourceDigest,
      bindingPreviewDigest: null,
      state: 'creating_website',
      createdAt: time,
      updatedAt: time,
      rolledBackAt: null,
    };
    state.entries.push(entry);
    await persist();
    return publicEntry(entry);
  }

  async function markWebsiteCreated({ domainId, applicationId, websiteId } = {}) {
    await ensureInitialized();
    const entry = requireEntry(domainId);
    assertIdentity(entry, { applicationId, websiteId });
    if (!entry.createdWebsite) throw new WebsiteMigrationLedgerError('website_migration_ledger_transition_invalid', 'Ledger entry did not create this Website');
    if (entry.state === 'website_created' || ['binding_planned', 'bound'].includes(entry.state)) return publicEntry(entry);
    if (entry.state !== 'creating_website') throw new WebsiteMigrationLedgerError('website_migration_ledger_transition_invalid', 'Website creation cannot be recorded from current ledger state');
    entry.state = 'website_created';
    entry.updatedAt = nowIso();
    await persist();
    return publicEntry(entry);
  }

  async function planBinding({ domainId, applicationId, websiteId, previewDigest, createdWebsite = false } = {}) {
    await ensureInitialized();
    const domain = uuid(domainId, 'domainId');
    const application = uuid(applicationId, 'applicationId');
    const website = uuid(websiteId, 'websiteId');
    const bindingDigest = digest(previewDigest, 'previewDigest');
    let entry = state.entries.find((candidate) => candidate.domainId === domain) ?? null;
    if (!entry) {
      const time = nowIso();
      entry = {
        domainId: domain,
        applicationId: application,
        websiteId: website,
        createdWebsite: createdWebsite === true,
        sourcePreviewDigest: bindingDigest,
        bindingPreviewDigest: bindingDigest,
        state: 'binding_planned',
        createdAt: time,
        updatedAt: time,
        rolledBackAt: null,
      };
      state.entries.push(entry);
      await persist();
      return publicEntry(entry);
    }
    assertIdentity(entry, { applicationId: application, websiteId: website });
    if (entry.state === 'bound' && entry.bindingPreviewDigest === bindingDigest) return publicEntry(entry);
    if (entry.state === 'binding_planned' && entry.bindingPreviewDigest === bindingDigest) return publicEntry(entry);
    if (entry.createdWebsite !== (createdWebsite === true) || (entry.createdWebsite && entry.state !== 'website_created')) {
      throw new WebsiteMigrationLedgerError('website_migration_ledger_transition_invalid', 'Website binding cannot be planned from current ledger state');
    }
    entry.bindingPreviewDigest = bindingDigest;
    entry.state = 'binding_planned';
    entry.updatedAt = nowIso();
    await persist();
    return publicEntry(entry);
  }

  async function markBound({ domainId, applicationId, websiteId } = {}) {
    await ensureInitialized();
    const entry = requireEntry(domainId);
    assertIdentity(entry, { applicationId, websiteId });
    if (entry.state === 'bound') return publicEntry(entry);
    if (entry.state !== 'binding_planned') throw new WebsiteMigrationLedgerError('website_migration_ledger_transition_invalid', 'Domain binding cannot be recorded from current ledger state');
    entry.state = 'bound';
    entry.updatedAt = nowIso();
    await persist();
    return publicEntry(entry);
  }

  async function beginRollback({ domainId, websiteId } = {}) {
    await ensureInitialized();
    const entry = requireEntry(domainId);
    if (entry.websiteId !== uuid(websiteId, 'websiteId')) throw new WebsiteMigrationLedgerError('website_migration_ledger_conflict', 'Rollback Website does not match ledger state');
    if (entry.state === 'rolling_back') return publicEntry(entry);
    if (entry.state !== 'bound') throw new WebsiteMigrationLedgerError('website_migration_ledger_transition_invalid', 'Only completed migration bindings can be rolled back');
    entry.state = 'rolling_back';
    entry.updatedAt = nowIso();
    await persist();
    return publicEntry(entry);
  }

  async function markRolledBack({ domainId, websiteId } = {}) {
    await ensureInitialized();
    const entry = requireEntry(domainId);
    if (entry.websiteId !== uuid(websiteId, 'websiteId')) throw new WebsiteMigrationLedgerError('website_migration_ledger_conflict', 'Rollback Website does not match ledger state');
    if (entry.state === 'rolled_back') return publicEntry(entry);
    if (entry.state !== 'rolling_back') throw new WebsiteMigrationLedgerError('website_migration_ledger_transition_invalid', 'Rollback cannot complete from current ledger state');
    const time = nowIso();
    entry.state = 'rolled_back';
    entry.updatedAt = time;
    entry.rolledBackAt = time;
    await persist();
    return publicEntry(entry);
  }

  async function get(domainId) {
    await ensureInitialized();
    const domain = uuid(domainId, 'domainId');
    const entry = state.entries.find((candidate) => candidate.domainId === domain);
    return entry ? publicEntry(entry) : null;
  }

  async function list() {
    await ensureInitialized();
    return state.entries.map(publicEntry);
  }

  return Object.freeze({
    init,
    planWebsiteCreation,
    markWebsiteCreated,
    planBinding,
    markBound,
    beginRollback,
    markRolledBack,
    get,
    list,
  });
}

export const websiteMigrationLedgerInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  digestPattern: DIGEST_PATTERN,
  states: Object.freeze([...STATES]),
  normalizeEntry,
});
