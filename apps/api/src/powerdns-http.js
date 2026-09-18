import path from 'node:path';
import { createDnsDelegationInspector, DnsDelegationInspectorError } from './dns-delegation-inspector.js';
import { mountDnsZoneMailDkimRetirementRoutes } from './dns-zone-mail-dkim-retirement-http.js';
import { createDnsZoneMailDkimRetirementService } from './dns-zone-mail-dkim-retirement.js';
import { createDnsZoneMailIntentResolver } from './dns-zone-mail-intent.js';
import { mountDnsZoneDnssecRoutes } from './dns-zone-dnssec-http.js';
import { mountDnsZoneSecondaryStatusRoutes } from './dns-zone-secondary-status-http.js';
import {
  createDnsZoneReapplyOperationRegistry,
  DnsZoneReapplyOperationRegistryError,
} from './dns-zone-reapply-operation-registry.js';
import { createDnsZoneReapplyRuntime, DnsZoneReapplyRuntimeError } from './dns-zone-reapply-runtime.js';
import { createDnsZoneReapplyService, DnsZoneReapplyError } from './dns-zone-reapply.js';
import { createDnsZoneRecordsService, DnsZoneRecordsError } from './dns-zone-records.js';
import { createDnsZoneRetirementService, DnsZoneRetirementError } from './dns-zone-retirement.js';
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
  return exactObject(body, new Set(['settings']), 'dns_identity_preview_input_invalid', 'Send only server DNS settings');
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

function zoneReapplyRollbackPreviewBody(body) {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new PowerDnsHttpError(
      'dns_zone_reapply_rollback_preview_input_invalid',
      'DNS zone reapply rollback preview does not accept request fields',
    );
  }
}

function zoneReapplyRollbackBody(body) {
  const value = exactObject(
    body,
    new Set(['expectedUpdatedAt', 'sourceZoneDigest', 'appliedZoneDigest', 'confirmation']),
    'dns_zone_reapply_rollback_input_invalid',
    'Send expectedUpdatedAt, sourceZoneDigest, appliedZoneDigest and confirmation',
  );
  if (typeof value.expectedUpdatedAt !== 'string' || !value.expectedUpdatedAt
    || !Number.isFinite(Date.parse(value.expectedUpdatedAt))
    || new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
    || typeof value.sourceZoneDigest !== 'string' || !SHA256_PATTERN.test(value.sourceZoneDigest)
    || typeof value.appliedZoneDigest !== 'string' || !SHA256_PATTERN.test(value.appliedZoneDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new PowerDnsHttpError(
      'dns_zone_reapply_rollback_input_invalid',
      'Send an exact rollback journal revision, before/after digests and confirmation',
    );
  }
  return value;
}

function zoneTemplateVersion(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new PowerDnsHttpError('invalid_dns_template_version', 'DNS template version is invalid');
  }
  const version = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(version)) throw new PowerDnsHttpError('invalid_dns_template_version', 'DNS template version is invalid');
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

function authoritativeRecoveryBody(body) {
  const value = exactObject(
    body,
    new Set(['operationId', 'expectedUpdatedAt', 'confirmation']),
    'powerdns_recovery_input_invalid',
    'Send operationId, expectedUpdatedAt and confirmation',
  );
  if (typeof value.operationId !== 'string' || !value.operationId
    || typeof value.expectedUpdatedAt !== 'string' || !value.expectedUpdatedAt
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new PowerDnsHttpError(
      'powerdns_recovery_input_invalid',
      'Send an exact PowerDNS recovery operation identity and confirmation',
    );
  }
  return value;
}

