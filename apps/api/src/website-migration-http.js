import { assertUuid } from '@yunpanel/shared';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { bindLegacyDomainToWebsite, WebsiteMigrationBindError, websiteMigrationBindInternals } from './website-migration-bind.js';
import { createWebsiteForMigration, WebsiteMigrationCreateError } from './website-migration-create.js';
import { WebsiteMigrationPolicyError, websiteMigrationPolicyInternals } from './website-migration-policy.js';
import { previewWebsiteMigration } from './website-migration-preview.js';
import { rollbackWebsiteMigrationBinding, WebsiteMigrationRollbackError } from './website-migration-rollback.js';

const BIND_FIELDS = new Set(['domainId', 'websiteId', 'previewDigest', 'confirmation']);
const CREATE_FIELDS = new Set(['domainId', 'applicationId', 'previewDigest', 'confirmation']);
const FINALIZE_FIELDS = new Set(['previewDigest', 'confirmation']);
const ROLLBACK_FIELDS = new Set(['enforcedDigest', 'confirmation']);
const ROLLBACK_BINDING_FIELDS = new Set(['domainId', 'websiteId', 'bindingPreviewDigest', 'confirmation']);

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.has(key))) {
    throw new WebsiteMigrationPolicyError(code, message, 400);
  }
  return body;
}

function digest(value, field = 'previewDigest') {
  if (typeof value !== 'string' || !websiteMigrationPolicyInternals.digestPattern.test(value)) {
    throw new WebsiteMigrationPolicyError('website_migration_preview_digest_invalid', `${field} must be a SHA-256 migration digest`, 400);
  }
  return value;
}

function ids(body, left, right, ErrorType, code) {
  try { return [assertUuid(body[left], left), assertUuid(body[right], right)]; }
  catch { throw new ErrorType(code, `${left} and ${right} must be valid UUIDs`, 400); }
}

function assertBindBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !BIND_FIELDS.has(key))) {
    throw new WebsiteMigrationBindError('website_migration_binding_invalid', 'Send only documented migration binding fields', 400);
  }
  const [domainId, websiteId] = ids(body, 'domainId', 'websiteId', WebsiteMigrationBindError, 'website_migration_binding_invalid');
  if (typeof body.previewDigest !== 'string' || !websiteMigrationBindInternals.digestPattern.test(body.previewDigest)) {
    throw new WebsiteMigrationBindError('website_migration_preview_digest_invalid', 'A current migration preview digest is required', 400);
  }
  const expectedConfirmation = `bind:${domainId}:${websiteId}:${body.previewDigest}`;
  if (body.confirmation !== expectedConfirmation) {
    throw new WebsiteMigrationBindError('website_migration_confirmation_required', `Confirm migration binding with ${expectedConfirmation}`, 400);
  }
  return Object.freeze({ domainId, websiteId, previewDigest: body.previewDigest });
}

function assertCreateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
    throw new WebsiteMigrationCreateError('website_migration_create_invalid', 'Send only documented migration Website creation fields', 400);
  }
  const [domainId, applicationId] = ids(body, 'domainId', 'applicationId', WebsiteMigrationCreateError, 'website_migration_create_invalid');
  if (typeof body.previewDigest !== 'string' || !websiteMigrationBindInternals.digestPattern.test(body.previewDigest)) {
    throw new WebsiteMigrationCreateError('website_migration_preview_digest_invalid', 'A current migration preview digest is required', 400);
  }
  const expectedConfirmation = `create-website:${domainId}:${applicationId}:${body.previewDigest}`;
  if (body.confirmation !== expectedConfirmation) {
    throw new WebsiteMigrationCreateError('website_migration_confirmation_required', `Confirm migration Website creation with ${expectedConfirmation}`, 400);
  }
  return Object.freeze({ domainId, applicationId, previewDigest: body.previewDigest });
}

function assertFinalizeBody(body) {
  const input = exactBody(body, FINALIZE_FIELDS, 'website_migration_finalize_invalid', 'Send only documented migration finalize fields');
  const previewDigest = digest(input.previewDigest);
  const expectedConfirmation = `finalize:${previewDigest}`;
  if (input.confirmation !== expectedConfirmation) {
    throw new WebsiteMigrationPolicyError('website_migration_confirmation_required', `Confirm Website binding enforcement with ${expectedConfirmation}`, 400);
  }
  return Object.freeze({ previewDigest });
}

function assertRollbackBody(body) {
  const input = exactBody(body, ROLLBACK_FIELDS, 'website_migration_rollback_invalid', 'Send only documented migration rollback fields');
  const enforcedDigest = digest(input.enforcedDigest, 'enforcedDigest');
  const expectedConfirmation = `rollback:${enforcedDigest}`;
  if (input.confirmation !== expectedConfirmation) {
    throw new WebsiteMigrationPolicyError('website_migration_confirmation_required', `Confirm Website binding policy rollback with ${expectedConfirmation}`, 400);
  }
  return Object.freeze({ enforcedDigest });
}

function assertRollbackBindingBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !ROLLBACK_BINDING_FIELDS.has(key))) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_invalid', 'Send only documented migration binding rollback fields', 400);
  }
  const [domainId, websiteId] = ids(body, 'domainId', 'websiteId', WebsiteMigrationRollbackError, 'website_migration_rollback_invalid');
  if (typeof body.bindingPreviewDigest !== 'string' || !websiteMigrationBindInternals.digestPattern.test(body.bindingPreviewDigest)) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_invalid', 'A binding preview digest is required', 400);
  }
  const expectedConfirmation = `rollback-binding:${domainId}:${websiteId}:${body.bindingPreviewDigest}`;
  if (body.confirmation !== expectedConfirmation) {
    throw new WebsiteMigrationRollbackError('website_migration_confirmation_required', `Confirm migration binding rollback with ${expectedConfirmation}`, 400);
  }
  return Object.freeze({ domainId, websiteId, bindingPreviewDigest: body.bindingPreviewDigest });
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
  websiteMigrationPolicy,
  migrationLedger,
  preview = previewWebsiteMigration,
  bind = bindLegacyDomainToWebsite,
  create = createWebsiteForMigration,
  rollbackBinding = rollbackWebsiteMigrationBinding,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new Error('Express application is required');
  if (!websiteRegistry || typeof websiteRegistry.listWebsites !== 'function' || typeof websiteRegistry.getWebsite !== 'function'
    || typeof websiteRegistry.createMigrationWebsite !== 'function' || typeof websiteRegistry.deleteMigrationWebsite !== 'function') throw new Error('Website registry is required');
  if (!domainRegistry || typeof domainRegistry.listDomains !== 'function' || typeof domainRegistry.getDomain !== 'function'
    || typeof domainRegistry.bindWebsite !== 'function' || typeof domainRegistry.rollbackWebsiteBinding !== 'function') throw new Error('Domain registry is required');
  if (!applicationRegistry || typeof applicationRegistry.listApplications !== 'function') throw new Error('Application registry is required');
  if (!websiteMigrationPolicy || typeof websiteMigrationPolicy.snapshot !== 'function'
    || typeof websiteMigrationPolicy.finalize !== 'function' || typeof websiteMigrationPolicy.rollback !== 'function') throw new Error('Website migration policy store is required');
  if (!migrationLedger || typeof migrationLedger.list !== 'function' || typeof migrationLedger.get !== 'function'
    || typeof migrationLedger.planWebsiteCreation !== 'function' || typeof migrationLedger.markWebsiteCreated !== 'function'
    || typeof migrationLedger.planBinding !== 'function' || typeof migrationLedger.markBound !== 'function'
    || typeof migrationLedger.beginRollback !== 'function' || typeof migrationLedger.markRolledBack !== 'function') throw new Error('Website migration ledger is required');
  if ([preview, bind, create, rollbackBinding].some((adapter) => typeof adapter !== 'function')) throw new Error('Website migration adapters are required');

  async function currentPreview() {
    const [domains, websites, applications] = await Promise.all([
      domainRegistry.listDomains(), websiteRegistry.listWebsites(), applicationRegistry.listApplications(),
    ]);
    return preview({ domains, websites, applications });
  }

  app.get('/api/websites/migration/preview', requirePanelRouteAccess, asyncRoute(async (_request, response) => response.json({ data: await currentPreview() })));

  app.get('/api/websites/migration/status', requirePanelRouteAccess, asyncRoute(async (_request, response) => {
    const [plan, ledger] = await Promise.all([currentPreview(), migrationLedger.list()]);
    return response.json({ data: { policy: websiteMigrationPolicy.snapshot(), preview: plan, ledger } });
  }));

  app.post('/api/websites/migration/create-website', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = assertCreateBody(request.body);
    const result = await create({ ...input, domainRegistry, websiteRegistry, applicationRegistry, migrationLedger, preview });
    return response.status(result.created ? 201 : 200).json({ data: result });
  }));

  app.post('/api/websites/migration/bind', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = assertBindBody(request.body);
    const result = await bind({ ...input, domainRegistry, websiteRegistry, applicationRegistry, migrationLedger, preview });
    return response.json({ data: result });
  }));

  app.post('/api/websites/migration/finalize', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = assertFinalizeBody(request.body);
    const plan = await currentPreview();
    return response.json({ data: await websiteMigrationPolicy.finalize({ preview: plan, previewDigest: input.previewDigest }) });
  }));

  app.post('/api/websites/migration/rollback', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = assertRollbackBody(request.body);
    return response.json({ data: await websiteMigrationPolicy.rollback(input) });
  }));

  app.post('/api/websites/migration/rollback-binding', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const input = assertRollbackBindingBody(request.body);
    const result = await rollbackBinding({
      ...input,
      websiteMigrationPolicy,
      migrationLedger,
      domainRegistry,
      websiteRegistry,
    });
    return response.json({ data: result });
  }));
}

export const websiteMigrationHttpInternals = Object.freeze({
  assertBindBody,
  assertCreateBody,
  assertFinalizeBody,
  assertRollbackBody,
  assertRollbackBindingBody,
});
