import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP, SocketAddress } from 'node:net';
import { assertUuid, normalizeDomainSet } from '@yunpanel/shared';
import { OPERATIONS } from '@yunpanel/protocol';
import { dnsReadinessInternals } from './dns-readiness.js';

const PROVIDER_SUPPORTED_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TTL = 300;
const DEFAULT_TIMEOUT_MS = 10_000;
const ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND']);

export class DnsRequirementsServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsRequirementsServiceError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameRecord(left, right) {
  if (!left || !right) return false;
  if (left.type !== right.type) return false;
  if (left.name.toLowerCase() !== right.name.toLowerCase()) return false;
  if (left.ttl !== right.ttl || left.proxied !== right.proxied) return false;
  if (left.type === 'A' || left.type === 'AAAA') {
    return left.content.toLowerCase() === right.content.toLowerCase();
  }
  return left.content === right.content;
}

function sameContent(left, right) {
  if (!left || !right) return false;
  if (left.type !== right.type) return false;
  if (left.name.toLowerCase() !== right.name.toLowerCase()) return false;
  if (left.type === 'A' || left.type === 'AAAA') {
    return left.content.toLowerCase() === right.content.toLowerCase();
  }
  return left.content === right.content;
}

function canonicalDomain(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { return null; }
}

