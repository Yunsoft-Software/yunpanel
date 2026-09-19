import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,160}$/;
const SAFE_BLOCKER = /^[a-z0-9_]{1,120}$/;
const CERTIFICATE_STATES = new Set([
  'pending', 'validating', 'validated', 'issuing', 'active', 'renewing', 'superseded',
  'error',
]);
const CERTIFICATE_SOURCES = new Set(['acme', 'custom']);
const CERTIFICATE_RENEWAL_MODES = new Set(['automatic', 'manual']);
const MAIL_MANAGEMENT_MODES = new Set(['local', 'external']);
const LOCAL_MAIL_STATUSES = new Set(['disabled', 'enabled']);
const EXTERNAL_MAIL_STATUSES = new Set(['unverified', 'ready', 'degraded']);

const ORCHESTRATABLE_IMPACT_BLOCKERS = new Set([
  'child_domains_present',
  'website_binding_present',
  'application_binding_present',
  'managed_compose_binding_present',
  'dns_zones_present',
  'mail_domains_present',
  'certificates_present',
  'mailbox_dependencies_present',
  'backup_dependencies_present',
  'cron_dependencies_present',
  'docker_dependencies_present',
  'authoritative_dns_retirement_blocked',
  'impact_apply_not_implemented',
]);

const ORCHESTRATABLE_DNS_BLOCKERS = new Set([
  'domain_descendants_present',
  'domain_website_binding_present',
  'domain_certificate_present',
  'domain_routing_active',
  'dns_zone_mail_dependencies_present',
]);

export class DomainRemovalPlanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRemovalPlanError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      `${field} is invalid for Domain removal planning`,
      409,
    );
  }
  return value;
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      `${field} is invalid for Domain removal planning`,
      409,
    );
  }
  return value;
}

function safeBlockerCode(value) {
  if (typeof value !== 'string' || !SAFE_BLOCKER.test(value)) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      'Domain removal blocker metadata is invalid',
      409,
    );
  }
  return value;
}

function safeTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      `${field} is invalid for Domain removal planning`,
      409,
    );
  }
  return value;
}

function normalizedIds(values, field) {
  if (!Array.isArray(values) || values.length > 500) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      `${field} dependency inventory is invalid`,
      409,
    );
  }
  const ids = values.map((value) => safeId(value?.id, `${field}Id`)).sort();
  if (new Set(ids).size !== ids.length) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      `${field} dependency inventory contains duplicate identities`,
      409,
    );
  }
  return Object.freeze(ids);
}

function orderedChildDomains(values, rootDomain) {
  if (!Array.isArray(values) || values.length > 500) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      'childDomain dependency inventory is invalid',
      409,
    );
  }
  const entries = values.map((value) => {
    const snapshot = domainSnapshot(value);
    const parentDomainId = safeId(snapshot.parentDomainId, 'childDomainParentId');
    if (snapshot.id === rootDomain.id) {
      throw new DomainRemovalPlanError(
        'domain_removal_preview_invalid',
        'Domain removal child inventory contains its own root Domain',
        409,
      );
    }
    if (snapshot.serverId !== rootDomain.serverId) {
      throw new DomainRemovalPlanError(
        'domain_removal_impact_stale',
        'Domain removal child inventory crosses the root Domain server boundary',
        409,
      );
    }
    return Object.freeze({ ...snapshot, parentDomainId });
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      'childDomain dependency inventory contains duplicate identities',
      409,
    );
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const depths = new Map();
  const resolving = new Set();
  const depthOf = (entry) => {
    if (depths.has(entry.id)) return depths.get(entry.id);
    if (resolving.has(entry.id)) {
      throw new DomainRemovalPlanError(
        'domain_removal_preview_invalid',
        'Domain removal child inventory contains a hierarchy cycle',
        409,
      );
    }
    resolving.add(entry.id);
    let depth;
    if (entry.parentDomainId === rootDomain.id) {
      depth = 1;
    } else {
      const parent = byId.get(entry.parentDomainId);
      if (!parent) {
        throw new DomainRemovalPlanError(
          'domain_removal_preview_invalid',
          'Domain removal child inventory is disconnected from the root Domain',
          409,
        );
      }
      depth = depthOf(parent) + 1;
    }
    resolving.delete(entry.id);
    depths.set(entry.id, depth);
    return depth;
  };
  for (const entry of entries) depthOf(entry);
  return Object.freeze(entries
    .map((entry) => Object.freeze({ ...entry, depth: depths.get(entry.id) }))
    .sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id))
    .map(({ depth, ...entry }) => Object.freeze(entry)));
}

