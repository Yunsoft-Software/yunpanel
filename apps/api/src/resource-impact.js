import { createHash } from 'node:crypto';
import { assertUuid } from '@yunpanel/shared';

const OPERATIONS = new Set(['delete', 'move']);
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);
const ADDITIONAL_TYPES = Object.freeze([
  ['mailboxes', 'mailbox'],
  ['backups', 'backup'],
  ['crons', 'cron'],
  ['dockerWorkloads', 'docker'],
]);
const SAFE_RESOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_REFERENCE_ID = /^[A-Za-z0-9._:@-]{1,160}$/;
const SAFE_REFERENCE_STATE = /^[A-Za-z0-9._:-]{1,80}$/;

export class ResourceImpactError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ResourceImpactError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new ResourceImpactError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} must be a UUID`); }
}

function resourceIdentity(value, resourceType) {
  if (resourceType === 'website') return uuid(value, 'websiteId');
  if (typeof value !== 'string' || !SAFE_RESOURCE_ID.test(value)) {
    throw new ResourceImpactError('invalid_domain_id', 'domainId is invalid');
  }
  return value;
}

function operationInput(operation, targetServerId) {
  if (!OPERATIONS.has(operation)) throw new ResourceImpactError('impact_operation_invalid', 'Impact operation must be delete or move');
  if (operation === 'delete') {
    if (targetServerId !== null && targetServerId !== undefined) {
      throw new ResourceImpactError('impact_target_not_applicable', 'Delete impact does not accept a target server');
    }
    return Object.freeze({ operation, targetServerId: null });
  }
  return Object.freeze({ operation, targetServerId: uuid(targetServerId, 'targetServerId') });
}

function domainReference(domain) {
  return Object.freeze({
    id: domain.id,
    serverId: domain.serverId,
    websiteId: domain.websiteId ?? null,
    primaryDomain: domain.primaryDomain,
    aliases: Object.freeze([...(domain.aliases ?? [])].sort()),
    parentDomainId: domain.parentDomainId ?? null,
    targetType: domain.targetType,
    state: domain.state,
    httpsMode: domain.httpsMode,
    certificateId: domain.certificateId ?? null,
    desiredRevision: domain.desiredRevision,
    appliedRevision: domain.appliedRevision,
  });
}

function websiteReference(website) {
  return Object.freeze({
    id: website.id,
    serverId: website.serverId,
    name: website.name,
    applicationId: website.applicationId ?? null,
    dockerWorkloadId: website.dockerWorkloadId ?? null,
    runtimeType: website.runtimeType,
    revision: website.revision,
  });
}

function applicationReference(application) {
  if (!application) return null;
  return Object.freeze({
    id: application.id,
    serverId: application.serverId,
    name: application.name,
    type: application.type,
    state: application.state,
    currentReleaseId: application.currentReleaseId ?? null,
    activeDeploymentId: application.activeDeploymentId ?? null,
  });
}

function certificateReference(certificate) {
  return Object.freeze({
    id: certificate.id,
    domainId: certificate.domainId,
    serverId: certificate.serverId,
    state: certificate.state,
    staging: certificate.staging === true,
    validTo: certificate.validTo ?? null,
  });
}

function jobReference(job) {
  return Object.freeze({
    id: job.id,
    serverId: job.serverId,
    type: job.type,
    operation: job.operation,
    resourceType: job.resourceType,
    resourceId: job.resourceId,
    status: job.status,
  });
}

function externalLifecycleReference(resource, nameField) {
  return Object.freeze({
    id: resource.id,
    [nameField]: resource[nameField],
    webDomainId: resource.webDomainId,
    status: resource.status,
    revision: resource.revision,
  });
}

function descendants(domains, rootIds) {
  const roots = new Set(rootIds);
  const visited = new Set(rootIds);
  const pending = [...rootIds];
  const result = [];
  while (pending.length > 0) {
    const parentId = pending.shift();
    for (const domain of domains) {
      if ((domain.parentDomainId ?? null) !== parentId || visited.has(domain.id)) continue;
      visited.add(domain.id);
      pending.push(domain.id);
      if (!roots.has(domain.id)) result.push(domainReference(domain));
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizeAdditionalReference(value, type) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['id', 'state'].includes(key))
    || typeof value.id !== 'string' || !SAFE_REFERENCE_ID.test(value.id)
    || (value.state !== null && value.state !== undefined
      && (typeof value.state !== 'string' || !SAFE_REFERENCE_STATE.test(value.state)))) {
    throw new ResourceImpactError(`${type}_impact_invalid`, `${type} impact provider returned invalid metadata`, 503);
  }
  return Object.freeze({ id: value.id, state: value.state ?? null });
}

async function additionalBucket(provider, type, context) {
  if (provider === null || provider === undefined) {
    return Object.freeze({ status: 'unavailable', items: Object.freeze([]) });
  }
  if (typeof provider !== 'function') {
    throw new ResourceImpactError('impact_dependencies_invalid', 'Impact dependency providers are invalid', 503);
  }
  let values;
  try { values = await provider(context); }
  catch { throw new ResourceImpactError(`${type}_impact_unavailable`, `${type} impact inventory is unavailable`, 503); }
  if (!Array.isArray(values) || values.length > 500) {
    throw new ResourceImpactError(`${type}_impact_invalid`, `${type} impact provider returned invalid metadata`, 503);
  }
  const items = values.map((value) => sanitizeAdditionalReference(value, type))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new ResourceImpactError(`${type}_impact_invalid`, `${type} impact provider returned duplicate identities`, 503);
  }
  return Object.freeze({ status: 'available', items: Object.freeze(items) });
}

function blocker(code, resourceType, count = null) {
  return Object.freeze({ code, resourceType, count });
}

function knownBlockers({ linkedDomains, childDomains, website, application, certificates, activeJobs }) {
  const blockers = [];
  if (linkedDomains.length > 0) blockers.push(blocker('linked_domains_present', 'domain', linkedDomains.length));
  if (childDomains.length > 0) blockers.push(blocker('child_domains_present', 'domain', childDomains.length));
  if (website) blockers.push(blocker('website_binding_present', 'website', 1));
  if (application) blockers.push(blocker('application_binding_present', 'application', 1));
  if (certificates.length > 0) blockers.push(blocker('certificates_present', 'certificate', certificates.length));
  if (activeJobs.length > 0) blockers.push(blocker('active_jobs_present', 'job', activeJobs.length));
  return blockers;
}

function relevantJobs(jobs, { domainIds, applicationId, dockerWorkloadId, certificateIds }) {
  const domains = new Set(domainIds);
  const certificates = new Set(certificateIds);
  return jobs.filter((job) => ACTIVE_JOB_STATES.has(job.status) && (
    (job.resourceType === 'domain' && domains.has(job.resourceId))
    || (job.resourceType === 'application' && job.resourceId === applicationId)
    || (job.resourceType === 'docker_workload' && job.resourceId === dockerWorkloadId)
    || (job.resourceType === 'certificate' && certificates.has(job.resourceId))
  )).map(jobReference).sort((left, right) => left.id.localeCompare(right.id));
}

export async function previewResourceImpact({
  resourceType,
  resourceId,
  operation,
  targetServerId = null,
  registry,
  applicationRegistry,
  websiteRegistry,
  domainRegistry,
  certificateRegistry,
  jobRegistry,
  dnsHostingRegistry,
  mailDomainRegistry,
  additionalProviders = {},
} = {}) {
  if (!['website', 'domain'].includes(resourceType)) {
    throw new ResourceImpactError('impact_resource_type_invalid', 'Impact resource type must be website or domain');
  }
  const dependencies = [
    [registry, ['getServer']],
    [applicationRegistry, ['getApplication']],
    [websiteRegistry, ['getWebsite']],
    [domainRegistry, ['getDomain', 'listDomains']],
    [certificateRegistry, ['listCertificates']],
    [jobRegistry, ['listJobs']],
    [dnsHostingRegistry, ['listZones']],
    [mailDomainRegistry, ['listMailDomains']],
  ];
  if (dependencies.some(([dependency, methods]) => !dependency
    || methods.some((method) => typeof dependency[method] !== 'function'))
    || !additionalProviders || typeof additionalProviders !== 'object' || Array.isArray(additionalProviders)
    || Object.keys(additionalProviders).some((key) => !ADDITIONAL_TYPES.some(([allowed]) => allowed === key))) {
    throw new ResourceImpactError('impact_dependencies_invalid', 'Impact preview dependencies are unavailable', 503);
  }
  const normalizedResourceId = resourceIdentity(resourceId, resourceType);
  const requested = operationInput(operation, targetServerId);
  const [domains, certificates, jobs, allDnsZones, allMailDomains] = await Promise.all([
    domainRegistry.listDomains(),
    certificateRegistry.listCertificates(),
    jobRegistry.listJobs(),
    dnsHostingRegistry.listZones(),
    mailDomainRegistry.listMailDomains(),
  ]);

  let resource;
  let linkedDomains = [];
  let childDomains = [];
  let website = null;
  if (resourceType === 'website') {
    website = await websiteRegistry.getWebsite(normalizedResourceId);
    if (!website) throw new ResourceImpactError('website_not_found', 'Website not found', 404);
    resource = websiteReference(website);
    linkedDomains = domains.filter((domain) => domain.websiteId === website.id)
      .map(domainReference).sort((left, right) => left.id.localeCompare(right.id));
    childDomains = descendants(domains, linkedDomains.map((domain) => domain.id));
  } else {
    const domain = await domainRegistry.getDomain(normalizedResourceId);
    if (!domain) throw new ResourceImpactError('domain_not_found', 'Domain not found', 404);
    resource = domainReference(domain);
    childDomains = descendants(domains, [domain.id]);
    website = domain.websiteId ? await websiteRegistry.getWebsite(domain.websiteId) : null;
    if (domain.websiteId && !website) {
      throw new ResourceImpactError('impact_website_reference_missing', 'Domain Website reference is unavailable', 409);
    }
  }

  if (requested.operation === 'move') {
    if (requested.targetServerId === resource.serverId) {
      throw new ResourceImpactError('impact_move_no_changes', 'Resource already belongs to the target server', 409);
    }
    if (!(await registry.getServer(requested.targetServerId))) {
      throw new ResourceImpactError('target_server_not_found', 'Target server does not exist', 404);
    }
  }

  const application = website?.applicationId
    ? await applicationRegistry.getApplication(website.applicationId)
    : null;
  if (website?.applicationId && !application) {
    throw new ResourceImpactError('impact_application_reference_missing', 'Website Application reference is unavailable', 409);
  }
  const impactedDomainIds = new Set([
    ...(resourceType === 'domain' ? [resource.id] : []),
    ...linkedDomains.map((domain) => domain.id),
    ...childDomains.map((domain) => domain.id),
  ]);
  const dnsZones = allDnsZones.filter((item) => item.webDomainId !== null && impactedDomainIds.has(item.webDomainId))
    .map((item) => externalLifecycleReference(item, 'zoneName'))
    .sort((left, right) => left.id.localeCompare(right.id));
  const mailDomains = allMailDomains.filter((item) => item.webDomainId !== null && impactedDomainIds.has(item.webDomainId))
    .map((item) => externalLifecycleReference(item, 'domainName'))
    .sort((left, right) => left.id.localeCompare(right.id));
  const certificateReferences = certificates.filter((certificate) => impactedDomainIds.has(certificate.domainId))
    .map(certificateReference).sort((left, right) => left.id.localeCompare(right.id));
  const activeJobs = relevantJobs(jobs, {
    domainIds: impactedDomainIds,
    applicationId: application?.id ?? null,
    dockerWorkloadId: website?.dockerWorkloadId ?? null,
    certificateIds: certificateReferences.map((certificate) => certificate.id),
  });
  const providerContext = Object.freeze({
    resourceType,
    resourceId: resource.id,
    serverId: resource.serverId,
    targetServerId: requested.targetServerId,
    websiteId: website?.id ?? null,
    applicationId: application?.id ?? null,
    dockerWorkloadId: website?.dockerWorkloadId ?? null,
    domainIds: Object.freeze([...impactedDomainIds].sort()),
  });
  const additionalEntries = await Promise.all(ADDITIONAL_TYPES.map(async ([key, type]) => (
    [key, await additionalBucket(additionalProviders[key], type, providerContext)]
  )));
  const additional = Object.fromEntries(additionalEntries);
  const dependencySet = Object.freeze({
    linkedDomains: Object.freeze(linkedDomains),
    childDomains: Object.freeze(childDomains),
    website: resourceType === 'domain' && website ? websiteReference(website) : null,
    application: applicationReference(application),
    dnsZones: Object.freeze(dnsZones),
    mailDomains: Object.freeze(mailDomains),
    certificates: Object.freeze(certificateReferences),
    activeJobs: Object.freeze(activeJobs),
    ...additional,
  });
  const blockers = knownBlockers(dependencySet);
  if (dnsZones.length > 0) blockers.push(blocker('dns_zones_present', 'dns_zone', dnsZones.length));
  if (mailDomains.length > 0) blockers.push(blocker('mail_domains_present', 'mail_domain', mailDomains.length));
  for (const [key, type] of ADDITIONAL_TYPES) {
    const bucket = additional[key];
    if (bucket.status === 'unavailable') blockers.push(blocker('dependency_inventory_unavailable', type));
    else if (bucket.items.length > 0) blockers.push(blocker(`${type}_dependencies_present`, type, bucket.items.length));
  }
  blockers.push(blocker('impact_apply_not_implemented', resourceType));

  const previewCore = {
    version: 1,
    resourceType,
    resource,
    operation: requested.operation,
    targetServerId: requested.targetServerId,
    dependencies: dependencySet,
    blockers,
  };
  const previewDigest = createHash('sha256').update(JSON.stringify(previewCore)).digest('hex');
  const confirmation = requested.operation === 'delete'
    ? `delete:${resourceType}:${resource.id}:${previewDigest}`
    : `move:${resourceType}:${resource.id}:${requested.targetServerId}:${previewDigest}`;
  return Object.freeze({
    ...previewCore,
    previewDigest,
    confirmation,
    destructive: true,
    autoApply: false,
    applySupported: false,
    safeToApply: false,
    cascade: false,
  });
}

export const resourceImpactInternals = Object.freeze({
  operationInput,
  resourceIdentity,
  domainReference,
  websiteReference,
  applicationReference,
  certificateReference,
  jobReference,
  externalLifecycleReference,
  descendants,
  sanitizeAdditionalReference,
  additionalBucket,
  relevantJobs,
});