async function resolveOptional(resolve, hostname, timeoutMs) {
  let timeout;
  try {
    const result = await Promise.race([
      resolve(hostname),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const err = new Error('DNS resolution timed out');
          err.code = 'ETIMEOUT';
          reject(err);
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    return { records: result ?? [], error: false };
  } catch (error) {
    const code = error?.code;
    if (typeof code === 'string' && ABSENT_CODES.has(code)) {
      return { records: [], error: false };
    }
    return { records: [], error: true };
  } finally {
    clearTimeout(timeout);
  }
}

export function createDnsRequirementsService({
  dnsHostingRegistry,
  domainRegistry,
  serverRegistry,
  dnsProviderCredentialRegistry,
  dnsRecordManager,
  jobRegistry,
  mailDomainRegistry = null,
  mailDkimRegistry = null,
  roundcubeDomainMappingRegistry = null,
  serverDnsIdentityRegistry = null,
  localServerId = null,
  resolve4 = dns.resolve4,
  resolve6 = dns.resolve6,
  resolveCname = dns.resolveCname,
  resolveTxt = dns.resolveTxt,
  resolveMx = dns.resolveMx,
  resolutionTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!dnsHostingRegistry || typeof dnsHostingRegistry.getZone !== 'function'
    || typeof dnsHostingRegistry.listZones !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !serverRegistry || typeof serverRegistry.getServer !== 'function'
    || !dnsProviderCredentialRegistry || typeof dnsProviderCredentialRegistry.getForZone !== 'function'
    || typeof dnsProviderCredentialRegistry.materialize !== 'function'
    || !dnsRecordManager || typeof dnsRecordManager.inspectRecord !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.listJobs !== 'function') {
    throw new DnsRequirementsServiceError('dns_requirements_dependencies_invalid', 'DNS requirements service dependencies are invalid', 503);
  }

  const zoneLocks = new Map();

  async function withZoneLock(dnsZoneId, operation) {
    const previous = zoneLocks.get(dnsZoneId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    zoneLocks.set(dnsZoneId, current);
    await previous.catch(() => {});
    try { return await operation(); }
    finally {
      release();
      if (zoneLocks.get(dnsZoneId) === current) zoneLocks.delete(dnsZoneId);
    }
  }

  async function assertZoneIdle(dnsZoneId) {
    const jobs = await jobRegistry.listJobs({ resourceType: 'dns_zone', resourceId: dnsZoneId });
    if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
      throw new DnsRequirementsServiceError('dns_zone_job_conflict', 'Wait for the active DNS zone operation', 409);
    }
  }

  async function resolveZoneScope(dnsZoneId) {
    const zone = await dnsHostingRegistry.getZone(dnsZoneId);
    if (!zone) {
      throw new DnsRequirementsServiceError('dns_zone_not_found', 'DNS zone was not found', 404);
    }
    if (!zone.webDomainId) {
      throw new DnsRequirementsServiceError('dns_zone_web_domain_required', 'DNS requirements require an explicit web Domain relationship', 409);
    }
    const domain = await domainRegistry.getDomain(zone.webDomainId);
    if (!domain || domain.primaryDomain !== zone.zoneName) {
      throw new DnsRequirementsServiceError('dns_zone_web_domain_mismatch', 'DNS zone web Domain relationship is unavailable', 409);
    }
    if (localServerId !== null && domain.serverId !== localServerId) {
      throw new DnsRequirementsServiceError('local_dns_zone_required', 'DNS requirements can be inspected only for this local Server', 404);
    }
    const server = await serverRegistry.getServer(domain.serverId);
    if (!server) {
      throw new DnsRequirementsServiceError('dns_server_not_found', 'DNS readiness Server was not found', 409);
    }
    const expectedAddrs = dnsReadinessInternals.expectedAddresses(server);
    let publicIpv4 = expectedAddrs.ipv4[0] ?? null;
    let publicIpv6 = expectedAddrs.ipv6[0] ?? null;
    if (!publicIpv4 && serverDnsIdentityRegistry && typeof serverDnsIdentityRegistry.getForServer === 'function') {
      try {
        const identity = await serverDnsIdentityRegistry.getForServer(server.id);
        if (identity?.settings?.publicIpv4) publicIpv4 = identity.settings.publicIpv4;
        if (identity?.settings?.publicIpv6) publicIpv6 = identity.settings.publicIpv6;
      } catch {
        // Fallback gracefully.
      }
    }
    if (!publicIpv4) {
      throw new DnsRequirementsServiceError('dns_expected_address_unavailable', 'The managed Server does not expose a usable public IPv4 address', 409);
    }
    return Object.freeze({
      zone,
      domain,
      server,
      publicIpv4,
      publicIpv6,
    });
  }

  async function resolveMailDomain(domainId, domainName) {
    if (!mailDomainRegistry || typeof mailDomainRegistry.listMailDomains !== 'function') return null;
    const mailDomains = await mailDomainRegistry.listMailDomains();
    return mailDomains.find((m) => m.webDomainId === domainId || m.domainName === domainName) ?? null;
  }

  async function resolveDkimKey(mailDomainId) {
    if (!mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function') return null;
    try { return await mailDkimRegistry.getKey(mailDomainId); }
    catch { return null; }
  }

  async function resolveWebmailActive(mailDomainId, zoneName) {
    if (!roundcubeDomainMappingRegistry) return false;
    try {
      if (typeof roundcubeDomainMappingRegistry.getMapping === 'function') {
        const mapping = await roundcubeDomainMappingRegistry.getMapping(mailDomainId);
        if (mapping && mapping.status !== 'removed') return true;
      }
      if (typeof roundcubeDomainMappingRegistry.listMappings === 'function') {
        const mappings = await roundcubeDomainMappingRegistry.listMappings();
        const expectedHost = `webmail.${zoneName}`;
        if (mappings.some((m) => m.webmailHostname === expectedHost && m.status !== 'removed')) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function generateDesiredRequirements({ zone, domain, publicIpv4, publicIpv6, mailDomain, dkimKey, webmailActive }) {
    const requirements = [];
    const zoneName = zone.zoneName;

    // 1. Apex A record
    requirements.push(Object.freeze({
      key: 'web-apex-a',
      category: 'web',
      description: 'Web routing address (IPv4)',
      required: true,
      providerSupported: true,
      record: Object.freeze({
        type: 'A',
        name: zoneName,
        content: publicIpv4,
        ttl: DEFAULT_TTL,
        proxied: false,
      }),
    }));

    // 2. Apex AAAA record (if IPv6 available)
    if (publicIpv6) {
      requirements.push(Object.freeze({
        key: 'web-apex-aaaa',
        category: 'web',
        description: 'Web routing address (IPv6)',
        required: true,
        providerSupported: true,
        record: Object.freeze({
          type: 'AAAA',
          name: zoneName,
          content: publicIpv6,
          ttl: DEFAULT_TTL,
          proxied: false,
        }),
      }));
    }

    // 3. Domain Aliases (e.g. www.<domain>)
    const aliases = Array.isArray(domain.aliases) ? domain.aliases : [];
    for (const alias of aliases) {
      const canonicalAlias = canonicalDomain(alias);
      if (!canonicalAlias) continue;
      const isSubdomain = canonicalAlias.endsWith(`.${zoneName}`);
      const slug = canonicalAlias.replace(/\./g, '-');
      if (isSubdomain) {
        requirements.push(Object.freeze({
          key: `web-alias-${slug}-cname`,
          category: 'web',
          description: `Web alias routing for ${canonicalAlias} (CNAME)`,
          required: true,
          providerSupported: true,
          record: Object.freeze({
            type: 'CNAME',
            name: canonicalAlias,
            content: zoneName,
            ttl: DEFAULT_TTL,
            proxied: false,
          }),
        }));
      } else {
        requirements.push(Object.freeze({
          key: `web-alias-${slug}-a`,
          category: 'web',
          description: `Web alias routing for ${canonicalAlias} (IPv4)`,
          required: true,
          providerSupported: true,
          record: Object.freeze({
            type: 'A',
            name: canonicalAlias,
            content: publicIpv4,
            ttl: DEFAULT_TTL,
            proxied: false,
          }),
        }));
        if (publicIpv6) {
          requirements.push(Object.freeze({
            key: `web-alias-${slug}-aaaa`,
            category: 'web',
            description: `Web alias routing for ${canonicalAlias} (IPv6)`,
            required: true,
            providerSupported: true,
            record: Object.freeze({
              type: 'AAAA',
              name: canonicalAlias,
              content: publicIpv6,
              ttl: DEFAULT_TTL,
              proxied: false,
            }),
          }));
        }
      }
    }

    // 4. Local Mail Requirements (if mail domain is managed locally)
    if (mailDomain && mailDomain.managementMode === 'local') {
      const mailHost = `mail.${zoneName}`;
      const webmailHost = `webmail.${zoneName}`;

      // MX
      requirements.push(Object.freeze({
        key: 'mail-mx',
        category: 'mail',
        description: 'Mail exchange routing (MX)',
        required: true,
        providerSupported: false,
        record: Object.freeze({
          type: 'MX',
          name: zoneName,
          content: `10 ${mailHost}`,
          ttl: DEFAULT_TTL,
          proxied: false,
        }),
      }));

      // SPF TXT
      requirements.push(Object.freeze({
        key: 'mail-spf',
        category: 'mail',
        description: 'SPF sender authorization',
        required: true,
        providerSupported: true,
        record: Object.freeze({
          type: 'TXT',
          name: zoneName,
          content: 'v=spf1 mx -all',
          ttl: DEFAULT_TTL,
          proxied: false,
        }),
      }));

      // DMARC TXT
      requirements.push(Object.freeze({
        key: 'mail-dmarc',
        category: 'mail',
        description: 'DMARC policy',
        required: true,
        providerSupported: true,
        record: Object.freeze({
          type: 'TXT',
          name: `_dmarc.${zoneName}`,
          content: 'v=DMARC1; p=none',
          ttl: DEFAULT_TTL,
          proxied: false,
        }),
      }));

      // Mail Host A
      requirements.push(Object.freeze({
        key: 'mail-host-a',
        category: 'mail',
        description: 'Mail server hostname (IPv4)',
        required: true,
        providerSupported: true,
        record: Object.freeze({
          type: 'A',
          name: mailHost,
          content: publicIpv4,
          ttl: DEFAULT_TTL,
          proxied: false,
        }),
      }));

      // Mail Host AAAA
      if (publicIpv6) {
        requirements.push(Object.freeze({
          key: 'mail-host-aaaa',
          category: 'mail',
          description: 'Mail server hostname (IPv6)',
          required: true,
          providerSupported: true,
          record: Object.freeze({
            type: 'AAAA',
            name: mailHost,
            content: publicIpv6,
            ttl: DEFAULT_TTL,
            proxied: false,
          }),
        }));
      }

      // Webmail A / AAAA (if webmail active/mapped or local mail configured)
      if (webmailActive || mailDomain.managementMode === 'local') {
        requirements.push(Object.freeze({
          key: 'webmail-a',
          category: 'webmail',
          description: 'Webmail interface (IPv4)',
          required: true,
          providerSupported: true,
          record: Object.freeze({
            type: 'A',
            name: webmailHost,
            content: publicIpv4,
            ttl: DEFAULT_TTL,
            proxied: false,
          }),
        }));
        if (publicIpv6) {
          requirements.push(Object.freeze({
            key: 'webmail-aaaa',
            category: 'webmail',
            description: 'Webmail interface (IPv6)',
            required: true,
            providerSupported: true,
            record: Object.freeze({
              type: 'AAAA',
              name: webmailHost,
              content: publicIpv6,
              ttl: DEFAULT_TTL,
              proxied: false,
            }),
          }));
        }
      }

      // DKIM Key TXT
      if (dkimKey?.selector && dkimKey?.dnsRecord?.value) {
        requirements.push(Object.freeze({
          key: `mail-dkim-${dkimKey.selector}`,
          category: 'dkim',
          description: `DKIM signing key (${dkimKey.selector})`,
          required: true,
          providerSupported: true,
          record: Object.freeze({
            type: 'TXT',
            name: `${dkimKey.selector}._domainkey.${zoneName}`,
            content: dkimKey.dnsRecord.value,
            ttl: DEFAULT_TTL,
            proxied: false,
          }),
        }));
      }
    }

    return requirements;
  }

  async function evaluateRequirementsState({ zone, requirements, credential, secret }) {
    const providerConfigured = Boolean(credential?.configured && credential.provider === 'cloudflare' && secret);
    const evaluated = [];

    if (providerConfigured) {
      for (const req of requirements) {
        if (req.providerSupported) {
          let snapshot;
          try {
            snapshot = await dnsRecordManager.inspectRecord({
              provider: 'cloudflare',
              credentialId: credential.id,
              dnsZoneId: zone.id,
              zoneName: zone.zoneName,
              record: req.record,
            }, { dnsCredential: secret });
          } catch (error) {
            evaluated.push(Object.freeze({
              ...req,
              status: 'pending',
              effect: 'error',
              reason: error.code || 'provider_inspection_failed',
              currentRecords: Object.freeze([]),
              snapshotDigest: null,
            }));
            continue;
          }

          const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
          if (records.length === 1 && sameRecord(records[0], req.record)) {
            evaluated.push(Object.freeze({
              ...req,
              status: 'fulfilled',
              effect: 'no_change',
              reason: null,
              currentRecords: Object.freeze(records),
              snapshotDigest: snapshot.snapshotDigest,
            }));
          } else if (records.length === 0) {
            evaluated.push(Object.freeze({
              ...req,
              status: 'pending',
              effect: 'create',
              reason: 'missing',
              currentRecords: Object.freeze([]),
              snapshotDigest: snapshot.snapshotDigest,
            }));
          } else if (records.length === 1) {
            const matchesContent = sameContent(records[0], req.record);
            evaluated.push(Object.freeze({
              ...req,
              status: matchesContent ? 'fulfilled' : 'pending',
              effect: 'update',
              reason: matchesContent ? null : 'mismatch',
              currentRecords: Object.freeze(records),
              snapshotDigest: snapshot.snapshotDigest,
            }));
          } else {
            evaluated.push(Object.freeze({
              ...req,
              status: 'pending',
              effect: 'conflict',
              reason: 'ambiguous',
              currentRecords: Object.freeze(records),
              snapshotDigest: snapshot.snapshotDigest,
            }));
          }
        } else {
          // Record not supported by provider API (e.g. MX with priority) -> check public DNS
          let publicMatches = false;
          let publicRecords = [];
          if (req.record.type === 'MX' && typeof resolveMx === 'function') {
            const { records, error } = await resolveOptional(resolveMx, req.record.name, resolutionTimeoutMs);
            if (!error && Array.isArray(records)) {
              publicRecords = records;
              const expectedHost = req.record.content.replace(/^10\s+/, '').toLowerCase();
              publicMatches = records.some((entry) => (
                entry && typeof entry.exchange === 'string' && entry.exchange.toLowerCase() === expectedHost
              ));
            }
          }
          evaluated.push(Object.freeze({
            ...req,
            status: publicMatches ? 'fulfilled' : 'pending',
            effect: 'manual',
            reason: publicMatches ? null : 'manual_action_required',
            currentRecords: Object.freeze(publicRecords),
            snapshotDigest: null,
          }));
        }
      }
    } else {
      // No provider configured -> check public DNS resolvers
      for (const req of requirements) {
        let publicMatches = false;
        let publicRecords = [];
        if (req.record.type === 'A' && typeof resolve4 === 'function') {
          const { records, error } = await resolveOptional(resolve4, req.record.name, resolutionTimeoutMs);
          if (!error && Array.isArray(records)) {
            publicRecords = records;
            publicMatches = records.includes(req.record.content);
          }
        } else if (req.record.type === 'AAAA' && typeof resolve6 === 'function') {
          const { records, error } = await resolveOptional(resolve6, req.record.name, resolutionTimeoutMs);
          if (!error && Array.isArray(records)) {
            publicRecords = records;
            publicMatches = records.map((r) => r.toLowerCase()).includes(req.record.content.toLowerCase());
          }
        } else if (req.record.type === 'CNAME' && typeof resolveCname === 'function') {
          const { records, error } = await resolveOptional(resolveCname, req.record.name, resolutionTimeoutMs);
          if (!error && Array.isArray(records)) {
            publicRecords = records;
            publicMatches = records.map((r) => r.toLowerCase()).includes(req.record.content.toLowerCase());
          }
        } else if (req.record.type === 'TXT' && typeof resolveTxt === 'function') {
          const { records, error } = await resolveOptional(resolveTxt, req.record.name, resolutionTimeoutMs);
          if (!error && Array.isArray(records)) {
            const flattened = records.map((entry) => (Array.isArray(entry) ? entry.join('') : String(entry)));
            publicRecords = flattened;
            publicMatches = flattened.includes(req.record.content);
          }
        } else if (req.record.type === 'MX' && typeof resolveMx === 'function') {
          const { records, error } = await resolveOptional(resolveMx, req.record.name, resolutionTimeoutMs);
          if (!error && Array.isArray(records)) {
            publicRecords = records;
            const expectedHost = req.record.content.replace(/^10\s+/, '').toLowerCase();
            publicMatches = records.some((entry) => (
              entry && typeof entry.exchange === 'string' && entry.exchange.toLowerCase() === expectedHost
            ));
          }
        }
        evaluated.push(Object.freeze({
          ...req,
          status: publicMatches ? 'fulfilled' : 'pending',
          effect: 'manual',
          reason: publicMatches ? null : 'unresolved',
          currentRecords: Object.freeze(publicRecords),
          snapshotDigest: null,
        }));
      }
    }

    return evaluated;
  }

  async function inspectZoneRequirements(dnsZoneId) {
    const scope = await resolveZoneScope(dnsZoneId);
    const mailDomain = await resolveMailDomain(scope.domain.id, scope.zone.zoneName);
    const dkimKey = mailDomain ? await resolveDkimKey(mailDomain.id) : null;
    const webmailActive = mailDomain ? await resolveWebmailActive(mailDomain.id, scope.zone.zoneName) : false;

    let credential = null;
    let secret = null;
    try {
      credential = await dnsProviderCredentialRegistry.getForZone(scope.zone.id);
      if (credential?.configured && credential.provider === 'cloudflare') {
        secret = await dnsProviderCredentialRegistry.materialize(credential.id);
      }
    } catch {
      credential = null;
      secret = null;
    }

    const rawRequirements = generateDesiredRequirements({
      zone: scope.zone,
      domain: scope.domain,
      publicIpv4: scope.publicIpv4,
      publicIpv6: scope.publicIpv6,
      mailDomain,
      dkimKey,
      webmailActive,
    });

    const evaluatedRequirements = await evaluateRequirementsState({
      zone: scope.zone,
      requirements: rawRequirements,
      credential,
      secret,
    });

    const total = evaluatedRequirements.length;
    const fulfilled = evaluatedRequirements.filter((r) => r.status === 'fulfilled').length;
    const pending = total - fulfilled;
    const providerConfigured = Boolean(credential?.configured && credential.provider === 'cloudflare' && secret);
    const providerSupportedPending = evaluatedRequirements.filter((r) => r.status === 'pending' && r.providerSupported).length;

    return Object.freeze({
      dnsZoneId: scope.zone.id,
      zoneName: scope.zone.zoneName,
      webDomainId: scope.domain.id,
      zoneRevision: scope.zone.revision,
      provider: providerConfigured ? credential.provider : null,
      providerConfigured,
      ready: pending === 0,
      summary: Object.freeze({
        total,
        fulfilled,
        pending,
        providerSupportedPending,
      }),
      mailDomain: mailDomain ? Object.freeze({
        id: mailDomain.id,
        domainName: mailDomain.domainName,
        managementMode: mailDomain.managementMode,
        status: mailDomain.status,
      }) : null,
      requirements: Object.freeze(evaluatedRequirements),
    });
  }

  async function previewRequirementsApply({ dnsZoneId, expectedRevision, key = null, keys = null } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new DnsRequirementsServiceError('dns_requirements_input_invalid', 'expectedRevision must be a positive integer', 400);
    }
    let targetKeys = keys;
    if (key !== null) {
      if (typeof key !== 'string' || !key) {
        throw new DnsRequirementsServiceError('dns_requirements_input_invalid', 'key must be a non-empty string', 400);
      }
      targetKeys = [key];
    }
    if (targetKeys !== null && (!Array.isArray(targetKeys) || targetKeys.length === 0 || targetKeys.some((k) => typeof k !== 'string' || !k))) {
      throw new DnsRequirementsServiceError('dns_requirements_input_invalid', 'keys must be null or a non-empty array of requirement keys', 400);
    }

    const scope = await resolveZoneScope(dnsZoneId);
    if (scope.zone.revision !== expectedRevision) {
      throw new DnsRequirementsServiceError('dns_zone_revision_conflict', 'DNS zone revision conflict; refresh and retry', 409);
    }
    await assertZoneIdle(scope.zone.id);

    const credential = await dnsProviderCredentialRegistry.getForZone(scope.zone.id);
    if (!credential?.configured || credential.provider !== 'cloudflare') {
      throw new DnsRequirementsServiceError('dns_provider_credential_required', 'A supported DNS provider credential is required', 409);
    }
    const secret = await dnsProviderCredentialRegistry.materialize(credential.id);

    const inspection = await inspectZoneRequirements(scope.zone.id);
    const keySet = targetKeys ? new Set(targetKeys) : null;
    if (keySet) {
      const availableKeys = new Set(inspection.requirements.map((r) => r.key));
      for (const k of keySet) {
        if (!availableKeys.has(k)) {
          throw new DnsRequirementsServiceError('dns_requirement_key_unknown', `Requirement key ${k} is not defined for this zone`, 400);
        }
      }
    }

    const candidates = inspection.requirements.filter((r) => {
      if (!r.providerSupported) return false;
      if (keySet) return keySet.has(r.key);
      return r.status === 'pending';
    });

    const items = candidates.map((req) => Object.freeze({
      key: req.key,
      category: req.category,
      action: 'upsert',
      record: req.record,
      expectedSnapshotDigest: req.snapshotDigest,
      effect: req.effect,
    }));

    const identity = {
      version: 1,
      operation: 'dns_requirements_apply',
      dnsZoneId: scope.zone.id,
      zoneName: scope.zone.zoneName,
      expectedRevision: scope.zone.revision,
      provider: credential.provider,
      credentialId: credential.id,
      credentialUpdatedAt: credential.updatedAt,
      items,
    };
    const previewDigest = digest(identity);
    const confirmation = `apply-dns-requirements:${scope.zone.id}:${previewDigest}`;

    const readyToApply = items.length > 0 && items.every((i) => i.effect !== 'conflict' && i.effect !== 'error');

    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation,
      readyToApply,
      sideEffects: false,
    });
  }

  async function applyRequirements({ dnsZoneId, expectedRevision, previewDigest: rawDigest, confirmation: rawConfirm, key = null, keys = null } = {}) {
    if (typeof rawDigest !== 'string' || !SHA256_PATTERN.test(rawDigest)) {
      throw new DnsRequirementsServiceError('dns_requirements_digest_invalid', 'A valid previewDigest is required', 400);
    }
    if (typeof rawConfirm !== 'string' || !rawConfirm) {
      throw new DnsRequirementsServiceError('dns_requirements_confirmation_required', 'Confirmation string is required', 400);
    }

    return withZoneLock(dnsZoneId, async () => {
      await assertZoneIdle(dnsZoneId);
      const preview = await previewRequirementsApply({ dnsZoneId, expectedRevision, key, keys });

      if (rawDigest !== preview.previewDigest) {
        throw new DnsRequirementsServiceError('dns_requirements_preview_stale', 'DNS requirements changed after preview was prepared', 409);
      }
      if (rawConfirm !== preview.confirmation) {
        throw new DnsRequirementsServiceError('dns_requirements_confirmation_required', `Confirm DNS requirements operation with ${preview.confirmation}`, 400);
      }
      if (!preview.readyToApply) {
        throw new DnsRequirementsServiceError('dns_requirements_not_ready', 'No actionable pending requirements or conflicting provider state', 409);
      }

      const actionableItems = preview.items.filter((item) => item.effect !== 'no_change');
      if (actionableItems.length === 0) {
        throw new DnsRequirementsServiceError('dns_requirements_not_ready', 'No actionable pending requirements or conflicting provider state', 409);
      }
      if (actionableItems.length > 1) {
        throw new DnsRequirementsServiceError('dns_requirements_key_required', 'Apply requires selecting a single requirement key because DNS provider operations are serialized per zone', 400);
      }

      const scope = await resolveZoneScope(dnsZoneId);
      const item = actionableItems[0];
      const job = await jobRegistry.enqueue({
        serverId: scope.domain.serverId,
        type: 'dns.record.apply',
        operation: OPERATIONS.DNS_RECORD_APPLY,
        payload: {
          provider: preview.provider,
          credentialId: preview.credentialId,
          dnsZoneId: preview.dnsZoneId,
          zoneName: preview.zoneName,
          action: item.action,
          record: item.record,
          expectedSnapshotDigest: item.expectedSnapshotDigest,
        },
        resourceType: 'dns_zone',
        resourceId: preview.dnsZoneId,
        idempotencyKey: `dns-req:${preview.dnsZoneId}:${item.key}:${preview.previewDigest}`,
      });

      return Object.freeze({
        previewDigest: preview.previewDigest,
        itemKey: item.key,
        count: 1,
        job,
        jobs: Object.freeze([job]),
      });
    });
  }

  async function inspectDomainRequirements(webDomainId) {
    if (!webDomainId) {
      throw new DnsRequirementsServiceError('invalid_web_domain_id', 'webDomainId is required', 400);
    }
    const domain = await domainRegistry.getDomain(webDomainId);
    if (!domain) {
      throw new DnsRequirementsServiceError('domain_not_found', 'Domain was not found', 404);
    }
    if (localServerId !== null && domain.serverId !== localServerId) {
      throw new DnsRequirementsServiceError('local_domain_required', 'Domain can be inspected only for this local Server', 404);
    }
    const zones = await dnsHostingRegistry.listZones();
    const zone = zones.find((z) => z.webDomainId === domain.id && z.zoneName === domain.primaryDomain) ?? null;
    if (zone) {
      return inspectZoneRequirements(zone.id);
    }

    // No tracked external DNS zone yet: compute domain requirements via public DNS
    const server = await serverRegistry.getServer(domain.serverId);
    if (!server) {
      throw new DnsRequirementsServiceError('dns_server_not_found', 'Server was not found', 409);
    }
    const expectedAddrs = dnsReadinessInternals.expectedAddresses(server);
    let publicIpv4 = expectedAddrs.ipv4[0] ?? null;
    let publicIpv6 = expectedAddrs.ipv6[0] ?? null;
    if (!publicIpv4 && serverDnsIdentityRegistry && typeof serverDnsIdentityRegistry.getForServer === 'function') {
      try {
        const identity = await serverDnsIdentityRegistry.getForServer(server.id);
        if (identity?.settings?.publicIpv4) publicIpv4 = identity.settings.publicIpv4;
        if (identity?.settings?.publicIpv6) publicIpv6 = identity.settings.publicIpv6;
      } catch {
        // Fallback gracefully.
      }
    }
    if (!publicIpv4) {
      throw new DnsRequirementsServiceError('dns_expected_address_unavailable', 'The managed Server does not expose a usable public IPv4 address', 409);
    }

    const syntheticZone = { id: null, zoneName: domain.primaryDomain, revision: 1 };
    const mailDomain = await resolveMailDomain(domain.id, domain.primaryDomain);
    const dkimKey = mailDomain ? await resolveDkimKey(mailDomain.id) : null;
    const webmailActive = mailDomain ? await resolveWebmailActive(mailDomain.id, domain.primaryDomain) : false;

    const rawRequirements = generateDesiredRequirements({
      zone: syntheticZone,
      domain,
      publicIpv4,
      publicIpv6,
      mailDomain,
      dkimKey,
      webmailActive,
    });

    const evaluatedRequirements = await evaluateRequirementsState({
      zone: syntheticZone,
      requirements: rawRequirements,
      credential: null,
      secret: null,
    });

    const total = evaluatedRequirements.length;
    const fulfilled = evaluatedRequirements.filter((r) => r.status === 'fulfilled').length;
    const pending = total - fulfilled;

    return Object.freeze({
      dnsZoneId: null,
      zoneName: domain.primaryDomain,
      webDomainId: domain.id,
      zoneRevision: null,
      provider: null,
      providerConfigured: false,
      ready: pending === 0,
      summary: Object.freeze({
        total,
        fulfilled,
        pending,
        providerSupportedPending: 0,
      }),
      mailDomain: mailDomain ? Object.freeze({
        id: mailDomain.id,
        domainName: mailDomain.domainName,
        managementMode: mailDomain.managementMode,
        status: mailDomain.status,
      }) : null,
      requirements: Object.freeze(evaluatedRequirements),
    });
  }

  return Object.freeze({
    inspectZoneRequirements,
    previewRequirementsApply,
    applyRequirements,
    inspectDomainRequirements,
  });
}

export const dnsRequirementsInternals = Object.freeze({
  PROVIDER_SUPPORTED_TYPES,
  DEFAULT_TTL,
  sameRecord,
  sameContent,
  digest,
});
