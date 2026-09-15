import {
  createPowerDnsManualRrsetManager,
  PowerDnsManualRrsetManagerError,
} from '@yunpanel/host-runtime/powerdns-manual-rrset-manager';
import { dnsZoneDesiredStateInternals, DnsZoneDesiredStateError } from './dns-zone-desired-state.js';

const SUPPORTED_TYPES = new Set(['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV']);

export class DnsZoneRecordsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneRecordsError';
    this.code = code;
    this.status = status;
  }
}

function rootDomain(domain, localServerId) {
  if (!domain) throw new DnsZoneRecordsError('domain_not_found', 'Domain not found', 404);
  if (typeof domain !== 'object' || typeof domain.id !== 'string'
    || typeof domain.serverId !== 'string' || typeof domain.primaryDomain !== 'string') {
    throw new DnsZoneRecordsError('dns_zone_domain_invalid', 'Domain state is invalid', 409);
  }
  if (domain.serverId !== localServerId) {
    throw new DnsZoneRecordsError('dns_zone_local_server_required', 'Local DNS records can be managed only on this panel host', 404);
  }
  if ((domain.parentDomainId ?? null) !== null) {
    throw new DnsZoneRecordsError('dns_zone_root_domain_required', 'Only root Domains own authoritative DNS zones', 409);
  }
  return domain;
}

function ttl(value) {
  if (!Number.isSafeInteger(value) || value < 60 || value > 86400) {
    throw new DnsZoneRecordsError('dns_zone_record_ttl_invalid', 'DNS record TTL must be between 60 and 86400 seconds');
  }
  return value;
}

function expectedSerial(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new DnsZoneRecordsError('dns_zone_expected_serial_invalid', 'A current authoritative SOA serial is required');
  }
  return value;
}

function recordType(value) {
  const type = String(value ?? '').toUpperCase();
  if (!SUPPORTED_TYPES.has(type)) throw new DnsZoneRecordsError('dns_zone_record_type_invalid', 'DNS record type is invalid');
  return type;
}

function recordOwner(zoneName, value) {
  if (value === '@') return zoneName;
  if (typeof value !== 'string' || !value.trim()) {
    throw new DnsZoneRecordsError('dns_zone_record_owner_invalid', 'DNS record owner is required');
  }
  const raw = value.trim().replace(/\.$/, '');
  try {
    const candidate = dnsZoneDesiredStateInternals.dnsOwner(raw);
    if (candidate === zoneName || candidate.endsWith(`.${zoneName}`)) return candidate;
  } catch {
    // Relative owners such as "www" and "_submission._tcp" are resolved below.
  }
  try { return dnsZoneDesiredStateInternals.ownerName(zoneName, raw); }
  catch (error) {
    if (error instanceof DnsZoneDesiredStateError) {
      throw new DnsZoneRecordsError('dns_zone_record_owner_invalid', error.message, error.status);
    }
    throw error;
  }
}

function recordValues(type, values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16
    || ((type === 'CNAME' || type === 'SOA') && values.length !== 1)) {
    throw new DnsZoneRecordsError('dns_zone_record_values_invalid', `${type} record values are invalid`);
  }
  try {
    return Object.freeze(values.map((value) => dnsZoneDesiredStateInternals.recordValue(type, value)));
  } catch (error) {
    if (error instanceof DnsZoneDesiredStateError) {
      throw new DnsZoneRecordsError(error.code, error.message, error.status);
    }
    throw error;
  }
}

function normalizeRecord(zoneName, input) {
  const fields = new Set(['owner', 'type', 'ttl', 'values', 'expectedSerial']);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.size || Object.keys(input).some((field) => !fields.has(field))) {
    throw new DnsZoneRecordsError(
      'dns_zone_record_input_invalid',
      'Send owner, type, ttl, values and expectedSerial',
    );
  }
  const type = recordType(input.type);
  return Object.freeze({
    expectedSerial: expectedSerial(input.expectedSerial),
    record: Object.freeze({
      owner: recordOwner(zoneName, input.owner),
      type,
      ttl: ttl(input.ttl),
      values: recordValues(type, input.values),
    }),
  });
}

