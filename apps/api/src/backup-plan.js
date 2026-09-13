import { createHash } from 'node:crypto';
import { normalizeBackupManifest } from './backup-manifest.js';
import { normalizeDatabaseBackupResource } from './database-backup-resource.js';
import { normalizeMailDataBackupResource } from './mail-data-backup-resource.js';

const PLAN_VERSION = 1;
const MAX_RESOURCES = 8192;
const MAX_SELECTION = 8192;

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

export function createBackupPlan({
  baseManifest,
  databaseResources = [],
  mailDataResources = [],
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
  maxResources: MAX_RESOURCES,
  maxSelection: MAX_SELECTION,
  digest,
  normalizeSelection,
  resourceCounts,
});
