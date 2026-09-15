import path from 'node:path';
import { createDnsDelegationInspector, DnsDelegationInspectorError } from './dns-delegation-inspector.js';
import { createDnsZoneReapplyService, DnsZoneReapplyError } from './dns-zone-reapply.js';
import { createDnsZoneTemplateRegistry, DnsZoneTemplateRegistryError } from './dns-zone-template-registry.js';
import { createDnsZoneTemplateRollbackService } from './dns-zone-template-rollback.js';
import { createDomainRegistry } from './domain-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createPowerDnsSecretRegistry } from './powerdns-secret-registry.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class PowerDnsHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PowerDnsHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactObject(value, fields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))) {
    throw new PowerDnsHttpError(code, message);
  }
  return value;
}

function identityPreviewBody(body) {
  return exactObject(
    body,
    new Set(['settings']),
    'dns_identity_preview_input_invalid',
    'Send only server DNS settings',
  );
}

function identityApplyBody(body) {
  return exactObject(
    body,
    new Set(['expectedRevision', 'settings', 'previewDigest', 'confirmation']),
    'dns_identity_apply_input_invalid',
    'Send expectedRevision, settings, previewDigest and confirmation',
  );
}

function zoneTemplatePreviewBody(body) {
  return exactObject(
    body,
    new Set(['expectedVersion', 'records']),
    'dns_template_preview_input_invalid',
    'Send expectedVersion and records',
  );
}

function zoneTemplateApplyBody(body) {
  return exactObject(
    body,
    new Set(['expectedVersion', 'records', 'previewDigest', 'confirmation']),
    'dns_template_apply_input_invalid',
    'Send expectedVersion, records, previewDigest and confirmation',
  );
}

function zoneTemplateRollbackPreviewBody(body) {
  return exactObject(
    body,
    new Set(['expectedVersion', 'targetVersion']),
    'dns_template_rollback_preview_input_invalid',
    'Send expectedVersion and targetVersion',
  );
}

function zoneTemplateRollbackApplyBody(body) {
  return exactObject(
    body,
    new Set(['expectedVersion', 'targetVersion', 'previewDigest', 'confirmation']),
    'dns_template_rollback_apply_input_invalid',
    'Send expectedVersion, targetVersion, previewDigest and confirmation',
  );
}

function zoneReapplyApplyBody(body) {
  const value = exactObject(
    body,
    new Set(['previewDigest', 'confirmation']),
    'dns_zone_reapply_input_invalid',
    'Send previewDigest and confirmation',
  );
  if (typeof value.previewDigest !== 'string' || !SHA256_PATTERN.test(value.previewDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new PowerDnsHttpError('dns_zone_reapply_input_invalid', 'Send a current previewDigest and exact confirmation');
  }
  return value;
}

function zoneTemplateVersion(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new PowerDnsHttpError('invalid_dns_template_version', 'DNS template version is invalid');
  }
  const version = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(version)) {
    throw new PowerDnsHttpError('invalid_dns_template_version', 'DNS template version is invalid');
  }
  return version;
}

function authoritativeApplyBody(body) {
  return exactObject(
    body,
    new Set(['previewDigest', 'confirmation']),
    'powerdns_apply_input_invalid',
    'Send previewDigest and confirmation',
  );
}

function requireEmptyBody(body) {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new PowerDnsHttpError('powerdns_preview_input_invalid', 'PowerDNS preview does not accept request fields');
  }
}

