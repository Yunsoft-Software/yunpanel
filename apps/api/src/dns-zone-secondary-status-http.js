import path from 'node:path';
import { createDomainRegistry } from './domain-registry.js';
import { createDnsZoneSecondaryStatusService, DnsZoneSecondaryStatusError } from './dns-zone-secondary-status.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createPowerDnsSecretRegistry, PowerDnsSecretRegistryError } from './powerdns-secret-registry.js';

export class DnsZoneSecondaryStatusHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneSecondaryStatusHttpError';
    this.code = code;
    this.status = status;
  }
}

function stateRoot(env = process.env) {
  const serverStorePath = env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
  return path.dirname(serverStorePath);
}

async function defaultService({ dnsIdentityRegistry, authoritativeService, env = process.env } = {}) {
  if (typeof authoritativeService?.localServerId !== 'string' || !authoritativeService.localServerId) {
    throw new DnsZoneSecondaryStatusHttpError(
      'dns_secondary_local_server_unavailable',
      'Local authoritative DNS server scope is unavailable',
      503,
    );
  }
  const domainRegistry = createDomainRegistry({
    filePath: env.YUNPANEL_DOMAIN_STORE ?? path.resolve('.data/domain-registry.json'),
  });
  await domainRegistry.init();
  const secretRegistry = createPowerDnsSecretRegistry({
    filePath: env.YUNPANEL_POWERDNS_SECRET_STORE ?? path.join(stateRoot(env), 'powerdns-secret-registry.json'),
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    serverExists: async (serverId) => serverId === authoritativeService.localServerId,
  });
  await secretRegistry.init();
  return createDnsZoneSecondaryStatusService({
    domainRegistry,
    dnsIdentityRegistry,
    powerDnsSecretRegistry: secretRegistry,
    localServerId: authoritativeService.localServerId,
  });
}

function knownError(error) {
  return error instanceof DnsZoneSecondaryStatusHttpError
    || error instanceof DnsZoneSecondaryStatusError
    || error instanceof PowerDnsSecretRegistryError;
}

function route(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (knownError(error)) {
        return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      return next(error);
    }
  };
}

export function mountDnsZoneSecondaryStatusRoutes(app, {
  dnsIdentityRegistry,
  authoritativeService,
  dnsZoneSecondaryStatusService = null,
  env = process.env,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('Express application is required');
  if (!dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function') {
    throw new Error('Server DNS identity registry is required');
  }
  if (!authoritativeService || typeof authoritativeService.localServerId !== 'string' || !authoritativeService.localServerId) {
    throw new Error('PowerDNS authoritative service is required');
  }
  if (dnsZoneSecondaryStatusService !== null
    && typeof dnsZoneSecondaryStatusService.status !== 'function') {
    throw new Error('Secondary DNS status service is invalid');
  }

  let servicePromise = null;
  function service() {
    if (dnsZoneSecondaryStatusService) return Promise.resolve(dnsZoneSecondaryStatusService);
    if (!servicePromise) {
      servicePromise = defaultService({ dnsIdentityRegistry, authoritativeService, env });
      servicePromise.catch(() => { servicePromise = null; });
    }
    return servicePromise;
  }

  app.get('/api/domains/:domainId/dns/secondary', requirePanelRouteAccess, route(async (request, response) => {
    return response.json({ data: await (await service()).status({ domainId: request.params.domainId }) });
  }));
}

export const dnsZoneSecondaryStatusHttpInternals = Object.freeze({
  stateRoot,
  defaultService,
  knownError,
  route,
});
