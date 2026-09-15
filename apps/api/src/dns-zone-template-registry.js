import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const TEMPLATE_SCHEMA_VERSION = 1;
const MAX_VERSIONS = 50;
const ALLOWED_TYPES = new Set(['NS', 'A', 'AAAA', 'CNAME']);
const ALLOWED_CONDITIONS = new Set(['always', 'ipv6']);
const PLACEHOLDERS = Object.freeze([
  '<domain>',
  '<server-ipv4>',
  '<server-ipv6>',
  '<ns1>',
  '<ns2>',
  '<mail-host>',
  '<webmail-host>',
]);
const PLACEHOLDER_SET = new Set(PLACEHOLDERS);
const DEFAULT_RECORDS = Object.freeze([
  Object.freeze({ key: 'apex-ns1', owner: '@', type: 'NS', ttl: null, values: Object.freeze(['<ns1>']), condition: 'always' }),
  Object.freeze({ key: 'apex-ns2', owner: '@', type: 'NS', ttl: null, values: Object.freeze(['<ns2>']), condition: 'always' }),
  Object.freeze({ key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: Object.freeze(['<server-ipv4>']), condition: 'always' }),
  Object.freeze({ key: 'apex-ipv6', owner: '@', type: 'AAAA', ttl: null, values: Object.freeze(['<server-ipv6>']), condition: 'ipv6' }),
  Object.freeze({ key: 'www-alias', owner: 'www', type: 'CNAME', ttl: null, values: Object.freeze(['<domain>']), condition: 'always' }),
]);

export class DnsZoneTemplateRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneTemplateRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value) {
  try { return assertUuid(value, 'serverId'); }
  catch { throw new DnsZoneTemplateRegistryError('invalid_dns_template_server_id', 'DNS template server ID is invalid'); }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new DnsZoneTemplateRegistryError('dns_template_state_invalid', 'DNS template timestamp is invalid', 409);
  }
  return value;
}

function ttl(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 60 || value > 86400) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_ttl', 'DNS template TTL must be null or 60..86400 seconds');
  }
  return value;
}

function recordKey(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,47}$/.test(value)) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_record_key', 'DNS template record key is invalid');
  }
  return value;
}

function owner(value) {
  if (value === '@') return '@';
  if (typeof value !== 'string' || value.length > 190 || !/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value)) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_owner', 'DNS template owner is invalid');
  }
  return value.toLowerCase();
}

function templateValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253 || /[\r\n\u0000]/.test(value)) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_value', 'DNS template record value is invalid');
  }
  const placeholders = value.match(/<[^>]+>/g) ?? [];
  if (placeholders.some((entry) => !PLACEHOLDER_SET.has(entry))) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_placeholder', 'DNS template uses an unsupported placeholder');
  }
  return value;
}

function normalizeRecord(value) {
  const fields = new Set(['key', 'owner', 'type', 'ttl', 'values', 'condition']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.type !== 'string' || !ALLOWED_TYPES.has(value.type.toUpperCase())
    || !ALLOWED_CONDITIONS.has(value.condition)
    || !Array.isArray(value.values) || value.values.length < 1 || value.values.length > 8) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_record', 'DNS template record is invalid');
  }
  const normalized = Object.freeze({
    key: recordKey(value.key),
    owner: owner(value.owner),
    type: value.type.toUpperCase(),
    ttl: ttl(value.ttl),
    values: Object.freeze(value.values.map(templateValue)),
    condition: value.condition,
  });
  if (normalized.type === 'A' && normalized.values.some((entry) => entry !== '<server-ipv4>')) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_record', 'A template records may only use <server-ipv4>');
  }
  if (normalized.type === 'AAAA' && normalized.values.some((entry) => entry !== '<server-ipv6>')) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_record', 'AAAA template records may only use <server-ipv6>');
  }
  if (normalized.type === 'CNAME' && normalized.values.length !== 1) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_record', 'CNAME template records require exactly one value');
  }
  return normalized;
}

function normalizeRecords(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_records', 'DNS template records are invalid');
  }
  const records = value.map(normalizeRecord);
  if (new Set(records.map((entry) => entry.key)).size !== records.length) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_records', 'DNS template record keys must be unique');
  }
  const rrsetKeys = new Set();
  for (const entry of records) {
    const rrset = `${entry.owner}\u0000${entry.type}`;
    if (rrsetKeys.has(rrset)) {
      throw new DnsZoneTemplateRegistryError('invalid_dns_template_records', 'DNS template must define each owner/type RRset once');
    }
    rrsetKeys.add(rrset);
  }
  const cnameOwners = new Set(records.filter((entry) => entry.type === 'CNAME').map((entry) => entry.owner));
  if (records.some((entry) => entry.type !== 'CNAME' && cnameOwners.has(entry.owner))) {
    throw new DnsZoneTemplateRegistryError('invalid_dns_template_records', 'CNAME owner cannot have another template record type');
  }
  return Object.freeze(records);
}

function templateVersion(value) {
  const fields = new Set(['schemaVersion', 'version', 'records', 'createdAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || value.schemaVersion !== TEMPLATE_SCHEMA_VERSION || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new DnsZoneTemplateRegistryError('dns_template_state_invalid', 'Persisted DNS template version is invalid', 409);
  }
  return Object.freeze({
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    version: value.version,
    records: normalizeRecords(value.records),
    createdAt: timestamp(value.createdAt),
  });
}

function persistedServer(value) {
  const fields = new Set(['serverId', 'currentVersion', 'versions', 'updatedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.currentVersion) || value.currentVersion < 1
    || !Array.isArray(value.versions) || value.versions.length < 1 || value.versions.length > MAX_VERSIONS) {
    throw new DnsZoneTemplateRegistryError('dns_template_state_invalid', 'Persisted DNS template server state is invalid', 409);
  }
  const versions = value.versions.map(templateVersion);
  if (new Set(versions.map((entry) => entry.version)).size !== versions.length
    || !versions.some((entry) => entry.version === value.currentVersion)) {
    throw new DnsZoneTemplateRegistryError('dns_template_state_invalid', 'DNS template version history is inconsistent', 409);
  }
  return Object.freeze({
    serverId: uuid(value.serverId),
    currentVersion: value.currentVersion,
    versions: Object.freeze(versions),
    updatedAt: timestamp(value.updatedAt),
  });
}

function digest(serverId, currentVersion, records) {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    serverId,
    currentVersion,
    records,
  })).digest('hex');
}

