import path from 'node:path';
import { createDomainRegistry } from './domain-registry.js';
import { createDnsZoneDnssecService, DnsZoneDnssecError } from './dns-zone-dnssec.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createPowerDnsSecretRegistry, PowerDnsSecretRegistryError } from './powerdns-secret-registry.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DnsZoneDnssecHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DnsZoneDnssecHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactObject(value, fields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) {
    throw new DnsZoneDnssecHttpError(code, message);
  }
  return value;
}

function previewBody(body) {
  const value = exactObject(body, new Set(['enabled']), 'dnssec_preview_input_invalid', 'Send only enabled');
  if (typeof value.enabled !== 'boolean') {
    throw new DnsZoneDnssecHttpError('dnssec_preview_input_invalid', 'enabled must be boolean');
  }
  return value;
}

function applyBody(body) {
  const value = exactObject(
    body,
    new Set(['enabled', 'previewDigest', 'confirmation']),
    'dnssec_apply_input_invalid',
    'Send enabled, previewDigest and confirmation',
  );
  if (typeof value.enabled !== 'boolean'
    || typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new DnsZoneDnssecHttpError(
      'dnssec_apply_input_invalid',
      'Send enabled, a current previewDigest and exact confirmation',
    );
  }
  return value;
}

function stateRoot(env = process.env) {
  const serverStorePath = env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
  return path.dirname(serverStorePath);
}

async function defaultService(authoritativeService, env = process.env) {
  if (typeof authoritativeService?.localServerId !== 'string' || !authoritativeService.localServerId) {
    throw new DnsZoneDnssecHttpError('dnssec_local_server_unavailable', 'Local authoritative DNS server scope is unavailable', 503);
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
  return createDnsZoneDnssecService({
    domainRegistry,
    powerDnsSecretRegistry: secretRegistry,
    localServerId: authoritativeService.localServerId,
  });
}

function knownError(error) {
  return error instanceof DnsZoneDnssecHttpError
    || error instanceof DnsZoneDnssecError
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

export function mountDnsZoneDnssecRoutes(app, {
  authoritativeService,
  dnsZoneDnssecService = null,
  env = process.env,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!authoritativeService || typeof authoritativeService.localServerId !== 'string' || !authoritativeService.localServerId) {
    throw new Error('PowerDNS authoritative service is required');
  }
  if (dnsZoneDnssecService !== null
    && (typeof dnsZoneDnssecService.status !== 'function'
      || typeof dnsZoneDnssecService.preview !== 'function'
      || typeof dnsZoneDnssecService.apply !== 'function')) {
    throw new Error('DNSSEC service is invalid');
  }

  let servicePromise = null;
  function service() {
    if (dnsZoneDnssecService) return Promise.resolve(dnsZoneDnssecService);
    if (!servicePromise) {
      servicePromise = defaultService(authoritativeService, env);
      servicePromise.catch(() => { servicePromise = null; });
    }
    return servicePromise;
  }

  app.get('/api/domains/:domainId/dns/dnssec', requirePanelRouteAccess, route(async (request, response) => {
    return response.json({ data: await (await service()).status({ domainId: request.params.domainId }) });
  }));

  app.post('/api/domains/:domainId/dns/dnssec/preview', requirePanelRouteAccess, route(async (request, response) => {
    const body = previewBody(request.body);
    return response.json({
      data: await (await service()).preview({ domainId: request.params.domainId, enabled: body.enabled }),
    });
  }));

  app.post('/api/domains/:domainId/dns/dnssec/apply', requirePanelRouteAccess, route(async (request, response) => {
    const body = applyBody(request.body);
    return response.json({
      data: await (await service()).apply({
        domainId: request.params.domainId,
        enabled: body.enabled,
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      }),
    });
  }));
}

export const dnsZoneDnssecHttpInternals = Object.freeze({
  previewBody,
  applyBody,
  stateRoot,
  defaultService,
  knownError,
  route,
});