function authoritativeRollbackBody(body) {
  const value = exactObject(
    body,
    new Set(['operationId', 'expectedUpdatedAt', 'snapshotDigest', 'confirmation']),
    'powerdns_rollback_input_invalid',
    'Send operationId, expectedUpdatedAt, snapshotDigest and confirmation',
  );
  if (typeof value.operationId !== 'string' || !value.operationId
    || typeof value.expectedUpdatedAt !== 'string' || !value.expectedUpdatedAt
    || typeof value.snapshotDigest !== 'string' || !SHA256_PATTERN.test(value.snapshotDigest)
    || typeof value.confirmation !== 'string' || !value.confirmation) {
    throw new PowerDnsHttpError(
      'powerdns_rollback_input_invalid',
      'Send an exact PowerDNS rollback operation, snapshot digest and confirmation',
    );
  }
  return value;
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
  return env.YUNPANEL_DNS_ZONE_TEMPLATE_STORE ?? path.join(stateRoot(env), 'dns-zone-template-registry.json');
}

function domainStorePath(env = process.env) {
  return env.YUNPANEL_DOMAIN_STORE ?? path.resolve('.data/domain-registry.json');
}

function powerDnsSecretStorePath(env = process.env) {
  return env.YUNPANEL_POWERDNS_SECRET_STORE ?? path.join(stateRoot(env), 'powerdns-secret-registry.json');
}

function zoneReapplyOperationStorePath(env = process.env) {
  return env.YUNPANEL_DNS_ZONE_REAPPLY_OPERATION_STORE
    ?? path.join(stateRoot(env), 'dns-zone-reapply-operations.json');
}

function defaultZoneTemplateRegistry(authoritativeService, env = process.env) {
  return createDnsZoneTemplateRegistry({
    filePath: zoneTemplateStorePath(env),
    serverExists: async (serverId) => serverId === authoritativeService.localServerId,
  });
}

async function defaultDomainAndSecretRegistries(authoritativeService, env = process.env) {
  const domainRegistry = createDomainRegistry({ filePath: domainStorePath(env) });
  await domainRegistry.init();
  const secretRegistry = createPowerDnsSecretRegistry({
    filePath: powerDnsSecretStorePath(env),
    masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    serverExists: async (serverId) => serverId === authoritativeService.localServerId,
  });
  await secretRegistry.init();
  return Object.freeze({ domainRegistry, secretRegistry });
}

async function defaultZoneReapplyService({
  dnsIdentityRegistry,
  dnsZoneTemplateRegistry,
  authoritativeService,
  domainRegistry = null,
  powerDnsSecretRegistry = null,
  mailDomainRegistry = null,
  mailDkimRegistry = null,
  mailDkimRetirementRegistry = null,
  mailServiceIdentityRegistry = null,
  mailDiscoveryEndpointResolver = null,
  zoneManager = null,
  now = Date.now,
  env = process.env,
} = {}) {
  const suppliedRegistryPair = domainRegistry !== null && powerDnsSecretRegistry !== null;
  if ((domainRegistry === null) !== (powerDnsSecretRegistry === null)) {
    throw new PowerDnsHttpError(
      'dns_zone_reapply_registry_dependencies_invalid',
      'DNS zone reapply Domain and PowerDNS secret registries must be configured together',
      503,
    );
  }
  const defaults = suppliedRegistryPair
    ? null
    : await defaultDomainAndSecretRegistries(authoritativeService, env);
  const scopedDomainRegistry = suppliedRegistryPair ? domainRegistry : defaults.domainRegistry;
  const secretRegistry = suppliedRegistryPair ? powerDnsSecretRegistry : defaults.secretRegistry;
  const mailDependencies = [
    mailDomainRegistry,
    mailDkimRegistry,
    mailDkimRetirementRegistry,
    mailServiceIdentityRegistry,
  ];
  const hasMailIntent = mailDependencies.every((dependency) => dependency !== null);
  if ((!hasMailIntent && mailDependencies.some((dependency) => dependency !== null))
    || (mailDiscoveryEndpointResolver !== null && !hasMailIntent)) {
    throw new PowerDnsHttpError(
      'dns_zone_reapply_mail_dependencies_invalid',
      'DNS zone reapply mail desired-state dependencies must be configured together',
      503,
    );
  }
  return createDnsZoneReapplyService({
    domainRegistry: scopedDomainRegistry,
    dnsIdentityRegistry,
    dnsZoneTemplateRegistry,
    powerDnsSecretRegistry: secretRegistry,
    ...(hasMailIntent ? {
      mailIntentResolver: createDnsZoneMailIntentResolver({
        mailDomainRegistry,
        mailDkimRegistry,
        mailDkimRetirementRegistry,
        mailServiceIdentityRegistry,
        mailDiscoveryEndpointResolver,
      }),
    } : {}),
    ...(zoneManager ? { zoneManager } : {}),
    now,
    localServerId: authoritativeService.localServerId,
  });
}

