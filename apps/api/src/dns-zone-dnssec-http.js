import path from 'node:path';
import { createDomainRegistry } from './domain-registry.js';
import {
  createDnsZoneDnssecOperationRegistry,
  DnsZoneDnssecOperationRegistryError,
} from './dns-zone-dnssec-operation-registry.js';
import {
  createDnsZoneDnssecRolloverRegistry,
  DnsZoneDnssecRolloverRegistryError,
} from './dns-zone-dnssec-rollover-registry.js';
import {
  createDnsZoneDnssecRolloverRuntime,
  DnsZoneDnssecRolloverRuntimeError,
} from './dns-zone-dnssec-rollover-runtime.js';
import { createDnsZoneDnssecRuntime, DnsZoneDnssecRuntimeError } from './dns-zone-dnssec-runtime.js';
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

function rolloverApplyBody(body) {
  const value = exactObject(
    body,
    new Set(['previewDigest', 'confirmation']),
    'dnssec_rollover_apply_input_invalid',
    'Send previewDigest and confirmation',
  );
  if (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new DnsZoneDnssecHttpError(
      'dnssec_rollover_apply_input_invalid',
      'Send a current previewDigest and exact confirmation',
    );
  }
  return value;
}

function stateRoot(env = process.env) {
  const serverStorePath = env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
  return path.dirname(serverStorePath);
}

function operationStorePath(env = process.env) {
  return env.YUNPANEL_DNSSEC_OPERATION_STORE ?? path.join(stateRoot(env), 'dnssec-operations.json');
}

function rolloverOperationStorePath(env = process.env) {
  return env.YUNPANEL_DNSSEC_ROLLOVER_OPERATION_STORE ?? path.join(stateRoot(env), 'dnssec-rollover-operations.json');
}

async function defaultService(authoritativeService, dnsIdentityRegistry, env = process.env) {
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
    dnsIdentityRegistry,
  });
}

async function defaultRuntime(authoritativeService, dnsIdentityRegistry, env = process.env, serviceOverride = null) {
  const service = serviceOverride ?? await defaultService(authoritativeService, dnsIdentityRegistry, env);
  const registry = createDnsZoneDnssecOperationRegistry({
    filePath: serviceOverride ? null : operationStorePath(env),
  });
  const runtime = createDnsZoneDnssecRuntime({ registry, service });
  const rolloverRegistry = createDnsZoneDnssecRolloverRegistry({
    filePath: serviceOverride ? null : rolloverOperationStorePath(env),
  });
  const rolloverRuntime = createDnsZoneDnssecRolloverRuntime({ registry: rolloverRegistry, service });
  await runtime.init();
  await rolloverRuntime.init();
  return Object.freeze({
    ...runtime,
    startRollover: rolloverRuntime.start,
    getRollover: rolloverRuntime.get,
    listRolloversForDomain: rolloverRuntime.listForDomain,
  });
}

