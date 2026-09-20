import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP, SocketAddress } from 'node:net';
import path from 'node:path';
import { assertUuid, normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_SOA = Object.freeze({
  refresh: 3600,
  retry: 900,
  expire: 1209600,
  minimum: 300,
  ttl: 300,
});

export class ServerDnsIdentityRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ServerDnsIdentityRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value) {
  try { return assertUuid(value, 'serverId'); }
  catch { throw new ServerDnsIdentityRegistryError('invalid_dns_server_id', 'DNS server ID is invalid'); }
}

function hostname(value, field) {
  try {
    const normalized = normalizeDomainSet(value, []).primary;
    if (normalized !== value) throw new Error('noncanonical');
    return normalized;
  } catch {
    throw new ServerDnsIdentityRegistryError('invalid_dns_hostname', `${field} must be a canonical DNS hostname`);
  }
}

function ip(value, family, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || isIP(value) !== family) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_address', `${field} must be a valid IPv${family} address`);
  }
  return new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6', port: 0 }).address;
}

function boundedInteger(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_soa_policy', `${field} is outside the supported range`);
  }
  return value;
}

function nameserver(value, field) {
  const allowed = new Set(['hostname', 'ipv4', 'ipv6', 'local']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.local !== 'boolean') {
    throw new ServerDnsIdentityRegistryError('invalid_dns_nameserver', `${field} nameserver settings are invalid`);
  }
  return Object.freeze({
    hostname: hostname(value.hostname, `${field}.hostname`),
    ipv4: ip(value.ipv4, 4, `${field}.ipv4`),
    ipv6: ip(value.ipv6, 6, `${field}.ipv6`, { nullable: true }),
    local: value.local,
  });
}

function soa(value, ns1Hostname) {
  const allowed = new Set(['rname', 'refresh', 'retry', 'expire', 'minimum', 'ttl']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_soa_policy', 'SOA policy is invalid');
  }
  const normalized = Object.freeze({
    primaryNs: ns1Hostname,
    rname: hostname(value.rname, 'soa.rname'),
    refresh: boundedInteger(value.refresh, 'soa.refresh', 300, 86400),
    retry: boundedInteger(value.retry, 'soa.retry', 60, 86400),
    expire: boundedInteger(value.expire, 'soa.expire', 86400, 2_419_200),
    minimum: boundedInteger(value.minimum, 'soa.minimum', 60, 86400),
    ttl: boundedInteger(value.ttl, 'soa.ttl', 60, 86400),
  });
  if (normalized.expire <= normalized.refresh) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_soa_policy', 'SOA expire must be greater than refresh');
  }
  return normalized;
}

function secondaryTargets(value) {
  if (!Array.isArray(value) || value.length > 8) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_secondary_targets', 'secondaryDns must contain at most eight addresses');
  }
  const values = value.map((entry, index) => {
    if (typeof entry !== 'string' || ![4, 6].includes(isIP(entry))) {
      throw new ServerDnsIdentityRegistryError('invalid_dns_secondary_targets', `secondaryDns[${index}] is invalid`);
    }
    const family = isIP(entry);
    return ip(entry, family, `secondaryDns[${index}]`);
  });
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_secondary_targets', 'secondaryDns must not contain duplicates');
  }
  return Object.freeze(unique.sort());
}

function normalizeSettings(value) {
  const allowed = new Set(['publicIpv4', 'publicIpv6', 'ns1', 'ns2', 'soa', 'dnssecDefault', 'secondaryDns']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.dnssecDefault !== 'boolean') {
    throw new ServerDnsIdentityRegistryError('invalid_dns_identity', 'Server DNS identity settings are invalid');
  }
  const ns1 = nameserver(value.ns1, 'ns1');
  const ns2 = nameserver(value.ns2, 'ns2');
  if (!ns1.local) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_nameserver', 'ns1 must be served by the local authoritative DNS service');
  }
  if (ns1.hostname === ns2.hostname) {
    throw new ServerDnsIdentityRegistryError('invalid_dns_nameserver', 'ns1 and ns2 hostnames must be different');
  }
  return Object.freeze({
    publicIpv4: ip(value.publicIpv4, 4, 'publicIpv4'),
    publicIpv6: ip(value.publicIpv6, 6, 'publicIpv6', { nullable: true }),
    ns1,
    ns2,
    soa: soa(value.soa, ns1.hostname),
    dnssecDefault: value.dnssecDefault,
    secondaryDns: secondaryTargets(value.secondaryDns),
  });
}

function warnings(settings) {
  const result = [];
  if (settings.ns2.local && settings.ns1.ipv4 === settings.ns2.ipv4
    && (settings.ns1.ipv6 === settings.ns2.ipv6 || settings.ns1.ipv6 === null || settings.ns2.ipv6 === null)) {
    result.push(Object.freeze({
      code: 'dns_nameserver_redundancy_missing',
      severity: 'warning',
      message: 'ns1 and ns2 resolve to the same local host address; authoritative DNS has no host-level redundancy.',
    }));
  }
  if (settings.ns1.ipv4 !== settings.publicIpv4 && settings.ns1.local) {
    result.push(Object.freeze({
      code: 'dns_primary_ns_address_differs',
      severity: 'warning',
      message: 'Local ns1 IPv4 differs from the configured primary public server IPv4.',
    }));
  }
  if (!settings.ns2.local && settings.secondaryDns.length === 0) {
    result.push(Object.freeze({
      code: 'dns_secondary_transfer_target_missing',
      severity: 'warning',
      message: 'ns2 is external but no explicit secondary DNS transfer target is configured.',
    }));
  }
  return Object.freeze(result);
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ServerDnsIdentityRegistryError('dns_identity_state_invalid', 'Persisted DNS identity timestamp is invalid', 409);
  }
  return value;
}

