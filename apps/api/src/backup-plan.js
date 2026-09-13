import { createHash } from 'node:crypto';
import { normalizeBackupManifest } from './backup-manifest.js';
import { normalizeDatabaseBackupResource } from './database-backup-resource.js';
import { normalizeMailDataBackupResource } from './mail-data-backup-resource.js';

const PLAN_VERSION = 1;
const DEPENDENCY_GRAPH_VERSION = 1;
const MAX_RESOURCES = 8192;
const MAX_SELECTION = 8192;
const RESOURCE_TYPES = new Set(['application', 'database', 'docker_storage', 'mail_data']);
const REFERENCE_TYPES = new Set(['website', 'domain', 'database_binding', 'mail_domain']);

export class BackupPlanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupPlanError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeAdditionalResources(serverId, resources, normalizer, label) {
  if (!Array.isArray(resources) || resources.length > MAX_RESOURCES) {
    throw new BackupPlanError('backup_plan_resources_invalid', `${label} backup resources are invalid`);
  }
  try {
    return resources.map((resource) => normalizer(resource, serverId));
  } catch {
    throw new BackupPlanError('backup_plan_resources_invalid', `${label} backup resources are invalid`, 409);
  }
}

function normalizeSelection(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_SELECTION
    || value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 160)) {
    throw new BackupPlanError('backup_plan_selection_invalid', 'Backup resource selection is invalid');
  }
  if (new Set(value).size !== value.length) {
    throw new BackupPlanError('backup_plan_selection_invalid', 'Backup resource selection contains duplicates');
  }
  return Object.freeze([...value].sort());
}

function resourceCounts(resources, selectedIdentities) {
  const selected = new Set(selectedIdentities);
  const counts = {
    total: resources.length,
    selected: selected.size,
    included: 0,
    excluded: 0,
    rejected: 0,
  };
  for (const resource of resources) {
    if (resource.policy.disposition === 'include') counts.included += 1;
    else if (resource.policy.disposition === 'exclude') counts.excluded += 1;
    else if (resource.policy.disposition === 'reject') counts.rejected += 1;
  }
  return Object.freeze(counts);
}

function normalizeDependencyReference(value) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !REFERENCE_TYPES.has(value.type)
    || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 160
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || keys.some((key) => !['type', 'id', 'revision', 'appliedRevision'].includes(key))
    || keys.length < 3 || keys.length > 4
    || (Object.hasOwn(value, 'appliedRevision')
      && (!Number.isSafeInteger(value.appliedRevision) || value.appliedRevision < 0))) {
    throw new BackupPlanError('backup_plan_dependencies_invalid', 'Backup dependency reference is invalid', 409);
  }
  return Object.freeze({
    type: value.type,
    id: value.id,
    revision: value.revision,
    ...(Object.hasOwn(value, 'appliedRevision') ? { appliedRevision: value.appliedRevision } : {}),
  });
}

function normalizeDependencyGraph(value, resources, serverId) {
  if (value === undefined || value === null) return null;
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || keys.length !== 4 || keys.some((key) => !['version', 'serverId', 'impacts', 'counts'].includes(key))
    || value.version !== DEPENDENCY_GRAPH_VERSION || value.serverId !== serverId
    || !Array.isArray(value.impacts) || value.impacts.length !== resources.length
    || !value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)) {
    throw new BackupPlanError('backup_plan_dependencies_invalid', 'Backup dependency graph is invalid', 409);
  }
  const resourceByIdentity = new Map(resources.map((resource) => [resource.identity, resource]));
  const impacts = value.impacts.map((impact) => {
    const impactKeys = impact && typeof impact === 'object' && !Array.isArray(impact) ? Object.keys(impact) : [];
    if (!impact || typeof impact !== 'object' || Array.isArray(impact)
      || impactKeys.length !== 5
      || impactKeys.some((key) => !['resourceIdentity', 'resourceType', 'websiteIds', 'domainIds', 'references'].includes(key))
      || typeof impact.resourceIdentity !== 'string'
      || typeof impact.resourceType !== 'string' || !RESOURCE_TYPES.has(impact.resourceType)
      || !Array.isArray(impact.websiteIds) || !Array.isArray(impact.domainIds) || !Array.isArray(impact.references)
      || impact.websiteIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 160)
      || impact.domainIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 160)) {
      throw new BackupPlanError('backup_plan_dependencies_invalid', 'Backup dependency impact is invalid', 409);
    }
    const resource = resourceByIdentity.get(impact.resourceIdentity);
    if (!resource || resource.type !== impact.resourceType
      || new Set(impact.websiteIds).size !== impact.websiteIds.length
      || new Set(impact.domainIds).size !== impact.domainIds.length) {
      throw new BackupPlanError('backup_plan_dependencies_invalid', 'Backup dependency impact does not match its resource', 409);
    }
    const websiteIds = Object.freeze([...impact.websiteIds].sort());
    const domainIds = Object.freeze([...impact.domainIds].sort());
    const references = impact.references.map(normalizeDependencyReference)
      .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
    const referenceKeys = references.map((reference) => `${reference.type}:${reference.id}`);
    if (new Set(referenceKeys).size !== referenceKeys.length) {
      throw new BackupPlanError('backup_plan_dependencies_invalid', 'Backup dependency impact contains duplicate references', 409);
    }
    return Object.freeze({
      resourceIdentity: impact.resourceIdentity,
      resourceType: impact.resourceType,
      websiteIds,
      domainIds,
      references: Object.freeze(references),
    });
  }).sort((left, right) => left.resourceIdentity.localeCompare(right.resourceIdentity));
  if (new Set(impacts.map((impact) => impact.resourceIdentity)).size !== resources.length) {
    throw new BackupPlanError('backup_plan_dependencies_invalid', 'Backup dependency graph does not cover every resource', 409);
  }
  const expectedCounts = {
    resources: impacts.length,
    associatedResources: impacts.filter((impact) => impact.websiteIds.length > 0 || impact.domainIds.length > 0).length,
    websites: new Set(impacts.flatMap((impact) => impact.websiteIds)).size,
    domains: new Set(impacts.flatMap((impact) => impact.domainIds)).size,
  };
  if (Object.keys(value.counts).length !== 4
    || Object.entries(expectedCounts).some(([key, count]) => value.counts[key] !== count)) {
    throw new BackupPlanError('backup_plan_dependencies_invalid', 'Backup dependency counts are invalid', 409);
  }
  return Object.freeze({
    version: DEPENDENCY_GRAPH_VERSION,
    serverId,
    impacts: Object.freeze(impacts),
    counts: Object.freeze(expectedCounts),
  });
}

