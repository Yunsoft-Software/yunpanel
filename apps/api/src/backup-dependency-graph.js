const GRAPH_VERSION = 1;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const RESOURCE_TYPES = new Set(['application', 'database', 'docker_storage', 'mail_data']);
const MAX_ITEMS = 8192;

export class BackupDependencyGraphError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupDependencyGraphError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BackupDependencyGraphError('backup_dependency_state_invalid', `${label} is invalid`, 409);
  }
  return value.toLowerCase();
}

function revision(value, label, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) {
    throw new BackupDependencyGraphError('backup_dependency_state_invalid', `${label} revision is invalid`, 409);
  }
  return value;
}

function boundedArray(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new BackupDependencyGraphError('backup_dependency_state_invalid', `${label} inventory is invalid`, 409);
  }
  return value;
}

function reference(type, id, revisionValue, appliedRevision = null) {
  return Object.freeze({
    type,
    id,
    revision: revisionValue,
    ...(appliedRevision === null ? {} : { appliedRevision }),
  });
}

function websiteReference(website, serverId) {
  if (!website || typeof website !== 'object' || Array.isArray(website)
    || website.serverId !== serverId) {
    throw new BackupDependencyGraphError('backup_dependency_website_invalid', 'Website dependency state is invalid', 409);
  }
  return Object.freeze({
    id: uuid(website.id, 'websiteId'),
    revision: revision(website.revision, 'Website'),
    applicationId: website.applicationId === null || website.applicationId === undefined
      ? null : uuid(website.applicationId, 'applicationId'),
    dockerProjectId: website.managedComposeBinding?.projectId === undefined
      ? null : uuid(website.managedComposeBinding.projectId, 'dockerProjectId'),
  });
}

function domainReference(domain, serverId) {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)
    || domain.serverId !== serverId) {
    throw new BackupDependencyGraphError('backup_dependency_domain_invalid', 'Domain dependency state is invalid', 409);
  }
  return Object.freeze({
    id: uuid(domain.id, 'domainId'),
    websiteId: domain.websiteId === null || domain.websiteId === undefined
      ? null : uuid(domain.websiteId, 'websiteId'),
    desiredRevision: revision(domain.desiredRevision, 'Domain desired'),
    appliedRevision: revision(domain.appliedRevision, 'Domain applied', { zero: true }),
  });
}

function databaseBindingReference(binding, serverId) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || binding.serverId !== serverId
    || typeof binding.databaseName !== 'string' || binding.databaseName.length < 1 || binding.databaseName.length > 64) {
    throw new BackupDependencyGraphError('backup_dependency_database_binding_invalid', 'Database binding dependency state is invalid', 409);
  }
  return Object.freeze({
    id: uuid(binding.id, 'databaseBindingId'),
    revision: revision(binding.revision, 'Database binding'),
    databaseName: binding.databaseName,
    websiteId: uuid(binding.websiteId, 'websiteId'),
    applicationId: uuid(binding.applicationId, 'applicationId'),
  });
}

function mailDomainReference(mailDomain) {
  if (!mailDomain || typeof mailDomain !== 'object' || Array.isArray(mailDomain)
    || mailDomain.managementMode !== 'local'
    || typeof mailDomain.webDomainId !== 'string') {
    throw new BackupDependencyGraphError('backup_dependency_mail_domain_invalid', 'Mail Domain dependency state is invalid', 409);
  }
  return Object.freeze({
    id: uuid(mailDomain.id, 'mailDomainId'),
    revision: revision(mailDomain.revision, 'Mail Domain'),
    webDomainId: uuid(mailDomain.webDomainId, 'domainId'),
  });
}

function resourceRecord(resource, serverId) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)
    || typeof resource.identity !== 'string' || !RESOURCE_ID_PATTERN.test(resource.identity)
    || typeof resource.type !== 'string' || !RESOURCE_TYPES.has(resource.type)
    || resource.serverId !== serverId) {
    throw new BackupDependencyGraphError('backup_dependency_resource_invalid', 'Backup resource dependency identity is invalid', 409);
  }
  return resource;
}

function uniqueSorted(values) {
  return Object.freeze([...new Set(values)].sort());
}

