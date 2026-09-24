import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class WebsiteRemovalPlanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteRemovalPlanError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new WebsiteRemovalPlanError(
      'website_removal_preview_invalid',
      `${field} must be a valid 64-character sha256 digest`,
      409,
    );
  }
  return value;
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new WebsiteRemovalPlanError(
      'website_removal_preview_invalid',
      `${field} must be a safe non-empty identifier`,
      409,
    );
  }
  return value;
}

function websiteSnapshot(website) {
  if (!website || typeof website !== 'object' || Array.isArray(website)
    || typeof website.id !== 'string' || !SAFE_ID.test(website.id)
    || typeof website.serverId !== 'string' || !SAFE_ID.test(website.serverId)) {
    throw new WebsiteRemovalPlanError(
      'website_removal_target_invalid',
      'Website removal target is invalid',
      400,
    );
  }
  return Object.freeze({
    id: website.id,
    name: typeof website.name === 'string' ? website.name : website.id,
    serverId: website.serverId,
    applicationId: website.applicationId ?? null,
    systemUser: website.systemUser ?? website.unixUser ?? null,
    unixUser: website.unixUser ?? website.systemUser ?? null,
    state: website.state ?? 'active',
    suspended: Boolean(website.suspended),
    desiredRevision: Number.isSafeInteger(website.desiredRevision) ? website.desiredRevision : 1,
    stagedRevision: Number.isSafeInteger(website.stagedRevision) ? website.stagedRevision : 1,
    appliedRevision: Number.isSafeInteger(website.appliedRevision) ? website.appliedRevision : 1,
  });
}

function normalizedIds(items, field) {
  if (!Array.isArray(items)) {
    throw new WebsiteRemovalPlanError(
      'website_removal_preview_invalid',
      `${field} inventory must be an array`,
      409,
    );
  }
  return Object.freeze(
    [...new Set(items.map((item) => {
      const id = typeof item === 'string' ? item : item?.id;
      return safeId(id, `${field} identifier`);
    }))].sort(),
  );
}

function normalizedBucket(bucket, field) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)
    || !['available', 'unavailable'].includes(bucket.status)
    || !Array.isArray(bucket.items)) {
    throw new WebsiteRemovalPlanError(
      'website_removal_preview_invalid',
      `${field} dependency bucket is invalid`,
      409,
    );
  }
  return Object.freeze({
    status: bucket.status,
    ids: normalizedIds(bucket.items, field),
  });
}

function impactBlockers(impact) {
  if (!Array.isArray(impact?.blockers)) {
    throw new WebsiteRemovalPlanError(
      'website_removal_impact_invalid',
      'Website resource-impact blockers are invalid',
      409,
    );
  }
  return Object.freeze(impact.blockers.map((blocker) => {
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)
      || typeof blocker.code !== 'string' || blocker.code.length < 1) {
      throw new WebsiteRemovalPlanError(
        'website_removal_impact_invalid',
        'Website resource-impact blocker is invalid',
        409,
      );
    }
    return Object.freeze({
      code: blocker.code,
      message: blocker.message ?? null,
      resourceType: blocker.resourceType ?? null,
      count: Number.isSafeInteger(blocker.count) ? blocker.count : null,
    });
  }));
}

function orderDomains(domains) {
  if (!Array.isArray(domains)) return Object.freeze([]);
  // Subdomains (child domains with parentDomainId) should be removed before parent domains
  const subdomains = domains.filter((d) => d.parentDomainId !== null && d.parentDomainId !== undefined);
  const rootDomains = domains.filter((d) => d.parentDomainId === null || d.parentDomainId === undefined);
  return Object.freeze([
    ...subdomains.sort((a, b) => a.id.localeCompare(b.id)),
    ...rootDomains.sort((a, b) => a.id.localeCompare(b.id)),
  ]);
}

