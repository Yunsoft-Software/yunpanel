import { assertUuid } from '@yunpanel/shared';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { bindLegacyDomainToWebsite, WebsiteMigrationBindError, websiteMigrationBindInternals } from './website-migration-bind.js';
import { previewWebsiteMigration } from './website-migration-preview.js';

const BIND_FIELDS = new Set(['domainId', 'websiteId', 'previewDigest', 'confirmation']);

function assertBindBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !BIND_FIELDS.has(key))) {
    throw new WebsiteMigrationBindError('website_migration_binding_invalid', 'Send only documented migration binding fields', 400);
  }
  let domainId;
  let websiteId;
  try {
    domainId = assertUuid(body.domainId, 'domainId');
    websiteId = assertUuid(body.websiteId, 'websiteId');
  } catch {
    throw new WebsiteMigrationBindError('website_migration_binding_invalid', 'Domain and Website IDs must be valid UUIDs', 400);
  }
  if (typeof body.previewDigest !== 'string' || !websiteMigrationBindInternals.digestPattern.test(body.previewDigest)) {
    throw new WebsiteMigrationBindError('website_migration_preview_digest_invalid', 'A current migration preview digest is required', 400);
  }
  const expectedConfirmation = `bind:${domainId}:${websiteId}:${body.previewDigest}`;
  if (body.confirmation !== expectedConfirmation) {
    throw new WebsiteMigrationBindError('website_migration_confirmation_required', `Confirm migration binding with ${expectedConfirmation}`, 400);
  }
  return Object.freeze({ domainId, websiteId, previewDigest: body.previewDigest });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) { return next(error); }
  };
}

export function mountWebsiteMigrationRoutes(app, {
  websiteRegistry,
  domainRegistry,
  applicationRegistry,
  preview = previewWebsiteMigration,
  bind = bindLegacyDomainToWebsite,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!websiteRegistry || typeof websiteRegistry.listWebsites !== 'function') throw new Error('Website registry is required');
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function' || typeof domainRegistry.bindWebsite !== 'function') throw new Error('Domain registry is required');
  if (!applicationRegistry || typeof applicationRegistry.listApplications !== 'function') throw new Error('Application registry is required');
  if (typeof preview !== 'function' || typeof bind !== 'function') throw new Error('Website migration adapters are required');

  app.get('/api/websites/migration/preview', requirePanelRouteAccess, asyncRoute(async (_request, response) => {
    const [domains, websites, applications] = await Promise.all([
      domainRegistry.listDomains(),
      websiteRegistry.listWebsites(),
      applicationRegistry.listApplications(),
    ]);
    return response.json({ data: preview({ domains, websites, applications }) });
  }));

  app.post('/api/websites/migration/bind', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = assertBindBody(request.body);
    const result = await bind({
      ...input,
      domainRegistry,
      websiteRegistry,
      applicationRegistry,
      preview,
    });
    return response.json({ data: result });
  }));
}

export const websiteMigrationHttpInternals = Object.freeze({ assertBindBody });