function normalizedBucket(bucket, field) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)
    || !['available', 'unavailable'].includes(bucket.status)
    || !Array.isArray(bucket.items)) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      `${field} dependency bucket is invalid`,
      409,
    );
  }
  return Object.freeze({
    status: bucket.status,
    ids: normalizedIds(bucket.items, field),
  });
}

function domainSnapshot(domain) {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)
    || typeof domain.primaryDomain !== 'string' || domain.primaryDomain.length < 1
    || domain.primaryDomain.length > 253 || /[\u0000-\u001f\u007f]/.test(domain.primaryDomain)
    || !['active', 'suspended'].includes(domain.state)
    || !Number.isSafeInteger(domain.desiredRevision) || domain.desiredRevision < 1
    || domain.stagedRevision !== domain.desiredRevision
    || domain.appliedRevision !== domain.desiredRevision
    || domain.appliedPrimaryDomain !== domain.primaryDomain) {
    throw new DomainRemovalPlanError(
      'domain_removal_domain_not_stable',
      'Domain must have an exact active or suspended applied routing revision before removal planning',
      409,
    );
  }
  const stagedChecksum = safeDigest(domain.stagedChecksum, 'stagedChecksum');
  const suspended = domain.state === 'suspended';
  if (suspended && (
    domain.suspendedChecksum !== stagedChecksum
    || typeof domain.suspensionOperationId !== 'string'
    || !SAFE_ID.test(domain.suspensionOperationId)
  )) {
    throw new DomainRemovalPlanError(
      'domain_removal_suspension_evidence_invalid',
      'Suspended Domain removal planning requires exact suspension ownership evidence',
      409,
    );
  }
  if (!suspended && (
    (domain.suspendedChecksum !== null && domain.suspendedChecksum !== undefined)
    || (domain.suspensionOperationId !== null && domain.suspensionOperationId !== undefined)
  )) {
    throw new DomainRemovalPlanError(
      'domain_removal_suspension_evidence_invalid',
      'Active Domain removal planning rejects stale suspension ownership evidence',
      409,
    );
  }
  return Object.freeze({
    id: safeId(domain.id, 'domainId'),
    serverId: safeId(domain.serverId, 'serverId'),
    primaryDomain: domain.primaryDomain,
    websiteId: domain.websiteId === null || domain.websiteId === undefined
      ? null
      : safeId(domain.websiteId, 'websiteId'),
    certificateId: domain.certificateId === null || domain.certificateId === undefined
      ? null
      : safeId(domain.certificateId, 'certificateId'),
    parentDomainId: domain.parentDomainId === null || domain.parentDomainId === undefined
      ? null
      : safeId(domain.parentDomainId, 'parentDomainId'),
    state: domain.state,
    desiredRevision: domain.desiredRevision,
    checksum: stagedChecksum,
    suspensionOperationId: suspended ? domain.suspensionOperationId : null,
  });
}

function impactBlockers(impact) {
  if (!Array.isArray(impact.blockers) || impact.blockers.length > 100) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_invalid',
      'Domain resource-impact blockers are invalid',
      409,
    );
  }
  return Object.freeze(impact.blockers.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DomainRemovalPlanError(
        'domain_removal_impact_invalid',
        'Domain resource-impact blocker is invalid',
        409,
      );
    }
    return Object.freeze({
      code: safeBlockerCode(entry.code),
      resourceType: typeof entry.resourceType === 'string' ? entry.resourceType : null,
      count: entry.count === null || entry.count === undefined
        ? null
        : Number.isSafeInteger(entry.count) && entry.count >= 0 ? entry.count : null,
    });
  }));
}