function publicTemplate(record) {
  if (!record) return null;
  const current = record.versions.find((entry) => entry.version === record.currentVersion);
  return Object.freeze({
    serverId: record.serverId,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    version: current.version,
    records: current.records,
    createdAt: current.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function createDnsZoneTemplateRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
} = {}) {
  if (typeof now !== 'function' || typeof serverExists !== 'function') {
    throw new DnsZoneTemplateRegistryError('dns_template_dependencies_invalid', 'DNS template dependencies are unavailable', 503);
  }
  let state = { version: STORE_VERSION, servers: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.servers)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'servers'].includes(field))) {
          throw new DnsZoneTemplateRegistryError('dns_template_state_invalid', 'DNS template store is invalid', 409);
        }
        const servers = parsed.servers.map(persistedServer);
        if (new Set(servers.map((entry) => entry.serverId)).size !== servers.length) {
          throw new DnsZoneTemplateRegistryError('dns_template_state_invalid', 'DNS template server records are not unique', 409);
        }
        for (const entry of servers) {
          if (!(await serverExists(entry.serverId))) throw new DnsZoneTemplateRegistryError('dns_template_state_invalid', 'DNS template references a missing server', 409);
        }
        state = { version: STORE_VERSION, servers };
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

  async function ensureForServer(serverId) {
    await ensureInitialized();
    const id = uuid(serverId);
    if (!(await serverExists(id))) throw new DnsZoneTemplateRegistryError('dns_template_server_not_found', 'Server was not found', 404);
    let record = state.servers.find((entry) => entry.serverId === id);
    if (!record) {
      const createdAt = new Date(now()).toISOString();
      record = persistedServer({
        serverId: id,
        currentVersion: 1,
        versions: [{ schemaVersion: TEMPLATE_SCHEMA_VERSION, version: 1, records: DEFAULT_RECORDS, createdAt }],
        updatedAt: createdAt,
      });
      state.servers.push(record);
      await persist();
    }
    return publicTemplate(record);
  }

  async function getForServer(serverId) {
    await ensureInitialized();
    const id = uuid(serverId);
    return publicTemplate(state.servers.find((entry) => entry.serverId === id) ?? null);
  }

  async function getVersion(serverId, version) {
    await ensureInitialized();
    const id = uuid(serverId);
    if (!Number.isSafeInteger(version) || version < 1) throw new DnsZoneTemplateRegistryError('invalid_dns_template_version', 'DNS template version is invalid');
    const record = state.servers.find((entry) => entry.serverId === id);
    const found = record?.versions.find((entry) => entry.version === version) ?? null;
    return found ? Object.freeze({ serverId: id, ...found }) : null;
  }

  async function preview({ serverId, expectedVersion, records } = {}) {
    const current = await ensureForServer(serverId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.version) {
      throw new DnsZoneTemplateRegistryError('dns_template_revision_conflict', 'DNS template changed; refresh before preview', 409);
    }
    const normalized = normalizeRecords(records);
    const previewDigest = digest(current.serverId, current.version, normalized);
    return Object.freeze({
      serverId: current.serverId,
      currentVersion: current.version,
      nextVersion: current.version + 1,
      records: normalized,
      previewDigest,
      confirmation: `apply-dns-zone-template:${current.serverId}:${current.version}:${previewDigest}`,
      existingZonesAutomaticApply: false,
    });
  }

  async function update({ serverId, expectedVersion, records, previewDigest, confirmation } = {}) {
    const plan = await preview({ serverId, expectedVersion, records });
    if (previewDigest !== plan.previewDigest || confirmation !== plan.confirmation) {
      throw new DnsZoneTemplateRegistryError('dns_template_confirmation_invalid', 'DNS template preview is stale or confirmation is invalid', 409);
    }
    const index = state.servers.findIndex((entry) => entry.serverId === plan.serverId);
    const current = state.servers[index];
    if (!current || current.currentVersion !== expectedVersion) {
      throw new DnsZoneTemplateRegistryError('dns_template_revision_conflict', 'DNS template changed before apply', 409);
    }
    const createdAt = new Date(now()).toISOString();
    const next = persistedServer({
      serverId: current.serverId,
      currentVersion: plan.nextVersion,
      versions: [...current.versions, {
        schemaVersion: TEMPLATE_SCHEMA_VERSION,
        version: plan.nextVersion,
        records: plan.records,
        createdAt,
      }].slice(-MAX_VERSIONS),
      updatedAt: createdAt,
    });
    state.servers[index] = next;
    await persist();
    return publicTemplate(next);
  }

  return Object.freeze({ init, ensureForServer, getForServer, getVersion, preview, update });
}

export const dnsZoneTemplateInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  schemaVersion: TEMPLATE_SCHEMA_VERSION,
  maxVersions: MAX_VERSIONS,
  placeholders: PLACEHOLDERS,
  defaultRecords: DEFAULT_RECORDS,
  normalizeRecord,
  normalizeRecords,
  digest,
});
