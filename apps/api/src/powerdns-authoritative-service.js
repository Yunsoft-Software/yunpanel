import { createHash } from 'node:crypto';
import { powerDnsTemplatePolicy } from '@yunpanel/config-templates/powerdns';
import { createPowerDnsAuthoritativeReadyManager } from '@yunpanel/host-runtime/powerdns-authoritative-ready-manager';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class PowerDnsAuthoritativeServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PowerDnsAuthoritativeServiceError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicHostState(value) {
  if (!value || typeof value !== 'object') return value;
  const { apiKey: _apiKey, ...safe } = value;
  return Object.freeze(safe);
}

function hostFailure(error) {
  if (error instanceof PowerDnsAuthoritativeServiceError) return error;
  if (typeof error?.code === 'string' && error.code.startsWith('powerdns_')) {
    return new PowerDnsAuthoritativeServiceError(
      error.code,
      typeof error.message === 'string' && error.message ? error.message : 'PowerDNS host operation failed',
      503,
    );
  }
  return error;
}

export function createPowerDnsAuthoritativeService({
  localServerId,
  serverRegistry,
  dnsIdentityRegistry,
  secretRegistry,
  manager = createPowerDnsAuthoritativeReadyManager(),
} = {}) {
  if (typeof localServerId !== 'string' || !localServerId
    || !serverRegistry || typeof serverRegistry.getServer !== 'function'
    || !dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function'
    || !secretRegistry || typeof secretRegistry.getForServer !== 'function'
    || typeof secretRegistry.ensureForServer !== 'function' || typeof secretRegistry.materializeForServer !== 'function'
    || !manager || typeof manager.inspect !== 'function' || typeof manager.apply !== 'function') {
    throw new PowerDnsAuthoritativeServiceError(
      'powerdns_service_dependencies_invalid',
      'PowerDNS authoritative service dependencies are unavailable',
      503,
    );
  }

  async function requireLocalServer(serverId = localServerId) {
    if (serverId !== localServerId) {
      throw new PowerDnsAuthoritativeServiceError('powerdns_local_server_required', 'PowerDNS can be managed only on this panel host', 404);
    }
    const server = await serverRegistry.getServer(serverId);
    if (!server) throw new PowerDnsAuthoritativeServiceError('powerdns_server_not_found', 'Server was not found', 404);
    return server;
  }

  async function desired(serverId = localServerId) {
    await requireLocalServer(serverId);
    const identity = await dnsIdentityRegistry.getForServer(serverId);
    if (!identity) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_dns_identity_required',
        'Configure server DNS identity and ns1/ns2 before applying PowerDNS',
        409,
      );
    }
    return identity;
  }

  function intentFor(identity, secret) {
    return Object.freeze({
      serverId: identity.serverId,
      apiKey: secret.apiKey,
      apiKeyRevision: secret.revision,
      secondaryDns: Object.freeze([...identity.settings.secondaryDns]),
    });
  }

  async function preview(serverId = localServerId) {
    const identity = await desired(serverId);
    const secret = await secretRegistry.getForServer(serverId);
    const secretRevision = secret?.revision ?? 0;
    const payload = Object.freeze({
      version: 1,
      serverId,
      dnsIdentityRevision: identity.revision,
      dnsSettings: identity.settings,
      secretRevision,
      packages: powerDnsTemplatePolicy.packages,
      configPath: powerDnsTemplatePolicy.configPath,
      databasePath: powerDnsTemplatePolicy.databasePath,
      api: Object.freeze({ address: powerDnsTemplatePolicy.apiAddress, port: powerDnsTemplatePolicy.apiPort, public: false }),
      authoritative: true,
      recursive: false,
      readiness: Object.freeze({ api: true, udp53: true, tcp53: true, recursionDenied: true }),
    });
    const previewDigest = digest(payload);
    return Object.freeze({
      ...payload,
      previewDigest,
      confirmation: `apply-powerdns-authoritative:${serverId}:${identity.revision}:${previewDigest}`,
      warnings: identity.warnings,
      impact: Object.freeze({
        installPackages: true,
        initializeSqliteBackend: true,
        writeManagedDropIn: true,
        restartAuthoritativeDns: true,
        existingZoneSyncAutomatic: false,
        createApiSecret: secret === null,
      }),
    });
  }

  async function status(serverId = localServerId) {
    const identity = await desired(serverId);
    const secret = await secretRegistry.getForServer(serverId);
    if (!secret) {
      return Object.freeze({
        configured: false,
        ready: false,
        reason: 'powerdns_secret_required',
        serverId,
        dnsIdentityRevision: identity.revision,
        secretConfigured: false,
        warnings: identity.warnings,
      });
    }
    const materialized = await secretRegistry.materializeForServer(serverId);
    let host;
    try { host = await manager.inspect(intentFor(identity, materialized)); }
    catch (error) { throw hostFailure(error); }
    return Object.freeze({
      configured: true,
      ready: host?.satisfied === true,
      serverId,
      dnsIdentityRevision: identity.revision,
      secretConfigured: true,
      secretRevision: secret.revision,
      warnings: identity.warnings,
      host: publicHostState(host),
    });
  }

  async function apply(serverId = localServerId, { previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new PowerDnsAuthoritativeServiceError('powerdns_preview_digest_invalid', 'A current PowerDNS preview digest is required');
    }
    const plan = await preview(serverId);
    if (plan.previewDigest !== previewDigest || confirmation !== plan.confirmation) {
      throw new PowerDnsAuthoritativeServiceError('powerdns_preview_stale', 'PowerDNS preview is stale or confirmation is invalid', 409);
    }

    await secretRegistry.ensureForServer(serverId);
    const identity = await desired(serverId);
    if (identity.revision !== plan.dnsIdentityRevision) {
      throw new PowerDnsAuthoritativeServiceError('powerdns_dns_identity_changed', 'Server DNS identity changed after preview', 409);
    }
    const materialized = await secretRegistry.materializeForServer(serverId);
    if ((plan.secretRevision !== 0 && materialized.revision !== plan.secretRevision)
      || (plan.secretRevision === 0 && materialized.revision !== 1)) {
      throw new PowerDnsAuthoritativeServiceError('powerdns_secret_changed', 'PowerDNS API secret changed after preview', 409);
    }
    let host;
    try { host = await manager.apply(intentFor(identity, materialized)); }
    catch (error) { throw hostFailure(error); }
    return Object.freeze({
      applied: true,
      ready: host?.satisfied === true,
      serverId,
      dnsIdentityRevision: identity.revision,
      secretRevision: materialized.revision,
      warnings: identity.warnings,
      host: publicHostState(host),
    });
  }

  return Object.freeze({ localServerId, preview, status, apply });
}

export const powerDnsAuthoritativeServiceInternals = Object.freeze({ digest, publicHostState, hostFailure });