async function defaultZoneReapplyRuntime({
  dnsIdentityRegistry,
  dnsZoneTemplateRegistry,
  authoritativeService,
  domainRegistry = null,
  powerDnsSecretRegistry = null,
  mailDomainRegistry = null,
  mailDkimRegistry = null,
  mailDkimRetirementRegistry = null,
  mailServiceIdentityRegistry = null,
  mailDiscoveryEndpointResolver = null,
  env = process.env,
} = {}) {
  const service = await defaultZoneReapplyService({
    dnsIdentityRegistry,
    dnsZoneTemplateRegistry,
    authoritativeService,
    domainRegistry,
    powerDnsSecretRegistry,
    mailDomainRegistry,
    mailDkimRegistry,
    mailDkimRetirementRegistry,
    mailServiceIdentityRegistry,
    mailDiscoveryEndpointResolver,
    env,
  });
  const registry = createDnsZoneReapplyOperationRegistry({ filePath: zoneReapplyOperationStorePath(env) });
  const runtime = createDnsZoneReapplyRuntime({ registry, service });
  await runtime.init();
  return runtime;
}

async function defaultZoneRetirementService(
  authoritativeService,
  domainRegistry = null,
  powerDnsSecretRegistry = null,
  env = process.env,
) {
  if ((domainRegistry === null) !== (powerDnsSecretRegistry === null)) {
    throw new PowerDnsHttpError(
      'dns_zone_retirement_registry_dependencies_invalid',
      'DNS zone retirement Domain and PowerDNS secret registries must be configured together',
      503,
    );
  }
  const defaults = domainRegistry === null
    ? await defaultDomainAndSecretRegistries(authoritativeService, env)
    : null;
  return createDnsZoneRetirementService({
    domainRegistry: domainRegistry ?? defaults.domainRegistry,
    powerDnsSecretRegistry: powerDnsSecretRegistry ?? defaults.secretRegistry,
    localServerId: authoritativeService.localServerId,
  });
}

async function defaultZoneRecordsService(
  authoritativeService,
  domainRegistry = null,
  powerDnsSecretRegistry = null,
  env = process.env,
) {
  if ((domainRegistry === null) !== (powerDnsSecretRegistry === null)) {
    throw new PowerDnsHttpError(
      'dns_zone_records_registry_dependencies_invalid',
      'DNS zone record Domain and PowerDNS secret registries must be configured together',
      503,
    );
  }
  const defaults = domainRegistry === null
    ? await defaultDomainAndSecretRegistries(authoritativeService, env)
    : null;
  return createDnsZoneRecordsService({
    domainRegistry: domainRegistry ?? defaults.domainRegistry,
    powerDnsSecretRegistry: powerDnsSecretRegistry ?? defaults.secretRegistry,
    localServerId: authoritativeService.localServerId,
  });
}

async function templateOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneTemplateRegistryError) throw new PowerDnsHttpError(error.code, error.message, error.status);
    throw error;
  }
}

async function delegationOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsDelegationInspectorError) throw new PowerDnsHttpError(error.code, error.message, error.status);
    throw error;
  }
}

async function zoneReapplyOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneReapplyError
      || error instanceof DnsZoneReapplyRuntimeError
      || error instanceof DnsZoneReapplyOperationRegistryError) {
      throw new PowerDnsHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

async function zoneRecordsOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneRecordsError) throw new PowerDnsHttpError(error.code, error.message, error.status);
    throw error;
  }
}