function authoritativeDnsReference(dependencies, domainId) {
  if (!Object.hasOwn(dependencies, 'authoritativeDns')) return null;
  const bucket = dependencies.authoritativeDns;
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)
    || bucket.status !== 'available' || !Array.isArray(bucket.items)) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_invalid',
      'Authoritative DNS impact inventory is invalid',
      409,
    );
  }
  const matching = bucket.items.filter((item) => item?.domainId === domainId);
  if (matching.length !== 1) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_invalid',
      'Authoritative DNS impact must contain exactly one matching Domain reference',
      409,
    );
  }
  const item = matching[0];
  if (!['ready', 'blocked', 'not_applicable'].includes(item.state)
    || !Array.isArray(item.blockers) || item.blockers.length > 32
    || (item.ownershipEvidenceDigest !== null
      && (typeof item.ownershipEvidenceDigest !== 'string'
        || !SHA256_PATTERN.test(item.ownershipEvidenceDigest)))
    || (item.snapshotRetentionDays !== null
      && (!Number.isSafeInteger(item.snapshotRetentionDays)
        || item.snapshotRetentionDays < 1 || item.snapshotRetentionDays > 3650))
    || (item.zoneSnapshotDigest === null
      && (item.ownershipEvidenceDigest !== null || item.snapshotRetentionDays !== null))) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_invalid',
      'Authoritative DNS retirement reference is invalid',
      409,
    );
  }
  const blockers = item.blockers.map(safeBlockerCode).sort();
  if (new Set(blockers).size !== blockers.length) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_invalid',
      'Authoritative DNS retirement reference contains duplicate blockers',
      409,
    );
  }
  return Object.freeze({
    state: item.state,
    previewDigest: safeDigest(item.previewDigest, 'authoritativeDnsPreviewDigest'),
    zoneSnapshotDigest: item.zoneSnapshotDigest === null
      ? null
      : safeDigest(item.zoneSnapshotDigest, 'authoritativeDnsZoneSnapshotDigest'),
    ownershipEvidenceDigest: item.ownershipEvidenceDigest === null
      ? null
      : safeDigest(item.ownershipEvidenceDigest, 'authoritativeDnsOwnershipEvidenceDigest'),
    snapshotRetentionDays: item.snapshotRetentionDays,
    blockers: Object.freeze(blockers),
  });
}

function certificateReferences(values, domain, childDomains) {
  if (!Array.isArray(values) || values.length > 500) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      'Certificate dependency inventory is invalid',
      409,
    );
  }
  const fields = new Set([
    'id', 'domainId', 'serverId', 'state', 'source', 'renewalMode', 'staging', 'validTo',
    'updatedAt', 'retirementOperationId', 'retiredAt', 'retiredFromState',
  ]);
  const affectedDomainIds = new Set([domain.id, ...childDomains.map((child) => child.id)]);
  const references = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.size
      || Object.keys(value).some((field) => !fields.has(field))
      || !CERTIFICATE_STATES.has(value.state)
      || !CERTIFICATE_SOURCES.has(value.source)
      || !CERTIFICATE_RENEWAL_MODES.has(value.renewalMode)
      || (value.source === 'acme' && value.renewalMode !== 'automatic')
      || (value.source === 'custom' && value.renewalMode !== 'manual')
      || typeof value.staging !== 'boolean'
      || (value.validTo !== null && (typeof value.validTo !== 'string'
        || !Number.isFinite(Date.parse(value.validTo))))) {
      throw new DomainRemovalPlanError(
        'domain_removal_preview_invalid',
        'Certificate dependency evidence is invalid',
        409,
      );
    }
    const reference = {
      id: safeId(value.id, 'certificateId'),
      domainId: safeId(value.domainId, 'certificateDomainId'),
      serverId: safeId(value.serverId, 'certificateServerId'),
      state: value.state,
      source: value.source,
      renewalMode: value.renewalMode,
      staging: value.staging,
      validTo: value.validTo === null ? null : new Date(value.validTo).toISOString(),
      updatedAt: safeTimestamp(value.updatedAt, 'certificateUpdatedAt'),
      retirementOperationId: value.retirementOperationId === null
        ? null
        : safeId(value.retirementOperationId, 'certificateRetirementOperationId'),
      retiredAt: value.retiredAt === null
        ? null
        : safeTimestamp(value.retiredAt, 'certificateRetiredAt'),
      retiredFromState: value.retiredFromState,
    };
    const retired = reference.state === 'retired';
    if (!affectedDomainIds.has(reference.domainId) || reference.serverId !== domain.serverId
      || retired !== (reference.retirementOperationId !== null
        && reference.retiredAt !== null
        && CERTIFICATE_STATES.has(reference.retiredFromState)
        && reference.retiredFromState !== 'retired')
      || (!retired && (reference.retirementOperationId !== null
        || reference.retiredAt !== null || reference.retiredFromState !== null))) {
      throw new DomainRemovalPlanError(
        'domain_removal_impact_stale',
        'Certificate dependency evidence does not match the affected Domain set',
        409,
      );
    }
    return Object.freeze(reference);
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(references.map((reference) => reference.id)).size !== references.length) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      'Certificate dependency inventory contains duplicate identities',
      409,
    );
  }
  for (const currentDomain of [domain, ...childDomains]) {
    if (currentDomain.certificateId === null) continue;
    const matching = references.filter((reference) => (
      reference.id === currentDomain.certificateId && reference.domainId === currentDomain.id
    ));
    if (matching.length !== 1) {
      throw new DomainRemovalPlanError(
        'domain_removal_impact_stale',
        'Bound Domain certificate is missing from exact dependency evidence',
        409,
      );
    }
  }
  return Object.freeze(references);
}

