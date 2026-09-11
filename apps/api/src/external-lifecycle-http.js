import { ExternalLifecycleRegistryError } from './external-lifecycle-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['name', 'webDomainId', 'managementMode']);

function createInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== CREATE_FIELDS.size
    || Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
    throw new ExternalLifecycleRegistryError('external_lifecycle_input_invalid', 'Send name, explicit webDomainId or null, and managementMode');
  }
  return body;
}

function emptyQuery(query) {
  if (Object.keys(query ?? {}).length !== 0) {
    throw new ExternalLifecycleRegistryError('external_lifecycle_query_invalid', 'Lifecycle inventory does not accept query parameters');
  }
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountExternalLifecycleRoutes(app, { dnsHostingRegistry, mailDomainRegistry } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!dnsHostingRegistry || typeof dnsHostingRegistry.createZone !== 'function'
    || typeof dnsHostingRegistry.getZone !== 'function' || typeof dnsHostingRegistry.listZones !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.createMailDomain !== 'function'
    || typeof mailDomainRegistry.getMailDomain !== 'function' || typeof mailDomainRegistry.listMailDomains !== 'function') {
    throw new Error('External lifecycle registries are required');
  }

  app.get('/api/dns-zones', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await dnsHostingRegistry.listZones() });
  }));
  app.get('/api/dns-zones/:dnsZoneId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const resource = await dnsHostingRegistry.getZone(request.params.dnsZoneId);
    if (!resource) throw new ExternalLifecycleRegistryError('dns_zone_not_found', 'DNS zone was not found', 404);
    return response.json({ data: resource });
  }));
  app.post('/api/dns-zones', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = createInput(request.body);
    const resource = await dnsHostingRegistry.createZone({
      zoneName: body.name,
      webDomainId: body.webDomainId,
      managementMode: body.managementMode,
    });
    return response.status(201).json({ data: resource, sideEffects: { dnsPublished: false } });
  }));

  app.get('/api/mail-domains', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    return response.json({ data: await mailDomainRegistry.listMailDomains() });
  }));
  app.get('/api/mail-domains/:mailDomainId', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    const resource = await mailDomainRegistry.getMailDomain(request.params.mailDomainId);
    if (!resource) throw new ExternalLifecycleRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    return response.json({ data: resource });
  }));
  app.post('/api/mail-domains', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = createInput(request.body);
    const resource = await mailDomainRegistry.createMailDomain({
      domainName: body.name,
      webDomainId: body.webDomainId,
      managementMode: body.managementMode,
    });
    return response.status(201).json({ data: resource, sideEffects: { mailConfigured: false, mailboxesCreated: false } });
  }));
}

export const externalLifecycleHttpInternals = Object.freeze({ createInput, emptyQuery });