function normalizeDelete(zoneName, input) {
  const fields = new Set(['owner', 'type', 'expectedSerial']);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.size || Object.keys(input).some((field) => !fields.has(field))) {
    throw new DnsZoneRecordsError('dns_zone_record_delete_input_invalid', 'Send owner, type and expectedSerial');
  }
  return Object.freeze({
    owner: recordOwner(zoneName, input.owner),
    type: recordType(input.type),
    expectedSerial: expectedSerial(input.expectedSerial),
  });
}

async function mapped(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneRecordsError) throw error;
    if (error instanceof PowerDnsManualRrsetManagerError) {
      throw new DnsZoneRecordsError(error.code, error.message, error.status);
    }
    if (typeof error?.code === 'string' && Number.isInteger(error?.status)) {
      throw new DnsZoneRecordsError(error.code, error.message ?? 'DNS record operation failed', error.status);
    }
    throw error;
  }
}

export function createDnsZoneRecordsService({
  domainRegistry,
  powerDnsSecretRegistry,
  localServerId,
  manager = createPowerDnsManualRrsetManager(),
} = {}) {
  if (!domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !powerDnsSecretRegistry || typeof powerDnsSecretRegistry.materializeForServer !== 'function'
    || typeof localServerId !== 'string' || !localServerId
    || !manager || typeof manager.getZone !== 'function' || typeof manager.apply !== 'function' || typeof manager.remove !== 'function') {
    throw new DnsZoneRecordsError('dns_zone_records_dependencies_invalid', 'DNS zone record dependencies are unavailable', 503);
  }

  async function context(domainId) {
    if (typeof domainId !== 'string' || !domainId) throw new DnsZoneRecordsError('dns_zone_domain_id_invalid', 'Domain ID is required');
    const domain = rootDomain(await mapped(() => domainRegistry.getDomain(domainId)), localServerId);
    const secret = await mapped(() => powerDnsSecretRegistry.materializeForServer(domain.serverId));
    return Object.freeze({ domain, apiKey: secret.apiKey });
  }

  async function getZone({ domainId } = {}) {
    const { domain, apiKey } = await context(domainId);
    const zone = await mapped(() => manager.getZone({ zoneName: domain.primaryDomain, apiKey }));
    if (!zone) throw new DnsZoneRecordsError('dns_zone_not_found', 'Local authoritative DNS zone was not found', 404);
    return Object.freeze({
      domainId: domain.id,
      serverId: domain.serverId,
      ...zone,
    });
  }

  async function apply({ domainId, input } = {}) {
    const { domain, apiKey } = await context(domainId);
    const normalized = normalizeRecord(domain.primaryDomain, input);
    const result = await mapped(() => manager.apply({
      zoneName: domain.primaryDomain,
      apiKey,
      expectedSerial: normalized.expectedSerial,
      record: normalized.record,
    }));
    return Object.freeze({ domainId: domain.id, serverId: domain.serverId, ...result });
  }

  async function remove({ domainId, input } = {}) {
    const { domain, apiKey } = await context(domainId);
    const normalized = normalizeDelete(domain.primaryDomain, input);
    const result = await mapped(() => manager.remove({
      zoneName: domain.primaryDomain,
      apiKey,
      ...normalized,
    }));
    return Object.freeze({ domainId: domain.id, serverId: domain.serverId, ...result });
  }

  return Object.freeze({ getZone, apply, remove });
}

export const dnsZoneRecordsInternals = Object.freeze({
  supportedTypes: Object.freeze([...SUPPORTED_TYPES]),
  rootDomain,
  ttl,
  expectedSerial,
  recordType,
  recordOwner,
  recordValues,
  normalizeRecord,
  normalizeDelete,
});
