import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WebsiteMigrationPreviewError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMigrationPreviewError';
    this.code = code;
    this.status = status;
  }
}

function id(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WebsiteMigrationPreviewError('website_migration_state_invalid', `${field} is invalid`);
  }
  return value.toLowerCase();
}

function uniqueById(values, label) {
  if (!Array.isArray(values)) throw new WebsiteMigrationPreviewError('website_migration_state_invalid', `${label} state must be an array`);
  const map = new Map();
  for (const value of values) {
    const key = id(value?.id, `${label} id`);
    if (map.has(key)) throw new WebsiteMigrationPreviewError('website_migration_state_invalid', `${label} IDs must be unique`);
    map.set(key, value);
  }
  return map;
}

function normalizeApplications(values) {
  const raw = uniqueById(values, 'Application');
  return new Map([...raw].map(([key, value]) => [key, { ...value, id: key, serverId: id(value.serverId, 'Application serverId') }]));
}

function normalizeWebsites(values) {
  const raw = uniqueById(values, 'Website');
  return new Map([...raw].map(([key, value]) => [key, {
    ...value,
    id: key,
    serverId: id(value.serverId, 'Website serverId'),
    applicationId: value.applicationId == null ? null : id(value.applicationId, 'Website applicationId'),
  }]));
}

function applicationMatchesDomain(application, domain) {
  if (!application || application.serverId !== domain.serverId) return false;
  if (domain.targetType === 'static') {
    return application.type === 'static'
      && typeof domain.target?.root === 'string'
      && application.webRoot === domain.target.root;
  }
  if (domain.targetType === 'proxy') {
    return application.type === 'node'
      && application.proxyTarget?.host === '127.0.0.1'
      && Number.isInteger(application.proxyTarget?.port)
      && application.proxyTarget.port === domain.target?.upstreamPort;
  }
  return false;
}

function validateWebsiteReferences(websites, applications) {
  const byApplication = new Map();
  for (const website of websites.values()) {
    if (website.applicationId == null) continue;
    const application = applications.get(website.applicationId);
    if (!application || application.serverId !== website.serverId) {
      throw new WebsiteMigrationPreviewError('website_migration_state_invalid', 'Website application reference is inconsistent');
    }
    if (byApplication.has(website.applicationId)) {
      throw new WebsiteMigrationPreviewError('website_migration_state_invalid', 'Application is bound to multiple Websites');
    }
    byApplication.set(website.applicationId, website);
  }
  return byApplication;
}

function previewDigest(items) {
  const canonical = [...items]
    .sort((left, right) => left.domainId.localeCompare(right.domainId))
    .map((item) => ({
      domainId: item.domainId,
      hostname: item.hostname,
      status: item.status,
      action: item.action,
      websiteId: item.websiteId,
      applicationId: item.applicationId,
      candidateApplicationIds: [...item.candidateApplicationIds],
      requiresConfirmation: item.requiresConfirmation,
    }));
  return createHash('sha256').update(JSON.stringify({ version: 1, items: canonical })).digest('hex');
}

export function previewWebsiteMigration({ domains, websites, applications } = {}) {
  const domainMap = uniqueById(domains, 'Domain');
  const websiteMap = normalizeWebsites(websites);
  const applicationMap = normalizeApplications(applications);
  const websiteByApplication = validateWebsiteReferences(websiteMap, applicationMap);
  const items = [];

  for (const raw of domainMap.values()) {
    const domainId = id(raw.id, 'Domain id');
    const serverId = id(raw.serverId, 'Domain serverId');
    const domain = { ...raw, id: domainId, serverId };
    if (!['static', 'proxy'].includes(domain.targetType) || !domain.target || typeof domain.target !== 'object' || Array.isArray(domain.target)) {
      throw new WebsiteMigrationPreviewError('website_migration_state_invalid', 'Domain target state is invalid');
    }

    if (domain.websiteId != null) {
      const websiteId = id(domain.websiteId, 'Domain websiteId');
      const website = websiteMap.get(websiteId);
      if (!website || website.serverId !== serverId) {
        throw new WebsiteMigrationPreviewError('website_migration_bound_reference_invalid', 'Bound Domain Website reference is invalid');
      }
      items.push(Object.freeze({
        domainId, hostname: domain.primaryDomain ?? null, status: 'already_bound', action: 'none', websiteId,
        applicationId: website.applicationId, candidateApplicationIds: Object.freeze([]), requiresConfirmation: false,
      }));
      continue;
    }

    const candidates = [...applicationMap.values()]
      .filter((application) => applicationMatchesDomain(application, domain))
      .map((application) => application.id)
      .sort();

    if (candidates.length === 0) {
      items.push(Object.freeze({
        domainId, hostname: domain.primaryDomain ?? null, status: 'unresolved', action: 'manual_mapping_required',
        websiteId: null, applicationId: null, candidateApplicationIds: Object.freeze([]), requiresConfirmation: true,
      }));
      continue;
    }

    if (candidates.length > 1) {
      items.push(Object.freeze({
        domainId, hostname: domain.primaryDomain ?? null, status: 'ambiguous', action: 'manual_mapping_required',
        websiteId: null, applicationId: null, candidateApplicationIds: Object.freeze(candidates), requiresConfirmation: true,
      }));
      continue;
    }

    const applicationId = candidates[0];
    const existingWebsite = websiteByApplication.get(applicationId) ?? null;
    items.push(Object.freeze({
      domainId,
      hostname: domain.primaryDomain ?? null,
      status: 'ready',
      action: existingWebsite ? 'bind_existing_website' : 'create_website_then_bind',
      websiteId: existingWebsite?.id ?? null,
      applicationId,
      candidateApplicationIds: Object.freeze([applicationId]),
      requiresConfirmation: true,
    }));
  }

  const counts = Object.freeze({
    total: items.length,
    alreadyBound: items.filter((item) => item.status === 'already_bound').length,
    ready: items.filter((item) => item.status === 'ready').length,
    ambiguous: items.filter((item) => item.status === 'ambiguous').length,
    unresolved: items.filter((item) => item.status === 'unresolved').length,
  });
  const digest = previewDigest(items);
  return Object.freeze({ version: 1, digest, destructive: false, autoApply: false, counts, items: Object.freeze(items) });
}

export const websiteMigrationPreviewInternals = Object.freeze({ applicationMatchesDomain, previewDigest });
