import { assertUuid } from '@yunpanel/shared';
import { websiteMigrationLedgerInternals } from './website-migration-ledger.js';

export class WebsiteMigrationRollbackError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMigrationRollbackError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new WebsiteMigrationRollbackError('website_migration_rollback_invalid', `${field} is invalid`, 400); }
}

function digest(value) {
  if (typeof value !== 'string' || !websiteMigrationLedgerInternals.digestPattern.test(value)) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_invalid', 'bindingPreviewDigest is invalid', 400);
  }
  return value;
}

export async function rollbackWebsiteMigrationBinding({
  domainId,
  websiteId,
  bindingPreviewDigest,
  websiteMigrationPolicy,
  migrationLedger,
  domainRegistry,
  websiteRegistry,
} = {}) {
  for (const [dependency, methods] of [
    [websiteMigrationPolicy, ['snapshot']],
    [migrationLedger, ['get', 'beginRollback', 'markRolledBack']],
    [domainRegistry, ['getDomain', 'listDomains', 'rollbackWebsiteBinding']],
    [websiteRegistry, ['getWebsite', 'deleteMigrationWebsite']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      throw new WebsiteMigrationRollbackError('website_migration_rollback_dependencies_invalid', 'Website migration rollback dependencies are invalid', 503);
    }
  }

  const normalizedDomainId = uuid(domainId, 'domainId');
  const normalizedWebsiteId = uuid(websiteId, 'websiteId');
  const approvedDigest = digest(bindingPreviewDigest);
  const policy = websiteMigrationPolicy.snapshot();
  if (policy?.mode !== 'compatibility' || policy.websiteBindingRequired === true) {
    throw new WebsiteMigrationRollbackError('website_migration_policy_rollback_required', 'Return Website binding policy to compatibility before rolling back individual bindings');
  }

  const entry = await migrationLedger.get(normalizedDomainId);
  if (!entry) throw new WebsiteMigrationRollbackError('website_migration_rollback_not_tracked', 'Domain binding was not created by the Website migration ledger', 404);
  if (entry.websiteId !== normalizedWebsiteId || entry.bindingPreviewDigest !== approvedDigest) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_identity_mismatch', 'Rollback identity does not match the migration ledger');
  }
  if (!['bound', 'rolling_back', 'rolled_back'].includes(entry.state)) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_not_ready', 'Only completed migration bindings can be rolled back');
  }

  const domain = await domainRegistry.getDomain(normalizedDomainId);
  if (!domain) throw new WebsiteMigrationRollbackError('website_migration_domain_not_found', 'Domain no longer exists', 404);

  if (entry.state === 'rolled_back') {
    if (domain.websiteId !== null) throw new WebsiteMigrationRollbackError('website_migration_rollback_state_drift', 'Rolled-back Domain unexpectedly has a Website binding');
    if (entry.createdWebsite && await websiteRegistry.getWebsite(normalizedWebsiteId)) {
      throw new WebsiteMigrationRollbackError('website_migration_rollback_state_drift', 'Rolled-back migration Website unexpectedly still exists');
    }
    return Object.freeze({ rolledBack: false, domain, websiteDeleted: entry.createdWebsite, ledger: entry });
  }

  if (entry.state === 'bound' && domain.websiteId !== normalizedWebsiteId) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_state_drift', 'Domain binding drifted before rollback began');
  }
  if (entry.state === 'rolling_back' && domain.websiteId !== null && domain.websiteId !== normalizedWebsiteId) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_state_drift', 'Domain binding changed during rollback');
  }

  const rolling = entry.state === 'rolling_back'
    ? entry
    : await migrationLedger.beginRollback({ domainId: normalizedDomainId, websiteId: normalizedWebsiteId });

  let currentDomain = domain;
  if (currentDomain.websiteId === normalizedWebsiteId) {
    currentDomain = await domainRegistry.rollbackWebsiteBinding(normalizedDomainId, normalizedWebsiteId);
  }
  if (currentDomain.websiteId !== null) {
    throw new WebsiteMigrationRollbackError('website_migration_rollback_result_invalid', 'Domain Website relationship did not roll back', 503);
  }

  let websiteDeleted = false;
  if (rolling.createdWebsite) {
    const domains = await domainRegistry.listDomains();
    const inUse = domains.some((candidate) => candidate.id !== normalizedDomainId && candidate.websiteId === normalizedWebsiteId);
    if (inUse) {
      throw new WebsiteMigrationRollbackError('website_migration_rollback_website_in_use', 'Migration Website is still referenced by another Domain');
    }
    const deletion = await websiteRegistry.deleteMigrationWebsite({
      domainId: normalizedDomainId,
      applicationId: rolling.applicationId,
      websiteId: normalizedWebsiteId,
      serverId: currentDomain.serverId,
      name: currentDomain.primaryDomain,
    });
    websiteDeleted = deletion.deleted === true || await websiteRegistry.getWebsite(normalizedWebsiteId) === null;
    if (!websiteDeleted) throw new WebsiteMigrationRollbackError('website_migration_rollback_result_invalid', 'Migration Website was not removed', 503);
  }

  const ledger = await migrationLedger.markRolledBack({ domainId: normalizedDomainId, websiteId: normalizedWebsiteId });
  return Object.freeze({ rolledBack: true, domain: currentDomain, websiteDeleted, ledger });
}
