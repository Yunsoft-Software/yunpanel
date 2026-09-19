import { isIP } from 'node:net';
import { DomainValidationError, normalizeDomainName, normalizeDomainSet } from '@yunpanel/shared';

const RECORD_TYPES = new Set(['SOA', 'NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV']);
const SOURCES = new Set(['template', 'mail', 'runtime']);
const MAIL_DISCOVERY_ENDPOINTS = Object.freeze({
  autodiscover: Object.freeze({ prefix: 'autodiscover', path: '/autodiscover/autodiscover.xml' }),
  autoconfig: Object.freeze({ prefix: 'autoconfig', path: '/mail/config-v1.1.xml' }),
});

export class DnsZoneDesiredStateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneDesiredStateError';
    this.code = code;
    this.status = status;
  }
}

function domain(value, field = 'domain') {
  try { return normalizeDomainSet(value, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) {
      throw new DnsZoneDesiredStateError('dns_zone_domain_invalid', `${field} is invalid`);
    }
    throw error;
  }
}

function fqdn(value, field) {
  return domain(String(value ?? '').replace(/\.$/, ''), field);
}

function dnsOwner(value) {
  const normalized = normalizeDomainName(value);
  if (!normalized || normalized.length > 253) {
    throw new DnsZoneDesiredStateError('dns_zone_owner_invalid', 'DNS record owner is invalid');
  }
  const labels = normalized.split('.');
  if (labels[0] === '*') labels.shift();
  if (labels.length < 2 || labels.some((label) => label.length < 1 || label.length > 63
    || !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label))) {
    throw new DnsZoneDesiredStateError('dns_zone_owner_invalid', 'DNS record owner is invalid');
  }
  return normalized;
}

function ownerName(zoneName, owner) {
  if (owner === '@') return zoneName;
  if (typeof owner !== 'string' || !owner) {
    throw new DnsZoneDesiredStateError('dns_zone_owner_invalid', 'DNS record owner is invalid');
  }
  return dnsOwner(`${owner}.${zoneName}`);
}

function uint(value, field, max = 65535) {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) {
    throw new DnsZoneDesiredStateError('dns_zone_record_invalid', `${field} is invalid`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new DnsZoneDesiredStateError('dns_zone_record_invalid', `${field} is invalid`);
  }
  return parsed;
}

function ttl(value, fallback) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 60 || selected > 86400) {
    throw new DnsZoneDesiredStateError('dns_zone_ttl_invalid', 'DNS record TTL must be between 60 and 86400 seconds');
  }
  return selected;
}

function recordValue(type, value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\r\n\u0000]/.test(value)) {
    throw new DnsZoneDesiredStateError('dns_zone_record_invalid', `${type} record value is invalid`);
  }
  const normalized = value.trim();
  if (type === 'A') {
    if (isIP(normalized) !== 4) throw new DnsZoneDesiredStateError('dns_zone_record_invalid', 'A record value is invalid');
    return normalized;
  }
  if (type === 'AAAA') {
    if (isIP(normalized) !== 6) throw new DnsZoneDesiredStateError('dns_zone_record_invalid', 'AAAA record value is invalid');
    return normalized.toLowerCase();
  }
  if (type === 'NS' || type === 'CNAME') return fqdn(normalized, `${type} target`);
  if (type === 'MX') {
    const parts = normalized.split(/\s+/);
    if (parts.length !== 2) throw new DnsZoneDesiredStateError('dns_zone_record_invalid', 'MX record requires priority and target');
    return `${uint(parts[0], 'MX priority')} ${fqdn(parts[1], 'MX target')}`;
  }
  if (type === 'SRV') {
    const parts = normalized.split(/\s+/);
    if (parts.length !== 4) throw new DnsZoneDesiredStateError('dns_zone_record_invalid', 'SRV record requires priority, weight, port and target');
    return `${uint(parts[0], 'SRV priority')} ${uint(parts[1], 'SRV weight')} ${uint(parts[2], 'SRV port')} ${fqdn(parts[3], 'SRV target')}`;
  }
  if (type === 'CAA') {
    const match = normalized.match(/^(\d{1,3})\s+([a-z0-9-]{1,15})\s+(.+)$/i);
    if (!match) throw new DnsZoneDesiredStateError('dns_zone_record_invalid', 'CAA record requires flags, tag and value');
    return `${uint(match[1], 'CAA flags', 255)} ${match[2].toLowerCase()} ${match[3]}`;
  }
  if (type === 'SOA') {
    const parts = normalized.split(/\s+/);
    if (parts.length !== 7) throw new DnsZoneDesiredStateError('dns_zone_record_invalid', 'SOA record value is invalid');
    return `${fqdn(parts[0], 'SOA primary nameserver')} ${fqdn(parts[1], 'SOA responsible mailbox')} ${uint(parts[2], 'SOA serial', 4_294_967_295)} ${uint(parts[3], 'SOA refresh', 2_419_200)} ${uint(parts[4], 'SOA retry', 2_419_200)} ${uint(parts[5], 'SOA expire', 4_294_967_295)} ${uint(parts[6], 'SOA minimum', 2_419_200)}`;
  }
  return normalized;
}