function dependencyPlan(dependencies, currentWebsite, application = null) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new WebsiteRemovalPlanError(
      'website_removal_impact_invalid',
      'Website resource-impact dependencies are invalid',
      409,
    );
  }

  const rawDomains = dependencies.domains ?? [];
  const boundDomains = Array.isArray(rawDomains) ? rawDomains : (rawDomains.items ?? []);
  const orderedBoundDomains = orderDomains(boundDomains.map((d) => ({
    id: safeId(typeof d === 'string' ? d : d.id, 'domainId'),
    primaryDomain: typeof d === 'object' && d.primaryDomain ? d.primaryDomain : (d.name ?? d.id),
    parentDomainId: typeof d === 'object' ? (d.parentDomainId ?? null) : null,
  })));

  const additional = Object.freeze({
    databases: normalizedBucket(dependencies.databases, 'database'),
    sftpKeys: normalizedBucket(dependencies.sftpKeys, 'sftpKey'),
    runtimeBindings: normalizedBucket(dependencies.runtimeBindings, 'runtimeBinding'),
    unixIdentities: normalizedBucket(dependencies.unixIdentities, 'unixIdentity'),
    logScopes: normalizedBucket(dependencies.logScopes, 'logScope'),
    crons: normalizedBucket(dependencies.crons, 'cron'),
    backups: normalizedBucket(dependencies.backups, 'backup'),
  });

  const activeJobs = normalizedIds(dependencies.activeJobs ?? [], 'job');

  if (currentWebsite.applicationId !== null) {
    if (!application || typeof application !== 'object' || Array.isArray(application)
      || application.id !== currentWebsite.applicationId || application.serverId !== currentWebsite.serverId
      || !Number.isSafeInteger(application.desiredRevision) || application.desiredRevision < 1) {
      throw new WebsiteRemovalPlanError(
        'website_removal_application_state_invalid',
        'Website Application removal state is invalid',
        409,
      );
    }
  } else if (application !== null && application !== undefined) {
    throw new WebsiteRemovalPlanError('website_removal_application_state_invalid', 'Unexpected Application removal state', 409);
  }

  return Object.freeze({
    domainIds: Object.freeze(orderedBoundDomains.map((d) => d.id)),
    domains: orderedBoundDomains,
    applicationId: currentWebsite.applicationId,
    applicationRevision: currentWebsite.applicationId === null ? null : application.desiredRevision,
    systemUser: currentWebsite.systemUser,
    activeJobIds: activeJobs,
    additional,
  });
}

const ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS = new Set([
  'domains_present',
  'linked_domains_present',
  'child_domains_present',
  'website_binding_present',
  'application_binding_present',
  'database_binding_dependencies_present',
  'sftp_key_dependencies_present',
  'runtime_binding_dependencies_present',
  'unix_identity_dependencies_present',
  'log_scope_dependencies_present',
  'cron_dependencies_present',
  'backup_dependencies_present',
  'impact_apply_not_implemented',
]);

function hardBlockers(blockers, plan) {
  const hard = [];
  for (const blocker of blockers) {
    if (blocker.code === 'active_jobs_present' || blocker.code === 'dependency_inventory_unavailable') {
      hard.push(blocker.code);
      continue;
    }
    if (!ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS.has(blocker.code)) {
      hard.push(blocker.code);
    }
  }

  if (plan.activeJobIds.length > 0 && !hard.includes('active_jobs_present')) {
    hard.push('active_jobs_present');
  }

  for (const [name, bucket] of Object.entries(plan.additional)) {
    if (bucket.status === 'unavailable') {
      hard.push(`${name}_inventory_unavailable`);
    }
  }

  return Object.freeze([...new Set(hard)].sort());
}

export function createWebsiteRemovalPreview({ website, impact } = {}) {
  const currentWebsite = websiteSnapshot(website);
  if (!impact || impact.version !== 1 || impact.resourceType !== 'website'
    || impact.operation !== 'delete' || impact.targetServerId !== null
    || !impact.resource || typeof impact.resource !== 'object'
    || impact.resource.id !== currentWebsite.id
    || impact.resource.serverId !== currentWebsite.serverId) {
    throw new WebsiteRemovalPlanError(
      'website_removal_impact_stale',
      'Website resource-impact evidence does not match current Website state',
      409,
    );
  }

  const impactPreviewDigest = safeDigest(impact.previewDigest, 'impactPreviewDigest');
  const expectedImpactConfirmation = `delete:website:${currentWebsite.id}:${impactPreviewDigest}`;
  if (impact.confirmation !== expectedImpactConfirmation) {
    throw new WebsiteRemovalPlanError(
      'website_removal_impact_invalid',
      'Website resource-impact confirmation is invalid',
      409,
    );
  }

  const blockers = impactBlockers(impact);
  const plan = dependencyPlan(impact.dependencies, currentWebsite, impact.application ?? null);
  const blocking = hardBlockers(blockers, plan);

  const previewCore = Object.freeze({
    version: 1,
    operation: 'website_remove',
    website: currentWebsite,
    impact: Object.freeze({
      previewDigest: impactPreviewDigest,
      confirmation: impact.confirmation,
      blockers: Object.freeze(blockers.map((entry) => entry.code).sort()),
    }),
    plan,
    hardBlockers: blocking,
    readyToStart: blocking.length === 0,
  });

  const previewDigest = digest(previewCore);
  const confirmation = previewCore.readyToStart
    ? `start-website-remove:${currentWebsite.id}:${currentWebsite.desiredRevision}:${previewDigest}`
    : null;

  return Object.freeze({
    ...previewCore,
    previewDigest,
    confirmation,
    sideEffects: false,
  });
}

export const websiteRemovalPlanInternals = Object.freeze({
  digest,
  websiteSnapshot,
  normalizedIds,
  normalizedBucket,
  dependencyPlan,
  hardBlockers,
  orderDomains,
  orchestratableWebsiteImpactBlockers: ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS,
});
