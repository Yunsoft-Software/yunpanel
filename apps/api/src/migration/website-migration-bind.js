import { assertUuid } from '@yunpanel/shared';
import { previewWebsiteMigration } from './website-migration-preview.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export class WebsiteMigrationBindError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMigrationBindError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new WebsiteMigrationBindError('website_migration_binding_invalid', `${field} is invalid`, 400); }
}

function digest(value) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new WebsiteMigrationBindError('website_migration_preview_digest_invalid', 'A current migration preview digest is required', 400);
  }
  return value;
}

export async function bindLegacyDomainToWebsite({
  domainId,
  websiteId,
  previewDigest,
  domainRegistry,
  websiteRegistry,
  applicationRegistry,
  migrationLedger,
  preview = previewWebsiteMigration,
} = {}) {
  for (const [dependency, methods] of [
    [domainRegistry, ['listDomains', 'bindWebsite']],
    [websiteRegistry, ['listWebsites']],
    [applicationRegistry, ['listApplications']],
    [migrationLedger, ['get', 'planBinding', 'markBound']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      throw new WebsiteMigrationBindError('website_migration_dependencies_invalid', 'Website migration dependencies are invalid', 503);
    }
  }
  if (typeof preview !== 'function') throw new WebsiteMigrationBindError('website_migration_dependencies_invalid', 'Website migration preview is unavailable', 503);

  const normalizedDomainId = uuid(domainId, 'domainId');
  const normalizedWebsiteId = uuid(websiteId, 'websiteId');
  const expectedDigest = digest(previewDigest);
  const [domains, websites, applications] = await Promise.all([
    domainRegistry.listDomains(),
    websiteRegistry.listWebsites(),
    applicationRegistry.listApplications(),
  ]);
  const plan = preview({ domains, websites, applications });
  const item = plan.items.find((candidate) => candidate.domainId === normalizedDomainId);
  if (!item) throw new WebsiteMigrationBindError('website_migration_domain_not_found', 'Domain is not present in the migration plan', 404);

  if (item.status === 'already_bound') {
    if (item.websiteId !== normalizedWebsiteId) {
      throw new WebsiteMigrationBindError('website_migration_binding_conflict', 'Domain is already bound to a different Website');
    }
    const ledgerEntry = await migrationLedger.get(normalizedDomainId);
    if (ledgerEntry) {
      await migrationLedger.markBound({
        domainId: normalizedDomainId,
        applicationId: item.applicationId,
        websiteId: normalizedWebsiteId,
      });
    }
    const domain = domains.find((candidate) => candidate.id.toLowerCase() === normalizedDomainId);
    return Object.freeze({
      migrated: false,
      domain,
      websiteId: normalizedWebsiteId,
      previewVersion: plan.version,
      previewDigest: plan.digest,
      ledgerTracked: Boolean(ledgerEntry),
    });
  }

  if (plan.digest !== expectedDigest) {
    throw new WebsiteMigrationBindError('website_migration_preview_stale', 'Migration state changed after preview; request a new preview before binding');
  }
  if (item.status !== 'ready' || item.action !== 'bind_existing_website' || item.websiteId !== normalizedWebsiteId || !item.applicationId) {
    throw new WebsiteMigrationBindError('website_migration_binding_not_ready', 'Migration preview does not authorize this existing Website binding');
  }

  const existingLedger = await migrationLedger.get(normalizedDomainId);
  const createdWebsite = existingLedger?.createdWebsite === true;
  await migrationLedger.planBinding({
    domainId: normalizedDomainId,
    applicationId: item.applicationId,
    websiteId: normalizedWebsiteId,
    previewDigest: expectedDigest,
    createdWebsite,
  });

  const domain = await domainRegistry.bindWebsite(normalizedDomainId, normalizedWebsiteId);
  if (!domain || domain.id !== normalizedDomainId || domain.websiteId !== normalizedWebsiteId) {
    throw new WebsiteMigrationBindError('website_migration_binding_result_invalid', 'Domain Website binding result is invalid', 503);
  }
  await migrationLedger.markBound({
    domainId: normalizedDomainId,
    applicationId: item.applicationId,
    websiteId: normalizedWebsiteId,
  });
  return Object.freeze({
    migrated: true,
    domain,
    websiteId: normalizedWebsiteId,
    previewVersion: plan.version,
    previewDigest: plan.digest,
    ledgerTracked: true,
  });
}

export const websiteMigrationBindInternals = Object.freeze({ digestPattern: DIGEST_PATTERN });
