import { requirePanelRouteAccess } from './panel-http-guard.js';
import { createSite, previewSiteCreate, SiteCreateError } from './site-create.js';

const PREVIEW_FIELDS = new Set(['input']);
const APPLY_FIELDS = new Set(['input', 'previewDigest', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size
    || Object.keys(body).some((key) => !fields.has(key))) {
    throw new SiteCreateError(code, message);
  }
  return body;
}

function previewBody(body) {
  return exactBody(body, PREVIEW_FIELDS, 'site_create_preview_input_invalid', 'Send only the documented site-create input');
}

function applyBody(body) {
  const input = exactBody(body, APPLY_FIELDS, 'site_create_apply_input_invalid', 'Send input, previewDigest and confirmation');
  if (typeof input.previewDigest !== 'string' || !SHA256_PATTERN.test(input.previewDigest)) {
    throw new SiteCreateError('site_create_preview_digest_invalid', 'A current site-create preview digest is required');
  }
  if (typeof input.confirmation !== 'string') {
    throw new SiteCreateError('site_create_confirmation_required', 'Exact site-create confirmation is required');
  }
  return input;
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountSiteCreateRoutes(app, dependencies = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('Express application is required');

  app.post('/api/sites/create-preview', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = previewBody(request.body);
    if (dependencies.localServerId && body.input?.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    return response.json({ data: await previewSiteCreate({ input: { ...body.input, serverId: dependencies.localServerId ?? body.input?.serverId }, ...dependencies }) });
  }));

  app.post('/api/sites', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const body = applyBody(request.body);
    if (dependencies.localServerId && body.input?.serverId !== dependencies.localServerId) {
      throw new SiteCreateError('local_server_required', 'Sites can be created only on this panel host', 404);
    }
    const result = await createSite({
      input: { ...body.input, serverId: dependencies.localServerId ?? body.input?.serverId },
      previewDigest: body.previewDigest,
      confirmation: body.confirmation,
      ...dependencies,
    });
    return response.status(result.created ? 201 : 200).json({ data: result });
  }));
}

export const siteCreateHttpInternals = Object.freeze({ previewBody, applyBody });
