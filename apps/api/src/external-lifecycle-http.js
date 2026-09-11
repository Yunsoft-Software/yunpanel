import { ExternalLifecycleRegistryError } from './external-lifecycle-registry.js';
import { requirePanelRouteAccess } from './panel-http-guard.js';

const CREATE_FIELDS = new Set(['name', 'webDomainId', 'managementMode']);
const PROVIDER_CREDENTIAL_FIELDS = new Set(['provider', 'token', 'confirmation']);
const PROVIDER_CREDENTIAL_DELETE_FIELDS = new Set(['confirmation']);

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

export function mountExternalLifecycleRoutes(app, { dnsHostingRegistry, dnsProviderCredentialRegistry, mailDomainRegistry } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!dnsHostingRegistry || typeof dnsHostingRegistry.createZone !== 'function'
    || typeof dnsHostingRegistry.getZone !== 'function' || typeof dnsHostingRegistry.listZones !== 'function'
    || !dnsProviderCredentialRegistry || typeof dnsProviderCredentialRegistry.setCredential !== 'function'
    || typeof dnsProviderCredentialRegistry.getForZone !== 'function' || typeof dnsProviderCredentialRegistry.deleteForZone !== 'function'
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
  app.get('/api/dns-zones/:dnsZoneId/provider-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    emptyQuery(request.query);
    if (!(await dnsHostingRegistry.getZone(request.params.dnsZoneId))) {
      throw new ExternalLifecycleRegistryError('dns_zone_not_found', 'DNS zone was not found', 404);
    }
    return response.json({ data: await dnsProviderCredentialRegistry.getForZone(request.params.dnsZoneId) });
  }));
  app.put('/api/dns-zones/:dnsZoneId/provider-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== PROVIDER_CREDENTIAL_FIELDS.size
      || Object.keys(body).some((field) => !PROVIDER_CREDENTIAL_FIELDS.has(field))) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_input_invalid', 'DNS provider credential fields are invalid');
    }
    const expected = `configure-dns-provider:${request.params.dnsZoneId}:${body.provider}`;
    if (body.confirmation !== expected) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_confirmation_required', `Confirm DNS provider credential with ${expected}`);
    }
    return response.json({ data: await dnsProviderCredentialRegistry.setCredential({
      dnsZoneId: request.params.dnsZoneId,
      provider: body.provider,
      token: body.token,
    }) });
  }));
  app.delete('/api/dns-zones/:dnsZoneId/provider-credential', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== PROVIDER_CREDENTIAL_DELETE_FIELDS.size
      || Object.keys(body).some((field) => !PROVIDER_CREDENTIAL_DELETE_FIELDS.has(field))) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_input_invalid', 'DNS provider credential delete fields are invalid');
    }
    const expected = `delete-dns-provider:${request.params.dnsZoneId}`;
    if (body.confirmation !== expected) {
      throw new ExternalLifecycleRegistryError('dns_provider_credential_confirmation_required', `Confirm DNS provider credential deletion with ${expected}`);
    }
    await dnsProviderCredentialRegistry.deleteForZone(request.params.dnsZoneId);
    return response.status(204).end();
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