function mailDomainReferences(values, domain, childDomains) {
  if (!Array.isArray(values) || values.length > 500) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      'Mail Domain dependency inventory is invalid',
      409,
    );
  }
  const fields = new Set([
    'id', 'domainName', 'webDomainId', 'managementMode', 'status', 'revision', 'updatedAt',
  ]);
  const affectedDomains = new Map(
    [domain, ...childDomains].map((current) => [current.id, current.primaryDomain]),
  );
  const references = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.size
      || Object.keys(value).some((field) => !fields.has(field))
      || !MAIL_MANAGEMENT_MODES.has(value.managementMode)
      || (value.managementMode === 'local' && !LOCAL_MAIL_STATUSES.has(value.status))
      || (value.managementMode === 'external' && !EXTERNAL_MAIL_STATUSES.has(value.status))
      || !Number.isSafeInteger(value.revision) || value.revision < 1) {
      throw new DomainRemovalPlanError(
        'domain_removal_preview_invalid',
        'Mail Domain dependency evidence is invalid',
        409,
      );
    }
    const reference = Object.freeze({
      id: safeId(value.id, 'mailDomainId'),
      domainName: value.domainName,
      webDomainId: safeId(value.webDomainId, 'mailDomainWebDomainId'),
      managementMode: value.managementMode,
      status: value.status,
      revision: value.revision,
      updatedAt: safeTimestamp(value.updatedAt, 'mailDomainUpdatedAt'),
    });
    if (typeof reference.domainName !== 'string'
      || reference.domainName !== affectedDomains.get(reference.webDomainId)) {
      throw new DomainRemovalPlanError(
        'domain_removal_impact_stale',
        'Mail Domain dependency evidence does not match the affected Domain set',
        409,
      );
    }
    return reference;
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(references.map((reference) => reference.id)).size !== references.length
    || new Set(references.map((reference) => reference.webDomainId)).size !== references.length) {
    throw new DomainRemovalPlanError(
      'domain_removal_preview_invalid',
      'Mail Domain dependency inventory contains duplicate identities',
      409,
    );
  }
  return Object.freeze(references);
}

function dependencyPlan(dependencies, domain) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_invalid',
      'Domain resource-impact dependencies are invalid',
      409,
    );
  }
  const website = dependencies.website;
  if (website !== null && website !== undefined
    && (!website || typeof website !== 'object' || website.id !== domain.websiteId)) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_stale',
      'Domain Website binding differs from resource-impact evidence',
      409,
    );
  }
  const additional = Object.freeze({
    mailboxes: normalizedBucket(dependencies.mailboxes, 'mailbox'),
    backups: normalizedBucket(dependencies.backups, 'backup'),
    crons: normalizedBucket(dependencies.crons, 'cron'),
    dockerWorkloads: normalizedBucket(dependencies.dockerWorkloads, 'docker'),
  });
  const activeJobs = normalizedIds(dependencies.activeJobs ?? [], 'job');
  const childDomains = Object.freeze(orderedChildDomains(
    dependencies.childDomains ?? [],
    domain,
  ).map((child) => Object.freeze({
    ...child,
    authoritativeDns: authoritativeDnsReference(dependencies, child.id),
  })));
  const certificates = certificateReferences(
    dependencies.certificates ?? [],
    domain,
    childDomains,
  );
  const mailDomains = mailDomainReferences(
    dependencies.mailDomains ?? [],
    domain,
    childDomains,
  );
  return Object.freeze({
    childDomainIds: Object.freeze(childDomains.map((child) => child.id)),
    childDomains,
    websiteId: website?.id ?? null,
    applicationId: dependencies.application?.id
      ? safeId(dependencies.application.id, 'applicationId')
      : null,
    managedComposeProjectId: dependencies.managedComposeBinding?.projectId
      ? safeId(dependencies.managedComposeBinding.projectId, 'managedComposeProjectId')
      : null,
    certificateIds: Object.freeze(certificates.map((certificate) => certificate.id)),
    certificateIntents: certificates,
    boundCertificateId: domain.certificateId,
    dnsZoneIds: normalizedIds(dependencies.dnsZones ?? [], 'dnsZone'),
    mailDomainIds: Object.freeze(mailDomains.map((mailDomain) => mailDomain.id)),
    mailDomainIntents: mailDomains,
    activeJobIds: activeJobs,
    additional,
    authoritativeDns: authoritativeDnsReference(dependencies, domain.id),
  });
}

