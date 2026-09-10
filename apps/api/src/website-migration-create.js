import { assertUuid } from '@yunpanel/shared';
import { websiteMigrationBindInternals } from './website-migration-bind.js';
import { previewWebsiteMigration } from './website-migration-preview.js';
import { websiteRegistryInternals } from './website-registry.js';

export class WebsiteMigrationCreateError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMigrationCreateError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new WebsiteMigrationCreateError('website_migration_create_invalid', `${field} is invalid`, 400); }
}

function currentDomain(domains, domainId) {
  const domain = domains.find((candidate) => typeof candidate?.id === 'string' && candidate.id.toLowerCase() === domainId) ?? null;
  if (!domain) throw new WebsiteMigrationCreateError('website_migration_domain_not_found', 'Domain is not present in migration state', 404);
  return domain;
}

export async function createWebsiteForMigration({
  domainId,
  applicationId,
  previewDigest,
  domainRegistry,
  websiteRegistry,
  applicationRegistry,
  preview = previewWebsiteMigration,
} = {}) {
  for (const [dependency, methods] of [
    [domainRegistry, ['listDomains']],
    [websiteRegistry, ['listWebsites', 'getWebsite', 'createMigrationWebsite']],
    [applicationRegistry, ['listApplications']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      throw new WebsiteMigrationCreateError('website_migration_dependencies_invalid', 'Website migration dependencies are invalid', 503);
    }
  }
  if (typeof preview !== 'function') throw new WebsiteMigrationCreateError('website_migration_dependencies_invalid', 'Website migration preview is unavailable', 503);
  const normalizedDomainId = uuid(domainId, 'domainId');
  const normalizedApplicationId = uuid(applicationId, 'applicationId');
  if (typeof previewDigest !== 'string' || !websiteMigrationBindInternals.digestPattern.test(previewDigest)) {
    throw new WebsiteMigrationCreateError('website_migration_preview_digest_invalid', 'A current migration preview digest is required', 400);
  }

  const [domains, websites, applications] = await Promise.all([
    domainRegistry.listDomains(),
    websiteRegistry.listWebsites(),
    applicationRegistry.listApplications(),
  ]);
  const domain = currentDomain(domains, normalizedDomainId);
  const expectedWebsiteId = websiteRegistryInternals.migrationWebsiteId(normalizedDomainId, normalizedApplicationId);
  const existing = await websiteRegistry.getWebsite(expectedWebsiteId);
  if (existing) {
    if (existing.serverId !== domain.serverId || existing.applicationId !== normalizedApplicationId || existing.name !== domain.primaryDomain) {
      throw new WebsiteMigrationCreateError('website_migration_create_conflict', 'Existing migration Website does not match current Domain and Application state');
    }
    return Object.freeze({
      created: false,
      website: existing,
      sourcePreviewDigest: previewDigest,
      nextAction: 'rerun_preview_then_bind',
    });
  }

  const plan = preview({ domains, websites, applications });
  if (plan.digest !== previewDigest) {
    throw new WebsiteMigrationCreateError('website_migration_preview_stale', 'Migration state changed after preview');
  }
  const item = plan.items.find((candidate) => candidate.domainId === normalizedDomainId);
  if (!item || item.status !== 'ready' || item.action !== 'create_website_then_bind'
    || item.applicationId !== normalizedApplicationId || item.websiteId !== null) {
    throw new WebsiteMigrationCreateError('website_migration_create_not_ready', 'Migration preview does not authorize Website creation for this mapping');
  }
  if (typeof domain.primaryDomain !== 'string' || !domain.primaryDomain || domain.websiteId != null) {
    throw new WebsiteMigrationCreateError('website_migration_create_not_ready', 'Domain state is no longer eligible for Website creation');
  }

  const website = await websiteRegistry.createMigrationWebsite({
    domainId: normalizedDomainId,
    serverId: domain.serverId,
    name: domain.primaryDomain,
    applicationId: normalizedApplicationId,
  });
  if (!website || website.id !== expectedWebsiteId || website.applicationId !== normalizedApplicationId || website.serverId !== domain.serverId) {
    throw new WebsiteMigrationCreateError('website_migration_create_result_invalid', 'Migration Website creation result is invalid', 503);
  }
  return Object.freeze({
    created: true,
    website,
    sourcePreviewDigest: previewDigest,
    nextAction: 'rerun_preview_then_bind',
  });
}