function requireZoneReapplyPreviewBody(body) {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new PowerDnsHttpError('dns_zone_reapply_preview_input_invalid', 'DNS zone reapply preview does not accept request fields');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

function localServerId(authoritativeService, requestedServerId) {
  if (typeof authoritativeService?.localServerId !== 'string' || !authoritativeService.localServerId) {
    throw new PowerDnsHttpError('powerdns_local_server_unavailable', 'PowerDNS local server scope is unavailable', 503);
  }
  if (requestedServerId !== authoritativeService.localServerId) {
    throw new PowerDnsHttpError('powerdns_local_server_required', 'PowerDNS can be managed only on this panel host', 404);
  }
  return requestedServerId;
}

function stateRoot(env = process.env) {
  const serverStorePath = env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
  return path.dirname(serverStorePath);
}

function zoneTemplateStorePath(env = process.env) {
  return env.YUNPANEL_DNS_ZONE_TEMPLATE_STORE
    ?? path.join(stateRoot(env), 'dns-zone-template-registry.json');
}

function domainStorePath(env = process.env) {
  return env.YUNPANEL_DOMAIN_STORE ?? path.resolve('.data/domain-registry.json');
}

function powerDnsSecretStorePath(env = process.env) {
  return env.YUNPANEL_POWERDNS_SECRET_STORE
    ?? path.join(stateRoot(env), 'powerdns-secret-registry.json');
}

function defaultZoneTemplateRegistry(authoritativeService, env = process.env) {
  return createDnsZoneTemplateRegistry({
    filePath: zoneTemplateStorePath(env),
    serverExists: async (serverId) => serverId === authoritativeService.localServerId,
  });
}

async function defaultZoneReapplyService({
  dnsIdentityRegistry,
  dnsZoneTemplateRegistry,
  authoritativeService,
  env = process.env,
} = {}) {
  const domainRegistry = createDomainRegistry({ filePath: domainStorePath(env) });
  await domainRegistry.init();
  const secretRegistry = createPowerDnsSecretRegistry({
    filePath: powerDnsSecretStorePath(env),
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    serverExists: async (serverId) => serverId === authoritativeService.localServerId,
  });
  await secretRegistry.init();
  return createDnsZoneReapplyService({
    domainRegistry,
    dnsIdentityRegistry,
    dnsZoneTemplateRegistry,
    powerDnsSecretRegistry: secretRegistry,
    localServerId: authoritativeService.localServerId,
  });
}

async function templateOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneTemplateRegistryError) {
      throw new PowerDnsHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

async function delegationOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsDelegationInspectorError) {
      throw new PowerDnsHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

async function zoneReapplyOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneReapplyError) {
      throw new PowerDnsHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

export function mountPowerDnsRoutes(app, {
  dnsIdentityRegistry,
  dnsZoneTemplateRegistry = null,
  dnsDelegationInspector = null,
  dnsZoneReapplyService = null,
  authoritativeService,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('Express application is required');
  }
  if (!dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function'
    || typeof dnsIdentityRegistry.preview !== 'function' || typeof dnsIdentityRegistry.update !== 'function') {
    throw new Error('Server DNS identity registry is required');
  }
  if (!authoritativeService || typeof authoritativeService.preview !== 'function'
    || typeof authoritativeService.status !== 'function' || typeof authoritativeService.apply !== 'function') {
    throw new Error('PowerDNS authoritative service is required');
  }
  const templateRegistry = dnsZoneTemplateRegistry ?? defaultZoneTemplateRegistry(authoritativeService);
  if (typeof templateRegistry.ensureForServer !== 'function'
    || typeof templateRegistry.getVersion !== 'function'
    || typeof templateRegistry.preview !== 'function'
    || typeof templateRegistry.update !== 'function') {
    throw new Error('DNS zone template registry is required');
  }
  const rollbackService = createDnsZoneTemplateRollbackService({ registry: templateRegistry });
  const delegationInspector = dnsDelegationInspector ?? createDnsDelegationInspector({ dnsIdentityRegistry });
  if (typeof delegationInspector.inspect !== 'function') {
    throw new Error('DNS delegation inspector is required');
  }
  if (dnsZoneReapplyService !== null
    && (typeof dnsZoneReapplyService.preview !== 'function' || typeof dnsZoneReapplyService.apply !== 'function')) {
    throw new Error('DNS zone reapply service is invalid');
  }
  let defaultReapplyPromise = null;
  async function reapplyService() {
    if (dnsZoneReapplyService) return dnsZoneReapplyService;
    if (!defaultReapplyPromise) {
      defaultReapplyPromise = defaultZoneReapplyService({
        dnsIdentityRegistry,
        dnsZoneTemplateRegistry: templateRegistry,
        authoritativeService,
      }).catch((error) => {
        defaultReapplyPromise = null;
        throw error;
      });
    }
    return defaultReapplyPromise;
  }

  app.get('/api/servers/:serverId/dns/identity', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const identity = await dnsIdentityRegistry.getForServer(serverId);
    return response.json({ data: identity });
  }));

  app.get('/api/servers/:serverId/dns/delegation', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const inspection = await delegationOperation(() => delegationInspector.inspect({
      serverId,
      domain: request.query?.domain,
    }));
    return response.json({ data: inspection });
  }));

  app.post('/api/domains/:domainId/dns/reapply-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireZoneReapplyPreviewBody(request.body);
    const service = await reapplyService();
    const preview = await zoneReapplyOperation(() => service.preview({ domainId: request.params.domainId }));
    return response.json({ data: preview });
  }));

  app.post('/api/domains/:domainId/dns/reapply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = zoneReapplyApplyBody(request.body);
    const service = await reapplyService();
    const applied = await zoneReapplyOperation(() => service.apply({
      domainId: request.params.domainId,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    }));
    return response.json({ data: applied });
  }));

  app.post('/api/servers/:serverId/dns/identity/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = identityPreviewBody(request.body);
    const preview = await dnsIdentityRegistry.preview({
      serverId,
      settings: body.settings,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/servers/:serverId/dns/identity/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = identityApplyBody(request.body);
    const updated = await dnsIdentityRegistry.update({
      serverId,
      expectedRevision: body.expectedRevision,
      settings: body.settings,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    });
    return response.json({ data: updated });
  }));

  app.get('/api/servers/:serverId/dns/template', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const template = await templateOperation(() => templateRegistry.ensureForServer(serverId));
    return response.json({ data: template });
  }));

  app.get('/api/servers/:serverId/dns/template/versions/:version', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const version = zoneTemplateVersion(request.params.version);
    const template = await templateOperation(() => templateRegistry.getVersion(serverId, version));
    if (!template) {
      throw new PowerDnsHttpError('dns_template_version_not_found', 'DNS template version was not found', 404);
    }
    return response.json({ data: template });
  }));

  app.post('/api/servers/:serverId/dns/template/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = zoneTemplatePreviewBody(request.body);
    const preview = await templateOperation(() => templateRegistry.preview({
      serverId,
      expectedVersion: body.expectedVersion,
      records: body.records,
    }));
    return response.json({ data: preview });
  }));

  app.post('/api/servers/:serverId/dns/template/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = zoneTemplateApplyBody(request.body);
    const updated = await templateOperation(() => templateRegistry.update({
      serverId,
      expectedVersion: body.expectedVersion,
      records: body.records,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    }));
    return response.json({ data: updated });
  }));

  app.post('/api/servers/:serverId/dns/template/rollback/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = zoneTemplateRollbackPreviewBody(request.body);
    const preview = await templateOperation(() => rollbackService.preview({
      serverId,
      expectedVersion: body.expectedVersion,
      targetVersion: body.targetVersion,
    }));
    return response.json({ data: preview });
  }));

  app.post('/api/servers/:serverId/dns/template/rollback/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = zoneTemplateRollbackApplyBody(request.body);
    const updated = await templateOperation(() => rollbackService.apply({
      serverId,
      expectedVersion: body.expectedVersion,
      targetVersion: body.targetVersion,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    }));
    return response.json({ data: updated });
  }));

  app.get('/api/servers/:serverId/dns/authoritative', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    return response.json({ data: await authoritativeService.status(serverId) });
  }));

  app.post('/api/servers/:serverId/dns/authoritative/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    requireEmptyBody(request.body);
    return response.json({ data: await authoritativeService.preview(serverId) });
  }));

  app.post('/api/servers/:serverId/dns/authoritative/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = authoritativeApplyBody(request.body);
    return response.json({
      data: await authoritativeService.apply(serverId, {
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      }),
    });
  }));
}

export const powerDnsHttpInternals = Object.freeze({
  identityPreviewBody,
  identityApplyBody,
  zoneTemplatePreviewBody,
  zoneTemplateApplyBody,
  zoneTemplateRollbackPreviewBody,
  zoneTemplateRollbackApplyBody,
  zoneReapplyApplyBody,
  zoneTemplateVersion,
  authoritativeApplyBody,
  requireEmptyBody,
  requireZoneReapplyPreviewBody,
  localServerId,
  stateRoot,
  zoneTemplateStorePath,
  domainStorePath,
  powerDnsSecretStorePath,
  defaultZoneTemplateRegistry,
  defaultZoneReapplyService,
  templateOperation,
  delegationOperation,
  zoneReapplyOperation,
});
