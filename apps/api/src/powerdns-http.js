import { requirePanelRouteAccess } from './panel-http-guard.js';

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

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountPowerDnsRoutes(app, {
  dnsIdentityRegistry,
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

  app.get('/api/servers/:serverId/dns/identity', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const identity = await dnsIdentityRegistry.getForServer(request.params.serverId);
    return response.json({ data: identity });
  }));

  app.post('/api/servers/:serverId/dns/identity/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = identityPreviewBody(request.body);
    const preview = await dnsIdentityRegistry.preview({
      serverId: request.params.serverId,
      settings: body.settings,
    });
    return response.json({ data: preview });
  }));

  app.post('/api/servers/:serverId/dns/identity/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = identityApplyBody(request.body);
    const updated = await dnsIdentityRegistry.update({
      serverId: request.params.serverId,
      expectedRevision: body.expectedRevision,
      settings: body.settings,
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
    });
    return response.json({ data: updated });
  }));

  app.get('/api/servers/:serverId/dns/authoritative', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    return response.json({ data: await authoritativeService.status(request.params.serverId) });
  }));

  app.post('/api/servers/:serverId/dns/authoritative/preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    requireEmptyBody(request.body);
    return response.json({ data: await authoritativeService.preview(request.params.serverId) });
  }));

  app.post('/api/servers/:serverId/dns/authoritative/apply', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = authoritativeApplyBody(request.body);
    return response.json({
      data: await authoritativeService.apply(request.params.serverId, {
        previewDigest: body.previewDigest,
        confirmation: body.confirmation,
      }),
    });
  }));
}

export const powerDnsHttpInternals = Object.freeze({
  identityPreviewBody,
  identityApplyBody,
  authoritativeApplyBody,
  requireEmptyBody,
});