function knownError(error) {
  return error instanceof DnsZoneDnssecHttpError
    || error instanceof DnsZoneDnssecError
    || error instanceof DnsZoneDnssecRuntimeError
    || error instanceof DnsZoneDnssecOperationRegistryError
    || error instanceof DnsZoneDnssecRolloverRuntimeError
    || error instanceof DnsZoneDnssecRolloverRegistryError
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
  dnsIdentityRegistry = null,
  dnsZoneDnssecRuntime = null,
  dnsZoneDnssecService = null,
  env = process.env,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!authoritativeService || typeof authoritativeService.localServerId !== 'string' || !authoritativeService.localServerId) {
    throw new Error('PowerDNS authoritative service is required');
  }
  if (dnsZoneDnssecRuntime !== null && dnsZoneDnssecService !== null) {
    throw new Error('Configure either DNSSEC runtime or service, not both');
  }
  if (dnsZoneDnssecRuntime === null && dnsZoneDnssecService === null
    && (!dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function')) {
    throw new Error('Server DNS identity registry is required');
  }
  if (dnsZoneDnssecRuntime !== null
    && (typeof dnsZoneDnssecRuntime.status !== 'function' || typeof dnsZoneDnssecRuntime.preview !== 'function'
      || typeof dnsZoneDnssecRuntime.previewRollover !== 'function'
      || typeof dnsZoneDnssecRuntime.start !== 'function' || typeof dnsZoneDnssecRuntime.get !== 'function'
      || typeof dnsZoneDnssecRuntime.listForDomain !== 'function'
      || typeof dnsZoneDnssecRuntime.startRollover !== 'function' || typeof dnsZoneDnssecRuntime.getRollover !== 'function'
      || typeof dnsZoneDnssecRuntime.listRolloversForDomain !== 'function')) {
    throw new Error('DNSSEC runtime is invalid');
  }
  if (dnsZoneDnssecService !== null
    && (typeof dnsZoneDnssecService.status !== 'function'
      || typeof dnsZoneDnssecService.preview !== 'function'
      || typeof dnsZoneDnssecService.previewRollover !== 'function'
      || typeof dnsZoneDnssecService.createRolloverKey !== 'function'
      || typeof dnsZoneDnssecService.previewRolloverKeyState !== 'function'
      || typeof dnsZoneDnssecService.setRolloverKeyState !== 'function'
      || typeof dnsZoneDnssecService.inspectRolloverPropagation !== 'function'
      || typeof dnsZoneDnssecService.apply !== 'function')) {
    throw new Error('DNSSEC service is invalid');
  }

  let runtimePromise = null;
  function runtime() {
    if (dnsZoneDnssecRuntime) return Promise.resolve(dnsZoneDnssecRuntime);
    if (!runtimePromise) {
      runtimePromise = defaultRuntime(authoritativeService, dnsIdentityRegistry, env, dnsZoneDnssecService);
      runtimePromise.catch(() => { runtimePromise = null; });
    }
    return runtimePromise;
  }
  if (!dnsZoneDnssecRuntime) void runtime();

  app.get('/api/domains/:domainId/dns/dnssec', requirePanelRouteAccess, route(async (request, response) => {
    return response.json({ data: await (await runtime()).status({ domainId: request.params.domainId }) });
  }));

  app.post('/api/domains/:domainId/dns/dnssec/preview', requirePanelRouteAccess, route(async (request, response) => {
    const body = previewBody(request.body);
    return response.json({
      data: await (await runtime()).preview({ domainId: request.params.domainId, enabled: body.enabled }),
    });
  }));

  app.get('/api/domains/:domainId/dns/dnssec/rollover/preview', requirePanelRouteAccess, route(async (request, response) => {
    return response.json({
      data: await (await runtime()).previewRollover({ domainId: request.params.domainId }),
    });
  }));

  app.post('/api/domains/:domainId/dns/dnssec/rollover/apply', requirePanelRouteAccess, route(async (request, response) => {
    const body = rolloverApplyBody(request.body);
    return response.status(202).json({
      data: await (await runtime()).startRollover({
        domainId: request.params.domainId,
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      }),
    });
  }));

  app.get('/api/domains/:domainId/dns/dnssec/rollover/operations', requirePanelRouteAccess, route(async (request, response) => {
    return response.json({ data: await (await runtime()).listRolloversForDomain(request.params.domainId) });
  }));

  app.get('/api/domains/:domainId/dns/dnssec/rollover/operations/:operationId', requirePanelRouteAccess, route(async (request, response) => {
    const operation = await (await runtime()).getRollover(request.params.operationId);
    if (!operation || operation.domainId !== request.params.domainId) {
      throw new DnsZoneDnssecHttpError('dnssec_rollover_operation_not_found', 'DNSSEC rollover operation was not found', 404);
    }
    return response.json({ data: operation });
  }));

  app.post('/api/domains/:domainId/dns/dnssec/apply', requirePanelRouteAccess, route(async (request, response) => {
    const body = applyBody(request.body);
    return response.json({
      data: await (await runtime()).start({
        domainId: request.params.domainId,
        enabled: body.enabled,
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      }),
    });
  }));

  app.get('/api/domains/:domainId/dns/dnssec/operations', requirePanelRouteAccess, route(async (request, response) => {
    return response.json({ data: await (await runtime()).listForDomain(request.params.domainId) });
  }));

  app.get('/api/domains/:domainId/dns/dnssec/operations/:operationId', requirePanelRouteAccess, route(async (request, response) => {
    const operation = await (await runtime()).get(request.params.operationId);
    if (!operation || operation.domainId !== request.params.domainId) {
      throw new DnsZoneDnssecHttpError('dnssec_operation_not_found', 'DNSSEC operation was not found', 404);
    }
    return response.json({ data: operation });
  }));
}

export const dnsZoneDnssecHttpInternals = Object.freeze({
  previewBody,
  applyBody,
  rolloverApplyBody,
  stateRoot,
  operationStorePath,
  rolloverOperationStorePath,
  defaultService,
  defaultRuntime,
  knownError,
  route,
});