export function createBackupPlan({
  baseManifest,
  databaseResources = [],
  mailDataResources = [],
  dependencyGraph = null,
  selectedResourceIdentities = null,
} = {}) {
  let manifest;
  try { manifest = normalizeBackupManifest(baseManifest); }
  catch {
    throw new BackupPlanError('backup_plan_manifest_invalid', 'Base backup manifest is invalid', 409);
  }

  const databases = normalizeAdditionalResources(
    manifest.serverId,
    databaseResources,
    normalizeDatabaseBackupResource,
    'Database',
  );
  const mail = normalizeAdditionalResources(
    manifest.serverId,
    mailDataResources,
    normalizeMailDataBackupResource,
    'Mail data',
  );
  const resources = [...manifest.resources, ...databases, ...mail]
    .sort((left, right) => left.identity.localeCompare(right.identity));
  if (resources.length > MAX_RESOURCES) {
    throw new BackupPlanError('backup_plan_too_large', 'Backup plan contains too many resources');
  }
  if (new Set(resources.map((resource) => resource.identity)).size !== resources.length) {
    throw new BackupPlanError('backup_plan_resource_duplicate', 'Backup plan contains duplicate resource identities', 409);
  }
  const dependencies = normalizeDependencyGraph(dependencyGraph, resources, manifest.serverId);

  const requested = normalizeSelection(selectedResourceIdentities);
  const byIdentity = new Map(resources.map((resource) => [resource.identity, resource]));
  let selected;
  let selectionMode;
  if (requested === null) {
    selectionMode = 'all_managed';
    selected = resources.filter((resource) => resource.policy.disposition === 'include').map((resource) => resource.identity);
  } else {
    selectionMode = 'explicit';
    selected = requested;
    for (const identity of selected) {
      const resource = byIdentity.get(identity);
      if (!resource) {
        throw new BackupPlanError('backup_plan_resource_not_found', 'Selected backup resource no longer exists', 409);
      }
      if (resource.policy.disposition !== 'include') {
        throw new BackupPlanError('backup_plan_resource_not_selectable', 'Selected backup resource is excluded by safety policy', 409);
      }
    }
  }
  if (selected.length === 0) {
    throw new BackupPlanError('backup_plan_empty', 'Backup plan does not contain a selectable resource', 409);
  }

  const selectedSet = new Set(selected);
  const decisions = Object.freeze(resources.map((resource) => Object.freeze({
    identity: resource.identity,
    type: resource.type,
    selected: selectedSet.has(resource.identity),
    policy: resource.policy,
  })));
  const identity = Object.freeze({
    version: PLAN_VERSION,
    manifestVersion: manifest.version,
    serverId: manifest.serverId,
    selectionMode,
    selectedResourceIdentities: Object.freeze([...selected].sort()),
    resources: Object.freeze(resources.map((resource) => resource)),
    dependencyGraph: dependencies,
  });
  const previewDigest = digest(identity);
  return Object.freeze({
    ...identity,
    previewDigest,
    confirmation: `backup:${manifest.serverId}:${previewDigest}`,
    counts: resourceCounts(resources, selected),
    decisions,
    sideEffects: false,
  });
}

export const backupPlanInternals = Object.freeze({
  planVersion: PLAN_VERSION,
  dependencyGraphVersion: DEPENDENCY_GRAPH_VERSION,
  maxResources: MAX_RESOURCES,
  maxSelection: MAX_SELECTION,
  digest,
  normalizeSelection,
  normalizeDependencyGraph,
  resourceCounts,
});