function record({ key, owner, type, ttl: recordTtl, values, source, templateVersion = null }, defaultTtl) {
  const normalizedType = String(type ?? '').toUpperCase();
  if (typeof key !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(key)
    || !RECORD_TYPES.has(normalizedType) || !SOURCES.has(source)
    || !Array.isArray(values) || values.length < 1 || values.length > 16) {
    throw new DnsZoneDesiredStateError('dns_zone_record_invalid', 'DNS managed record is invalid');
  }
  return Object.freeze({
    key,
    owner,
    type: normalizedType,
    ttl: ttl(recordTtl, defaultTtl),
    values: Object.freeze(values.map((value) => recordValue(normalizedType, value))),
    source,
    templateVersion,
  });
}

function placeholderValues({ zoneName, identity, mail }) {
  return Object.freeze({
    '<domain>': zoneName,
    '<server-ipv4>': identity.settings.publicIpv4,
    '<server-ipv6>': identity.settings.publicIpv6,
    '<ns1>': identity.settings.ns1.hostname,
    '<ns2>': identity.settings.ns2.hostname,
    '<mail-host>': mail?.enabled === true ? mail.host : null,
    '<webmail-host>': mail?.webmailEnabled === true ? mail.webmailHost : null,
  });
}

function references(value, placeholder) {
  return typeof value === 'string' && value.includes(placeholder);
}

function templateRecordAvailable(entry, replacements) {
  if (entry.condition === 'ipv6' && !replacements['<server-ipv6>']) return false;
  const values = [entry.owner, ...entry.values];
  if (values.some((value) => references(value, '<mail-host>')) && !replacements['<mail-host>']) return false;
  if (values.some((value) => references(value, '<webmail-host>')) && !replacements['<webmail-host>']) return false;
  return true;
}

function substitute(value, replacements) {
  let result = value;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    if (!result.includes(placeholder)) continue;
    if (replacement === null) {
      throw new DnsZoneDesiredStateError('dns_zone_placeholder_unresolved', `DNS placeholder ${placeholder} is unavailable`);
    }
    result = result.split(placeholder).join(replacement);
  }
  if (/<[^>]+>/.test(result)) {
    throw new DnsZoneDesiredStateError('dns_zone_placeholder_unresolved', 'DNS template contains an unresolved placeholder');
  }
  return result;
}

function templateRecords(zoneName, template, identity, mail) {
  if (!template || template.serverId !== identity.serverId || !Number.isSafeInteger(template.version)
    || template.version < 1 || !Array.isArray(template.records)) {
    throw new DnsZoneDesiredStateError('dns_zone_template_invalid', 'DNS zone template state is invalid', 409);
  }
  const replacements = placeholderValues({ zoneName, identity, mail });
  return template.records
    .filter((entry) => templateRecordAvailable(entry, replacements))
    .map((entry) => record({
      key: entry.key,
      owner: ownerName(zoneName, substitute(entry.owner, replacements)),
      type: entry.type,
      ttl: entry.ttl,
      values: entry.values.map((value) => substitute(value, replacements)),
      source: 'template',
      templateVersion: template.version,
    }, identity.settings.soa.ttl));
}

function soaRecord(zoneName, identity, serial, templateVersion) {
  const soa = identity.settings.soa;
  return record({
    key: 'zone-soa',
    owner: zoneName,
    type: 'SOA',
    ttl: soa.ttl,
    values: [`${soa.primaryNs} ${soa.rname} ${serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minimum}`],
    source: 'template',
    templateVersion,
  }, soa.ttl);
}