function persistedRecord(value) {
  const fields = new Set(['serverId', 'revision', 'settings', 'createdAt', 'updatedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new ServerDnsIdentityRegistryError('dns_identity_state_invalid', 'Persisted DNS identity state is invalid', 409);
  }
  if (!value.settings?.soa || value.settings.soa.primaryNs !== value.settings.ns1?.hostname) {
    throw new ServerDnsIdentityRegistryError('dns_identity_state_invalid', 'Persisted DNS primary nameserver is invalid', 409);
  }
  const { primaryNs: _primaryNs, ...soaSettings } = value.settings.soa;
  return Object.freeze({
    serverId: uuid(value.serverId),
    revision: value.revision,
    settings: normalizeSettings({ ...value.settings, soa: soaSettings }),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function publicRecord(record) {
  if (!record) return null;
  return Object.freeze({
    serverId: record.serverId,
    revision: record.revision,
    settings: record.settings,
    warnings: warnings(record.settings),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function digest(serverId, currentRevision, settings) {
  return createHash('sha256').update(JSON.stringify({ version: 1, serverId, currentRevision, settings })).digest('hex');
}

export function createServerDnsIdentityRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
} = {}) {
  if (typeof now !== 'function' || typeof serverExists !== 'function') {
    throw new ServerDnsIdentityRegistryError('dns_identity_dependencies_invalid', 'Server DNS identity dependencies are unavailable', 503);
  }
  let state = { version: STORE_VERSION, records: [] };
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
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.records)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'records'].includes(field))) {
          throw new ServerDnsIdentityRegistryError('dns_identity_state_invalid', 'Server DNS identity store is invalid', 409);
        }
        const records = parsed.records.map(persistedRecord);
        if (new Set(records.map((record) => record.serverId)).size !== records.length) {
          throw new ServerDnsIdentityRegistryError('dns_identity_state_invalid', 'Server DNS identity records are not unique', 409);
        }
        for (const record of records) {
          if (!(await serverExists(record.serverId))) {
            throw new ServerDnsIdentityRegistryError('dns_identity_state_invalid', 'Server DNS identity references a missing server', 409);
          }
        }
        state = { version: STORE_VERSION, records };
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

  async function requireServer(serverId) {
    const id = uuid(serverId);
    if (!(await serverExists(id))) throw new ServerDnsIdentityRegistryError('dns_server_not_found', 'Server was not found', 404);
    return id;
  }

  async function getForServer(serverId) {
    await ensureInitialized();
    const id = uuid(serverId);
    return publicRecord(state.records.find((record) => record.serverId === id) ?? null);
  }

  async function preview({ serverId, settings: requestedSettings } = {}) {
    await ensureInitialized();
    const id = await requireServer(serverId);
    const next = normalizeSettings(requestedSettings);
    const existing = state.records.find((record) => record.serverId === id) ?? null;
    const currentRevision = existing?.revision ?? 0;
    if (existing && JSON.stringify(existing.settings) === JSON.stringify(next)) {
      throw new ServerDnsIdentityRegistryError('dns_identity_no_changes', 'Server DNS identity already matches the requested settings', 409);
    }
    const previewDigest = digest(id, currentRevision, next);
    return Object.freeze({
      version: 1,
      serverId: id,
      currentRevision,
      nextRevision: currentRevision + 1,
      settings: next,
      warnings: warnings(next),
      previewDigest,
      confirmation: `update-server-dns:${id}:${currentRevision}:${previewDigest}`,
      impact: Object.freeze({
        authoritativeDnsRestartRequired: true,
        existingZoneSyncAutomatic: false,
        delegationMayChange: !existing
          || existing.settings.ns1.hostname !== next.ns1.hostname
          || existing.settings.ns2.hostname !== next.ns2.hostname
          || existing.settings.ns1.ipv4 !== next.ns1.ipv4
          || existing.settings.ns2.ipv4 !== next.ns2.ipv4,
      }),
    });
  }

  async function update({ serverId, expectedRevision, settings: requestedSettings, previewDigest, confirmation } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ServerDnsIdentityRegistryError('invalid_dns_identity_revision', 'expectedRevision must be zero or a positive integer');
    }
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new ServerDnsIdentityRegistryError('invalid_dns_identity_digest', 'A current DNS identity preview digest is required');
    }
    const plan = await preview({ serverId, settings: requestedSettings });
    if (plan.currentRevision !== expectedRevision) {
      throw new ServerDnsIdentityRegistryError('dns_identity_revision_conflict', 'Server DNS identity changed after preview', 409);
    }
    if (plan.previewDigest !== previewDigest || confirmation !== plan.confirmation) {
      throw new ServerDnsIdentityRegistryError('dns_identity_preview_stale', 'Server DNS identity preview is stale or confirmation is invalid', 409);
    }
    const timestampValue = new Date(now()).toISOString();
    const index = state.records.findIndex((record) => record.serverId === plan.serverId);
    const record = Object.freeze({
      serverId: plan.serverId,
      revision: plan.nextRevision,
      settings: plan.settings,
      createdAt: index < 0 ? timestampValue : state.records[index].createdAt,
      updatedAt: timestampValue,
    });
    if (index < 0) state.records.push(record);
    else state.records[index] = record;
    await persist();
    return publicRecord(record);
  }

  return Object.freeze({ init, getForServer, preview, update });
}

export const serverDnsIdentityRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultSoa: DEFAULT_SOA,
  normalizeSettings,
  warnings,
  digest,
  persistedRecord,
});
