import { createHash } from 'node:crypto';
import { powerDnsTemplatePolicy } from '@yunpanel/config-templates/powerdns';
import { createPowerDnsAuthoritativeReadyManager } from '@yunpanel/host-runtime/powerdns-authoritative-ready-manager';
import { createPublicDnsReachabilityInspector } from './public-dns-reachability-inspector.js';

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

function recoveryConfirmation(serverId, operation) {
  return `inspect-powerdns-recovery:${serverId}:${operation.id}:${operation.updatedAt}`;
}

function retryConfirmation(serverId, operation) {
  return `retry-powerdns-recovery:${serverId}:${operation.id}:${operation.updatedAt}`;
}

function rollbackConfirmation(serverId, operation) {
  return `rollback-powerdns:${serverId}:${operation.id}:${operation.updatedAt}:${operation.rollback.snapshotDigest}`;
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

function blockedPublicReachability(identity, reason = 'powerdns_not_configured') {
  return Object.freeze({
    version: 1,
    status: 'blocked',
    ready: false,
    udp53: null,
    tcp53: null,
    reason,
    vantage: null,
    targets: Object.freeze({
      ipv4: identity?.settings?.publicIpv4 ?? null,
      ipv6: identity?.settings?.publicIpv6 ?? null,
    }),
    checkedAt: null,
  });
}

function unavailablePublicReachability(identity, error) {
  return Object.freeze({
    version: 1,
    status: 'unverifiable',
    ready: false,
    udp53: null,
    tcp53: null,
    reason: typeof error?.code === 'string' && error.code
      ? error.code
      : 'external_vantage_probe_failed',
    vantage: null,
    targets: Object.freeze({
      ipv4: identity?.settings?.publicIpv4 ?? null,
      ipv6: identity?.settings?.publicIpv6 ?? null,
    }),
    checkedAt: null,
  });
}

export function createPowerDnsAuthoritativeService({
  localServerId,
  serverRegistry,
  dnsIdentityRegistry,
  secretRegistry,
  manager = createPowerDnsAuthoritativeReadyManager(),
  publicReachabilityInspector = createPublicDnsReachabilityInspector(),
} = {}) {
  if (typeof localServerId !== 'string' || !localServerId
    || !serverRegistry || typeof serverRegistry.getServer !== 'function'
    || !dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function'
    || !secretRegistry || typeof secretRegistry.getForServer !== 'function'
    || typeof secretRegistry.ensureForServer !== 'function' || typeof secretRegistry.materializeForServer !== 'function'
    || !manager || typeof manager.inspect !== 'function' || typeof manager.apply !== 'function'
    || typeof manager.operation !== 'function' || typeof manager.resolve !== 'function'
    || typeof manager.retry !== 'function' || typeof manager.rollback !== 'function'
    || !publicReachabilityInspector || typeof publicReachabilityInspector.inspect !== 'function') {
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

  async function inspectPublic(serverId, identity) {
    try { return await publicReachabilityInspector.inspect({ serverId, identity }); }
    catch (error) { return unavailablePublicReachability(identity, error); }
  }

  async function currentOperation(serverId) {
    let operation;
    try { operation = await manager.operation(); }
    catch (error) { throw hostFailure(error); }
    if (operation && operation.serverId !== serverId) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_operation_scope_invalid',
        'PowerDNS operation journal belongs to another server identity',
        503,
      );
    }
    if (!operation) return operation;
    let projection = operation;
    if (operation.status === 'applying' && operation.recovery?.required) {
      projection = Object.freeze({
        ...projection,
        recovery: Object.freeze({
          ...operation.recovery,
          confirmation: recoveryConfirmation(serverId, operation),
          retryConfirmation: retryConfirmation(serverId, operation),
        }),
      });
    }
    if (operation.rollback?.available === true) {
      projection = Object.freeze({
        ...projection,
        rollback: Object.freeze({
          ...operation.rollback,
          confirmation: rollbackConfirmation(serverId, operation),
        }),
      });
    }
    return projection;
  }

  async function recoveryContext(serverId, input, confirmationField) {
    const request = input ?? {};
    const identity = await desired(serverId);
    const operation = await currentOperation(serverId);
    if (!operation?.recovery?.required) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_recovery_not_required',
        'PowerDNS authoritative operation does not require recovery',
        409,
      );
    }
    if (request.operationId !== operation.id || request.expectedUpdatedAt !== operation.updatedAt
      || request.confirmation !== operation.recovery[confirmationField]) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_recovery_stale',
        'PowerDNS recovery request is stale or confirmation is invalid',
        409,
      );
    }
    const secret = await secretRegistry.getForServer(serverId);
    if (!secret || secret.revision !== operation.credentialRevision) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_recovery_credential_changed',
        'PowerDNS credential revision changed after the interrupted operation',
        409,
      );
    }
    const materialized = await secretRegistry.materializeForServer(serverId);
    if (materialized.revision !== operation.credentialRevision) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_recovery_credential_changed',
        'PowerDNS credential revision changed after the interrupted operation',
        409,
      );
    }
    return Object.freeze({
      identity,
      materialized,
      recovery: Object.freeze({
        operationId: request.operationId,
        expectedUpdatedAt: request.expectedUpdatedAt,
      }),
    });
  }

  async function rollbackContext(serverId, input) {
    const request = input ?? {};
    const identity = await desired(serverId);
    const operation = await currentOperation(serverId);
    if (!operation?.rollback?.available) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_rollback_not_available',
        'PowerDNS authoritative operation does not have an available rollback snapshot',
        409,
      );
    }
    if (request.operationId !== operation.id || request.expectedUpdatedAt !== operation.updatedAt
      || request.snapshotDigest !== operation.rollback.snapshotDigest
      || request.confirmation !== operation.rollback.confirmation) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_rollback_stale',
        'PowerDNS rollback request is stale or confirmation is invalid',
        409,
      );
    }
    const secret = await secretRegistry.getForServer(serverId);
    if (!secret || secret.revision !== operation.credentialRevision) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_rollback_credential_changed',
        'PowerDNS credential revision changed after the selected apply operation',
        409,
      );
    }
    const materialized = await secretRegistry.materializeForServer(serverId);
    if (materialized.revision !== operation.credentialRevision) {
      throw new PowerDnsAuthoritativeServiceError(
        'powerdns_rollback_credential_changed',
        'PowerDNS credential revision changed after the selected apply operation',
        409,
      );
    }
    return Object.freeze({
      identity,
      materialized,
      recovery: Object.freeze({
        operationId: request.operationId,
        expectedUpdatedAt: request.expectedUpdatedAt,
        snapshotDigest: request.snapshotDigest,
      }),
    });
  }

  async function recoveryResult(serverId, identity, materialized, host, outcomeField, successStatus = 'succeeded') {
    const operation = await currentOperation(serverId);
    const localReady = host?.satisfied === true;
    const publicReachability = localReady
      ? await inspectPublic(serverId, identity)
      : blockedPublicReachability(identity, 'powerdns_local_not_ready');
    const publicReady = publicReachability.ready === true;
    return Object.freeze({
      [outcomeField]: operation?.status === successStatus,
      ready: localReady,
      localReady,
      publicReady,
      overallReady: localReady && publicReady,
      serverId,
      dnsIdentityRevision: identity.revision,
      secretRevision: materialized.revision,
      warnings: identity.warnings,
      host: publicHostState(host),
      publicReachability,
      operation,
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
      readiness: Object.freeze({
        localApi: true,
        localUdp53: true,
        localTcp53: true,
        recursionDenied: true,
        publicUdp53: 'external-vantage-required',
        publicTcp53: 'external-vantage-required',
      }),
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
    const operation = await currentOperation(serverId);
    const secret = await secretRegistry.getForServer(serverId);
    if (!secret) {
      const publicReachability = blockedPublicReachability(identity);
      return Object.freeze({
        configured: false,
        ready: false,
        localReady: false,
        publicReady: false,
        overallReady: false,
        reason: 'powerdns_secret_required',
        serverId,
        dnsIdentityRevision: identity.revision,
        secretConfigured: false,
        warnings: identity.warnings,
        publicReachability,
        operation,
      });
    }
    const materialized = await secretRegistry.materializeForServer(serverId);
    let host;
    try { host = await manager.inspect(intentFor(identity, materialized)); }
    catch (error) { throw hostFailure(error); }
    const localReady = host?.satisfied === true;
    const publicReachability = localReady
      ? await inspectPublic(serverId, identity)
      : blockedPublicReachability(identity, 'powerdns_local_not_ready');
    const publicReady = publicReachability.ready === true;
    return Object.freeze({
      configured: true,
      ready: localReady,
      localReady,
      publicReady,
      overallReady: localReady && publicReady,
      serverId,
      dnsIdentityRevision: identity.revision,
      secretConfigured: true,
      secretRevision: secret.revision,
      warnings: identity.warnings,
      host: publicHostState(host),
      publicReachability,
      operation,
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
    const operation = await currentOperation(serverId);
    const localReady = host?.satisfied === true;
    const publicReachability = localReady
      ? await inspectPublic(serverId, identity)
      : blockedPublicReachability(identity, 'powerdns_local_not_ready');
    const publicReady = publicReachability.ready === true;
    return Object.freeze({
      applied: true,
      ready: localReady,
      localReady,
      publicReady,
      overallReady: localReady && publicReady,
      serverId,
      dnsIdentityRevision: identity.revision,
      secretRevision: materialized.revision,
      warnings: identity.warnings,
      host: publicHostState(host),
      publicReachability,
      operation,
    });
  }

  async function resolve(serverId = localServerId, input = {}) {
    const { identity, materialized, recovery } = await recoveryContext(serverId, input, 'confirmation');
    let host;
    try { host = await manager.resolve(intentFor(identity, materialized), recovery); }
    catch (error) { throw hostFailure(error); }
    return recoveryResult(serverId, identity, materialized, host, 'resolved');
  }

  async function retry(serverId = localServerId, input = {}) {
    const { identity, materialized, recovery } = await recoveryContext(serverId, input, 'retryConfirmation');
    let host;
    try { host = await manager.retry(intentFor(identity, materialized), recovery); }
    catch (error) { throw hostFailure(error); }
    return recoveryResult(serverId, identity, materialized, host, 'retried');
  }

  async function rollback(serverId = localServerId, input = {}) {
    const { identity, materialized, recovery } = await rollbackContext(serverId, input);
    let host;
    try { host = await manager.rollback(intentFor(identity, materialized), recovery); }
    catch (error) { throw hostFailure(error); }
    return recoveryResult(serverId, identity, materialized, host, 'rolledBack', 'rolled_back');
  }

  return Object.freeze({ localServerId, preview, status, apply, resolve, retry, rollback });
}

export const powerDnsAuthoritativeServiceInternals = Object.freeze({
  digest,
  recoveryConfirmation,
  retryConfirmation,
  rollbackConfirmation,
  publicHostState,
  hostFailure,
  blockedPublicReachability,
  unavailablePublicReachability,
});