function mailDiscoveryRecords(zoneName, identity, discovery) {
  if (discovery === null || discovery === undefined) return [];
  const fields = new Set(['revision', 'autodiscover', 'autoconfig']);
  if (!discovery || typeof discovery !== 'object' || Array.isArray(discovery)
    || Object.keys(discovery).length !== fields.size
    || Object.keys(discovery).some((field) => !fields.has(field))
    || !Number.isSafeInteger(discovery.revision) || discovery.revision < 1) {
    throw new DnsZoneDesiredStateError(
      'dns_zone_mail_discovery_invalid',
      'Mail discovery endpoint readiness is invalid',
      409,
    );
  }
  const result = [];
  for (const [kind, policy] of Object.entries(MAIL_DISCOVERY_ENDPOINTS)) {
    const endpoint = discovery[kind];
    if (endpoint === null) continue;
    const endpointFields = new Set(['hostname', 'protocol', 'path']);
    const dedicatedHostname = `${policy.prefix}.${zoneName}`;
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)
      || Object.keys(endpoint).length !== endpointFields.size
      || Object.keys(endpoint).some((field) => !endpointFields.has(field))
      || ![zoneName, dedicatedHostname].includes(endpoint.hostname)
      || endpoint.protocol !== 'https' || endpoint.path !== policy.path) {
      throw new DnsZoneDesiredStateError(
        'dns_zone_mail_discovery_invalid',
        `${kind} endpoint readiness is invalid`,
        409,
      );
    }
    if (endpoint.hostname === zoneName) continue;
    result.push(record({
      key: `mail-${kind}-ipv4`,
      owner: dedicatedHostname,
      type: 'A',
      ttl: null,
      values: [identity.settings.publicIpv4],
      source: 'mail',
    }, identity.settings.soa.ttl));
    if (identity.settings.publicIpv6) {
      result.push(record({
        key: `mail-${kind}-ipv6`,
        owner: dedicatedHostname,
        type: 'AAAA',
        ttl: null,
        values: [identity.settings.publicIpv6],
        source: 'mail',
      }, identity.settings.soa.ttl));
    }
  }
  return result;
}

function mailRecords(zoneName, identity, mail) {
  if (!mail?.enabled) return [];
  const host = fqdn(mail.host, 'mail host');
  const result = [
    record({ key: 'mail-mx', owner: zoneName, type: 'MX', ttl: null, values: [`10 ${host}`], source: 'mail' }, identity.settings.soa.ttl),
    record({ key: 'mail-spf', owner: zoneName, type: 'TXT', ttl: null, values: [mail.spf ?? 'v=spf1 mx -all'], source: 'mail' }, identity.settings.soa.ttl),
    record({ key: 'mail-dmarc', owner: `_dmarc.${zoneName}`, type: 'TXT', ttl: null, values: [mail.dmarc ?? 'v=DMARC1; p=none'], source: 'mail' }, identity.settings.soa.ttl),
  ];
  const hostAddressOwnedByZone = host === zoneName || host.endsWith(`.${zoneName}`);
  if (hostAddressOwnedByZone && host !== zoneName) {
    result.push(record({ key: 'mail-ipv4', owner: host, type: 'A', ttl: null, values: [identity.settings.publicIpv4], source: 'mail' }, identity.settings.soa.ttl));
    if (identity.settings.publicIpv6) {
      result.push(record({ key: 'mail-ipv6', owner: host, type: 'AAAA', ttl: null, values: [identity.settings.publicIpv6], source: 'mail' }, identity.settings.soa.ttl));
    }
  }
  if (mail.webmailEnabled === true) {
    const webmailHost = fqdn(mail.webmailHost, 'webmail host');
    if (webmailHost !== `webmail.${zoneName}`) {
      throw new DnsZoneDesiredStateError('dns_zone_webmail_host_invalid', 'Local webmail host must be webmail.<domain>');
    }
    result.push(record({ key: 'webmail-ipv4', owner: webmailHost, type: 'A', ttl: null, values: [identity.settings.publicIpv4], source: 'mail' }, identity.settings.soa.ttl));
    if (identity.settings.publicIpv6) {
      result.push(record({ key: 'webmail-ipv6', owner: webmailHost, type: 'AAAA', ttl: null, values: [identity.settings.publicIpv6], source: 'mail' }, identity.settings.soa.ttl));
    }
  }
  if (mail.imaps === true) {
    result.push(record({ key: 'mail-imaps', owner: `_imaps._tcp.${zoneName}`, type: 'SRV', ttl: null, values: [`0 1 993 ${host}`], source: 'mail' }, identity.settings.soa.ttl));
  }
  if (mail.smtps === true) {
    result.push(record({ key: 'mail-submissions', owner: `_submissions._tcp.${zoneName}`, type: 'SRV', ttl: null, values: [`0 1 465 ${host}`], source: 'mail' }, identity.settings.soa.ttl));
  }
  if (mail.imap === true) {
    result.push(record({ key: 'mail-imap', owner: `_imap._tcp.${zoneName}`, type: 'SRV', ttl: null, values: [`0 1 143 ${host}`], source: 'mail' }, identity.settings.soa.ttl));
  }
  if (mail.submission === true) {
    result.push(record({ key: 'mail-submission', owner: `_submission._tcp.${zoneName}`, type: 'SRV', ttl: null, values: [`0 1 587 ${host}`], source: 'mail' }, identity.settings.soa.ttl));
  }
  result.push(...mailDiscoveryRecords(zoneName, identity, mail.discovery));
  const dkimRecords = mail.dkimRecords ?? (mail.dkim ? [mail.dkim] : []);
  if (!Array.isArray(dkimRecords) || dkimRecords.length > 8) {
    throw new DnsZoneDesiredStateError('dns_zone_dkim_invalid', 'DKIM DNS state is invalid');
  }
  const selectors = new Set();
  for (const dkim of dkimRecords) {
    const selector = typeof dkim?.selector === 'string' ? dkim.selector.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(selector) || selectors.has(selector)
      || typeof dkim?.value !== 'string' || !dkim.value.trim()) {
      throw new DnsZoneDesiredStateError('dns_zone_dkim_invalid', 'DKIM DNS state is invalid');
    }
    selectors.add(selector);
    result.push(record({
      key: `mail-dkim-${selector}`,
      owner: `${selector}._domainkey.${zoneName}`,
      type: 'TXT',
      ttl: null,
      values: [dkim.value],
      source: 'mail',
    }, identity.settings.soa.ttl));
  }
  return result;
}