function sortedReferences(values) {
  const ordered = [...values].sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  const keys = ordered.map((entry) => `${entry.type}:${entry.id}`);
  if (new Set(keys).size !== keys.length) {
    throw new BackupDependencyGraphError('backup_dependency_reference_duplicate', 'Backup dependency references are duplicated', 409);
  }
  return Object.freeze(ordered);
}

export function createBackupDependencyGraph({
  serverId,
  resources,
  websites = [],
  domains = [],
  databaseBindings = [],
  mailDomains = [],
} = {}) {
  const scopedServerId = uuid(serverId, 'serverId');
  const normalizedResources = boundedArray(resources, 'Backup resource')
    .map((resource) => resourceRecord(resource, scopedServerId));
  if (new Set(normalizedResources.map((resource) => resource.identity)).size !== normalizedResources.length) {
    throw new BackupDependencyGraphError('backup_dependency_resource_duplicate', 'Backup dependency resources are duplicated', 409);
  }
  const applicationIds = new Set(normalizedResources
    .filter((resource) => resource.type === 'application')
    .map((resource) => resource.applicationId));
  const databaseNames = new Set(normalizedResources
    .filter((resource) => resource.type === 'database')
    .map((resource) => resource.databaseName.toLowerCase()));
  const mailResourceIds = new Set(normalizedResources
    .filter((resource) => resource.type === 'mail_data' && resource.scope === 'domain')
    .map((resource) => resource.mailDomainId));

  const websiteList = boundedArray(websites, 'Website')
    .filter((website) => website?.serverId === scopedServerId)
    .map((website) => websiteReference(website, scopedServerId))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(websiteList.map((website) => website.id)).size !== websiteList.length) {
    throw new BackupDependencyGraphError('backup_dependency_website_duplicate', 'Website dependency identities are duplicated', 409);
  }
  const websiteById = new Map(websiteList.map((website) => [website.id, website]));
  for (const website of websiteList) {
    if (website.applicationId !== null && !applicationIds.has(website.applicationId)) {
      throw new BackupDependencyGraphError('backup_dependency_application_missing', 'Website Application backup dependency is unavailable', 409);
    }
  }

  const domainList = boundedArray(domains, 'Domain')
    .filter((domain) => domain?.serverId === scopedServerId)
    .map((domain) => domainReference(domain, scopedServerId))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(domainList.map((domain) => domain.id)).size !== domainList.length) {
    throw new BackupDependencyGraphError('backup_dependency_domain_duplicate', 'Domain dependency identities are duplicated', 409);
  }
  for (const domain of domainList) {
    if (domain.websiteId !== null && !websiteById.has(domain.websiteId)) {
      throw new BackupDependencyGraphError('backup_dependency_website_missing', 'Domain Website dependency is unavailable', 409);
    }
  }
  const domainsByWebsite = new Map();
  for (const domain of domainList) {
    if (domain.websiteId === null) continue;
    const bucket = domainsByWebsite.get(domain.websiteId) ?? [];
    bucket.push(domain);
    domainsByWebsite.set(domain.websiteId, bucket);
  }

  const bindingList = boundedArray(databaseBindings, 'Database binding')
    .filter((binding) => binding?.serverId === scopedServerId)
    .map((binding) => databaseBindingReference(binding, scopedServerId))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(bindingList.map((binding) => binding.id)).size !== bindingList.length) {
    throw new BackupDependencyGraphError('backup_dependency_database_binding_duplicate', 'Database binding identities are duplicated', 409);
  }
  for (const binding of bindingList) {
    const website = websiteById.get(binding.websiteId);
    if (!website || website.applicationId !== binding.applicationId) {
      throw new BackupDependencyGraphError('backup_dependency_database_binding_stale', 'Database binding ownership is stale', 409);
    }
    if (!databaseNames.has(binding.databaseName.toLowerCase())) {
      throw new BackupDependencyGraphError('backup_dependency_database_resource_missing', 'Bound database backup resource is unavailable', 409);
    }
  }

  const mailDomainList = boundedArray(mailDomains, 'Mail Domain')
    .filter((mailDomain) => mailDomain?.managementMode === 'local' && typeof mailDomain.webDomainId === 'string')
    .map(mailDomainReference)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(mailDomainList.map((mailDomain) => mailDomain.id)).size !== mailDomainList.length) {
    throw new BackupDependencyGraphError('backup_dependency_mail_domain_duplicate', 'Mail Domain identities are duplicated', 409);
  }
  const domainById = new Map(domainList.map((domain) => [domain.id, domain]));
  for (const mailDomain of mailDomainList) {
    if (!domainById.has(mailDomain.webDomainId)) {
      throw new BackupDependencyGraphError('backup_dependency_mail_domain_stale', 'Mail Domain web-domain dependency is unavailable', 409);
    }
    if (!mailResourceIds.has(mailDomain.id)) {
      throw new BackupDependencyGraphError('backup_dependency_mail_resource_missing', 'Mail Domain backup resource is unavailable', 409);
    }
  }

  const impacts = [];
  for (const resource of normalizedResources.sort((left, right) => left.identity.localeCompare(right.identity))) {
    const websiteIds = [];
    const domainIds = [];
    const references = [];

    if (resource.type === 'application') {
      for (const website of websiteList.filter((candidate) => candidate.applicationId === resource.applicationId)) {
        websiteIds.push(website.id);
        references.push(reference('website', website.id, website.revision));
        for (const domain of domainsByWebsite.get(website.id) ?? []) {
          domainIds.push(domain.id);
          references.push(reference('domain', domain.id, domain.desiredRevision, domain.appliedRevision));
        }
      }
    } else if (resource.type === 'database') {
      const binding = bindingList.find((candidate) => candidate.databaseName.toLowerCase() === resource.databaseName.toLowerCase()) ?? null;
      if (binding) {
        websiteIds.push(binding.websiteId);
        references.push(reference('database_binding', binding.id, binding.revision));
        const website = websiteById.get(binding.websiteId);
        references.push(reference('website', website.id, website.revision));
        for (const domain of domainsByWebsite.get(website.id) ?? []) {
          domainIds.push(domain.id);
          references.push(reference('domain', domain.id, domain.desiredRevision, domain.appliedRevision));
        }
      }
    } else if (resource.type === 'docker_storage') {
      for (const website of websiteList.filter((candidate) => candidate.dockerProjectId === resource.projectId)) {
        websiteIds.push(website.id);
        references.push(reference('website', website.id, website.revision));
        for (const domain of domainsByWebsite.get(website.id) ?? []) {
          domainIds.push(domain.id);
          references.push(reference('domain', domain.id, domain.desiredRevision, domain.appliedRevision));
        }
      }
    } else if (resource.type === 'mail_data') {
      const mailDomain = mailDomainList.find((candidate) => candidate.id === resource.mailDomainId) ?? null;
      if (!mailDomain || resource.scope !== 'domain' || resource.resourceId !== mailDomain.id) {
        throw new BackupDependencyGraphError('backup_dependency_mail_resource_stale', 'Mail backup resource dependency is stale', 409);
      }
      references.push(reference('mail_domain', mailDomain.id, mailDomain.revision));
      const domain = domainById.get(mailDomain.webDomainId);
      domainIds.push(domain.id);
      references.push(reference('domain', domain.id, domain.desiredRevision, domain.appliedRevision));
      if (domain.websiteId !== null) {
        const website = websiteById.get(domain.websiteId);
        websiteIds.push(website.id);
        references.push(reference('website', website.id, website.revision));
      }
    }

    impacts.push(Object.freeze({
      resourceIdentity: resource.identity,
      resourceType: resource.type,
      websiteIds: uniqueSorted(websiteIds),
      domainIds: uniqueSorted(domainIds),
      references: sortedReferences(references),
    }));
  }

  const associated = impacts.filter((impact) => impact.websiteIds.length > 0 || impact.domainIds.length > 0).length;
  const associatedWebsiteIds = new Set(impacts.flatMap((impact) => impact.websiteIds));
  const associatedDomainIds = new Set(impacts.flatMap((impact) => impact.domainIds));
  return Object.freeze({
    version: GRAPH_VERSION,
    serverId: scopedServerId,
    impacts: Object.freeze(impacts),
    counts: Object.freeze({
      resources: impacts.length,
      associatedResources: associated,
      websites: associatedWebsiteIds.size,
      domains: associatedDomainIds.size,
    }),
  });
}

export const backupDependencyGraphInternals = Object.freeze({
  graphVersion: GRAPH_VERSION,
  maxItems: MAX_ITEMS,
  uuid,
  websiteReference,
  domainReference,
  databaseBindingReference,
  mailDomainReference,
  reference,
});