async function zoneRetirementOperation(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DnsZoneRetirementError) {
      throw new PowerDnsHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

export function mountPowerDnsRoutes(app, {
  dnsIdentityRegistry,
  dnsZoneTemplateRegistry = null,
  dnsDelegationInspector = null,
  dnsZoneReapplyRuntime = null,
  dnsZoneRecordsService = null,
  dnsZoneRetirementService = null,
  domainRegistry = null,
  powerDnsSecretRegistry = null,
  mailDomainRegistry = null,
  mailDkimRegistry = null,
  mailDkimRetirementRegistry = null,
  mailServiceIdentityRegistry = null,
  mailDiscoveryEndpointResolver = null,
  authoritativeService,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!dnsIdentityRegistry || typeof dnsIdentityRegistry.getForServer !== 'function'
    || typeof dnsIdentityRegistry.preview !== 'function' || typeof dnsIdentityRegistry.update !== 'function') {
    throw new Error('Server DNS identity registry is required');
  }
  if (!authoritativeService || typeof authoritativeService.preview !== 'function'
    || typeof authoritativeService.status !== 'function' || typeof authoritativeService.apply !== 'function'
    || typeof authoritativeService.resolve !== 'function' || typeof authoritativeService.retry !== 'function'
    || typeof authoritativeService.rollback !== 'function') {
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
  if (typeof delegationInspector.inspect !== 'function') throw new Error('DNS delegation inspector is required');
  if (dnsZoneReapplyRuntime !== null
    && (typeof dnsZoneReapplyRuntime.preview !== 'function' || typeof dnsZoneReapplyRuntime.start !== 'function'
      || typeof dnsZoneReapplyRuntime.rollbackPreview !== 'function' || typeof dnsZoneReapplyRuntime.rollback !== 'function'
      || typeof dnsZoneReapplyRuntime.get !== 'function' || typeof dnsZoneReapplyRuntime.listForDomain !== 'function')) {
    throw new Error('DNS zone reapply runtime is invalid');
  }
  if (dnsZoneRecordsService !== null
    && (typeof dnsZoneRecordsService.getZone !== 'function' || typeof dnsZoneRecordsService.apply !== 'function'
      || typeof dnsZoneRecordsService.remove !== 'function')) {
    throw new Error('DNS zone records service is invalid');
  }

  if (dnsZoneRetirementService !== null && typeof dnsZoneRetirementService.preview !== 'function') {
    throw new Error('DNS zone retirement service is invalid');
  }

  let defaultRuntimePromise = null;
  function reapplyRuntime() {
    if (dnsZoneReapplyRuntime) return Promise.resolve(dnsZoneReapplyRuntime);
    if (!defaultRuntimePromise) {
      defaultRuntimePromise = defaultZoneReapplyRuntime({
        dnsIdentityRegistry,
        dnsZoneTemplateRegistry: templateRegistry,
        authoritativeService,
        domainRegistry,
        powerDnsSecretRegistry,
        mailDomainRegistry,
        mailDkimRegistry,
        mailDkimRetirementRegistry,
        mailServiceIdentityRegistry,
        mailDiscoveryEndpointResolver,
      });
      defaultRuntimePromise.catch(() => { defaultRuntimePromise = null; });
    }
    return defaultRuntimePromise;
  }
  if (!dnsZoneReapplyRuntime) void reapplyRuntime();

  let defaultRecordsPromise = null;
  function zoneRecordsService() {
    if (dnsZoneRecordsService) return Promise.resolve(dnsZoneRecordsService);
    if (!defaultRecordsPromise) {
      defaultRecordsPromise = defaultZoneRecordsService(
        authoritativeService,
        domainRegistry,
        powerDnsSecretRegistry,
      );
      defaultRecordsPromise.catch(() => { defaultRecordsPromise = null; });
    }
    return defaultRecordsPromise;
  }

  let defaultRetirementPromise = null;
  function zoneRetirementService() {
    if (dnsZoneRetirementService) return Promise.resolve(dnsZoneRetirementService);
    if (!defaultRetirementPromise) {
      defaultRetirementPromise = defaultZoneRetirementService(
        authoritativeService,
        domainRegistry,
        powerDnsSecretRegistry,
      );
      defaultRetirementPromise.catch(() => { defaultRetirementPromise = null; });
    }
    return defaultRetirementPromise;
  }

  const localDkimRetirementDependencies = [
    domainRegistry,
    powerDnsSecretRegistry,
    mailDomainRegistry,
    mailDkimRegistry,
    mailDkimRetirementRegistry,
    mailServiceIdentityRegistry,
  ];
  const hasLocalDkimRetirement = localDkimRetirementDependencies.every((dependency) => dependency !== null);
  let localDkimRetirementServicePromise = null;
  function localDkimRetirementService() {
    if (!hasLocalDkimRetirement) {
      throw new PowerDnsHttpError(
        'mail_dkim_local_retirement_dependencies_invalid',
        'Local DKIM retirement dependencies are unavailable',
        503,
      );
    }
    if (!localDkimRetirementServicePromise) {
      localDkimRetirementServicePromise = Promise.all([reapplyRuntime(), zoneRecordsService()])
        .then(([runtime, recordsService]) => createDnsZoneMailDkimRetirementService({
          mailDomainRegistry,
          mailDkimRetirementRegistry,
          domainRegistry,
          dnsZoneRecordsService: recordsService,
          dnsZoneReapplyRuntime: runtime,
          localServerId: authoritativeService.localServerId,
        }));
      localDkimRetirementServicePromise.catch(() => { localDkimRetirementServicePromise = null; });
    }
    return localDkimRetirementServicePromise;
  }

  mountDnsZoneDnssecRoutes(app, { authoritativeService, dnsIdentityRegistry });
  mountDnsZoneSecondaryStatusRoutes(app, { dnsIdentityRegistry, authoritativeService });
  if (hasLocalDkimRetirement) {
    mountDnsZoneMailDkimRetirementRoutes(app, { serviceForRequest: localDkimRetirementService });
  }

  app.get('/api/domains/:domainId/dns/retirement-impact', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    if (Object.keys(request.query ?? {}).length !== 0) {
      throw new PowerDnsHttpError(
        'dns_zone_retirement_query_invalid',
        'DNS zone retirement impact does not accept query parameters',
      );
    }
    const preview = await zoneRetirementOperation(
      async () => (await zoneRetirementService()).preview({ domainId: request.params.domainId }),
    );
    response.set('Cache-Control', 'no-store');
    return response.json({ data: preview });
  }));

  app.get('/api/servers/:serverId/dns/identity', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    return response.json({ data: await dnsIdentityRegistry.getForServer(serverId) });
  }));

  app.get('/api/servers/:serverId/dns/delegation', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const inspection = await delegationOperation(() => delegationInspector.inspect({ serverId, domain: request.query?.domain }));
    return response.json({ data: inspection });
  }));

  app.get('/api/domains/:domainId/dns/zone', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const zone = await zoneRecordsOperation(async () => (await zoneRecordsService()).getZone({ domainId: request.params.domainId }));
    return response.json({ data: zone });
  }));

  app.post('/api/domains/:domainId/dns/records', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const result = await zoneRecordsOperation(async () => (await zoneRecordsService()).apply({
      domainId: request.params.domainId,
      input: request.body,
    }));
    return response.json({ data: result });
  }));

  app.post('/api/domains/:domainId/dns/records/delete', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const result = await zoneRecordsOperation(async () => (await zoneRecordsService()).remove({
      domainId: request.params.domainId,
      input: request.body,
    }));
    return response.json({ data: result });
  }));

  app.post('/api/domains/:domainId/dns/reapply-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireZoneReapplyPreviewBody(request.body);
    const preview = await zoneReapplyOperation(async () => (await reapplyRuntime()).preview({ domainId: request.params.domainId }));
    return response.json({ data: preview });
  }));

  app.post('/api/domains/:domainId/dns/reapply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = zoneReapplyApplyBody(request.body);
    const operation = await zoneReapplyOperation(async () => (await reapplyRuntime()).start({
      domainId: request.params.domainId,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    }));
    return response.json({ data: operation });
  }));

  app.get('/api/domains/:domainId/dns/reapply-operations', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const operations = await zoneReapplyOperation(async () => (await reapplyRuntime()).listForDomain(request.params.domainId));
    return response.json({ data: operations });
  }));

  app.get('/api/domains/:domainId/dns/reapply-operations/:operationId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const operation = await zoneReapplyOperation(async () => (await reapplyRuntime()).get(request.params.operationId));
    if (!operation || operation.domainId !== request.params.domainId) {
      throw new PowerDnsHttpError('dns_zone_reapply_operation_not_found', 'DNS zone reapply operation was not found', 404);
    }
    return response.json({ data: operation });
  }));

  app.post('/api/domains/:domainId/dns/reapply-operations/:operationId/rollback-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    zoneReapplyRollbackPreviewBody(request.body);
    const preview = await zoneReapplyOperation(async () => (await reapplyRuntime()).rollbackPreview({
      domainId: request.params.domainId,
      operationId: request.params.operationId,
    }));
    return response.json({ data: preview });
  }));

  app.post('/api/domains/:domainId/dns/reapply-operations/:operationId/rollback', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = zoneReapplyRollbackBody(request.body);
    const operation = await zoneReapplyOperation(async () => (await reapplyRuntime()).rollback({
      domainId: request.params.domainId,
      operationId: request.params.operationId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      sourceZoneDigest: body.sourceZoneDigest,
      appliedZoneDigest: body.appliedZoneDigest,
      confirmation: body.confirmation,
    }));
    return response.json({ data: operation });
  }));

  app.post('/api/servers/:serverId/dns/identity/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = identityPreviewBody(request.body);
    return response.json({ data: await dnsIdentityRegistry.preview({ serverId, settings: body.settings }) });
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
    return response.json({ data: await templateOperation(() => templateRegistry.ensureForServer(serverId)) });
  }));

  app.get('/api/servers/:serverId/dns/template/versions/:version', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const version = zoneTemplateVersion(request.params.version);
    const template = await templateOperation(() => templateRegistry.getVersion(serverId, version));
    if (!template) throw new PowerDnsHttpError('dns_template_version_not_found', 'DNS template version was not found', 404);
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
    return response.json({ data: await authoritativeService.apply(serverId, {
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    }) });
  }));

  app.post('/api/servers/:serverId/dns/authoritative/recovery/resolve', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = authoritativeRecoveryBody(request.body);
    return response.json({ data: await authoritativeService.resolve(serverId, body) });
  }));

  app.post('/api/servers/:serverId/dns/authoritative/recovery/retry', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = authoritativeRecoveryBody(request.body);
    return response.json({ data: await authoritativeService.retry(serverId, body) });
  }));

  app.post('/api/servers/:serverId/dns/authoritative/rollback', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const serverId = localServerId(authoritativeService, request.params.serverId);
    const body = authoritativeRollbackBody(request.body);
    return response.json({ data: await authoritativeService.rollback(serverId, body) });
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
  authoritativeRecoveryBody,
  authoritativeRollbackBody,
  requireEmptyBody,
  requireZoneReapplyPreviewBody,
  localServerId,
  stateRoot,
  zoneTemplateStorePath,
  domainStorePath,
  powerDnsSecretStorePath,
  zoneReapplyOperationStorePath,
  defaultZoneTemplateRegistry,
  defaultDomainAndSecretRegistries,
  defaultZoneReapplyService,
  defaultZoneReapplyRuntime,
  defaultZoneRecordsService,
  templateOperation,
  delegationOperation,
  zoneReapplyOperation,
  zoneRecordsOperation,
});