function validateRecordSet(records) {
  const rrsets = new Map();
  for (const entry of records) {
    const rrsetKey = `${entry.owner}\u0000${entry.type}`;
    const existing = rrsets.get(rrsetKey);
    if (existing) {
      throw new DnsZoneDesiredStateError(
        'dns_zone_source_conflict',
        `DNS sources conflict on ${entry.owner} ${entry.type} (${existing.source}/${entry.source})`,
        409,
      );
    }
    rrsets.set(rrsetKey, entry);
  }
  const cnameOwners = new Set(records.filter((entry) => entry.type === 'CNAME').map((entry) => entry.owner));
  if (records.some((entry) => entry.type !== 'CNAME' && cnameOwners.has(entry.owner))) {
    throw new DnsZoneDesiredStateError('dns_zone_cname_conflict', 'CNAME owner cannot coexist with another record type', 409);
  }
  return Object.freeze(records);
}

export function renderDnsZoneDesiredState({
  zoneName,
  template,
  dnsIdentity,
  serial,
  mail = null,
} = {}) {
  const normalizedZone = domain(zoneName, 'zoneName');
  if (!dnsIdentity || typeof dnsIdentity !== 'object' || dnsIdentity.serverId !== template?.serverId
    || !dnsIdentity.settings?.soa || !dnsIdentity.settings?.ns1 || !dnsIdentity.settings?.ns2) {
    throw new DnsZoneDesiredStateError('dns_zone_identity_invalid', 'Server DNS identity is unavailable', 409);
  }
  if (!Number.isSafeInteger(serial) || serial < 1 || serial > 4_294_967_295) {
    throw new DnsZoneDesiredStateError('dns_zone_serial_invalid', 'DNS zone serial is invalid');
  }
  const base = [
    soaRecord(normalizedZone, dnsIdentity, serial, template.version),
    ...templateRecords(normalizedZone, template, dnsIdentity, mail),
    ...mailRecords(normalizedZone, dnsIdentity, mail),
  ];
  const records = validateRecordSet(base);
  return Object.freeze({
    version: 1,
    serverId: dnsIdentity.serverId,
    zoneName: normalizedZone,
    templateVersion: template.version,
    templateSnapshot: Object.freeze(template.records.map((entry) => Object.freeze({
      ...entry,
      values: Object.freeze([...entry.values]),
    }))),
    dnsIdentityRevision: dnsIdentity.revision,
    serial,
    records,
  });
}

export const dnsZoneDesiredStateInternals = Object.freeze({
  domain,
  fqdn,
  dnsOwner,
  ownerName,
  recordValue,
  record,
  templateRecordAvailable,
  substitute,
  templateRecords,
  soaRecord,
  mailDiscoveryRecords,
  mailRecords,
  validateRecordSet,
});