function hardBlockers(blockers, plan) {
  const hard = [];
  for (const blocker of blockers) {
    if (blocker.code === 'active_jobs_present' || blocker.code === 'dependency_inventory_unavailable') {
      hard.push(blocker.code);
      continue;
    }
    if (!ORCHESTRATABLE_IMPACT_BLOCKERS.has(blocker.code)) hard.push(blocker.code);
  }
  if (plan.activeJobIds.length > 0 && !hard.includes('active_jobs_present')) {
    hard.push('active_jobs_present');
  }
  for (const [name, bucket] of Object.entries(plan.additional)) {
    if (bucket.status === 'unavailable') hard.push(`${name}_inventory_unavailable`);
  }
  const authoritativeDnsPlans = [
    plan.authoritativeDns,
    ...plan.childDomains.map((child) => child.authoritativeDns),
  ];
  for (const dnsPlan of authoritativeDnsPlans) {
    if (dnsPlan?.state === 'blocked') {
      for (const code of dnsPlan.blockers) {
        if (!ORCHESTRATABLE_DNS_BLOCKERS.has(code)) hard.push(code);
      }
    }
    if (dnsPlan && dnsPlan.zoneSnapshotDigest !== null) {
      if (dnsPlan.ownershipEvidenceDigest === null) {
        hard.push('dns_zone_delete_ownership_evidence_required');
      }
      if (dnsPlan.snapshotRetentionDays === null) {
        hard.push('dns_zone_delete_retention_policy_required');
      }
    }
  }
  if (plan.childDomains.some((child) => child.authoritativeDns === null)) {
    hard.push('authoritative_dns_impact_unavailable');
  }
  return Object.freeze([...new Set(hard)].sort());
}

export function createDomainRemovalPreview({ domain, impact } = {}) {
  const currentDomain = domainSnapshot(domain);
  if (!impact || impact.version !== 1 || impact.resourceType !== 'domain'
    || impact.operation !== 'delete' || impact.targetServerId !== null
    || !impact.resource || typeof impact.resource !== 'object'
    || impact.resource.id !== currentDomain.id
    || impact.resource.serverId !== currentDomain.serverId
    || impact.resource.primaryDomain !== currentDomain.primaryDomain
    || impact.resource.websiteId !== currentDomain.websiteId
    || impact.resource.certificateId !== currentDomain.certificateId
    || impact.resource.desiredRevision !== currentDomain.desiredRevision
    || impact.resource.state !== currentDomain.state) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_stale',
      'Domain resource-impact evidence does not match current Domain state',
      409,
    );
  }
  const impactPreviewDigest = safeDigest(impact.previewDigest, 'impactPreviewDigest');
  const expectedImpactConfirmation = `delete:domain:${currentDomain.id}:${impactPreviewDigest}`;
  if (impact.confirmation !== expectedImpactConfirmation) {
    throw new DomainRemovalPlanError(
      'domain_removal_impact_invalid',
      'Domain resource-impact confirmation is invalid',
      409,
    );
  }
  const blockers = impactBlockers(impact);
  const plan = dependencyPlan(impact.dependencies, currentDomain);
  const blocking = hardBlockers(blockers, plan);
  const previewCore = Object.freeze({
    version: 1,
    operation: 'domain_remove',
    domain: currentDomain,
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
    ? `start-domain-remove:${currentDomain.id}:${currentDomain.desiredRevision}:${previewDigest}`
    : null;
  return Object.freeze({
    ...previewCore,
    previewDigest,
    confirmation,
    sideEffects: false,
  });
}

export const domainRemovalPlanInternals = Object.freeze({
  orchestratableImpactBlockers: Object.freeze([...ORCHESTRATABLE_IMPACT_BLOCKERS]),
  orchestratableDnsBlockers: Object.freeze([...ORCHESTRATABLE_DNS_BLOCKERS]),
  digest,
  domainSnapshot,
  impactBlockers,
  orderedChildDomains,
  authoritativeDnsReference,
  certificateReferences,
  mailDomainReferences,
  dependencyPlan,
  hardBlockers,
});
