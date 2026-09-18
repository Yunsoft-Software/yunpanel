import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertUuid,
  DomainValidationError,
  NginxSettingsValidationError,
  normalizeDomainSet,
  normalizeNginxSettings,
  normalizeProxyHost,
} from '@yunpanel/shared';
import { DomainHierarchyError, validateDomainHierarchy, validateDomainParent } from './domain-hierarchy.js';
import { operationErrorDiagnosis } from './operation-diagnosis.js';

const STORE_VERSION = 4;
const TARGET_TYPES = new Set(['static', 'proxy', 'passenger', 'php']);
const HTTPS_MODES = new Set(['off', 'managed']);
const DOMAIN_STATES = new Set(['draft', 'staged', 'active', 'suspended', 'error']);
const UPDATE_FIELDS = new Set(['primaryDomain', 'aliases', 'httpsMode', 'httpsRedirect', 'canonicalRedirect', 'nginxSettings']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DomainRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, domains: [] };
}

function normalizeWebsiteId(value) {
  if (value == null) return null;
  try { return assertUuid(value, 'websiteId'); }
  catch { throw new DomainRegistryError('invalid_website_id', 'websiteId must be a valid Website UUID'); }
}

function hydrateDomain(domain, sourceVersion = STORE_VERSION) {
  if (domain.websiteId === undefined) domain.websiteId = null;
  if (sourceVersion < 2) {
    domain.canonicalRedirect = false;
    domain.httpsRedirect = domain.httpsMode === 'managed';
    domain.appliedPrimaryDomain = domain.appliedRevision > 0 ? domain.primaryDomain : null;
    if (domain.lastError === undefined) domain.lastError = null;
    else if (domain.lastError !== null && (typeof domain.lastError !== 'string' || !/^[a-z0-9_]{1,120}$/.test(domain.lastError))) {
      domain.lastError = 'apply_failed';
    }
  }
  if (sourceVersion < 3) domain.nginxSettings = settingsFromTarget(domain.targetType, domain.target);
  if (sourceVersion < 4) {
    domain.suspensionOperationId = null;
    domain.suspendedAt = null;
    domain.suspendedChecksum = null;
    domain.lastSuspensionOperationId = null;
    domain.lastResumedAt = null;
  }
  const normalizedSettings = settings(domain.targetType, domain.nginxSettings);
  if (JSON.stringify(normalizedSettings) !== JSON.stringify(domain.nginxSettings)
    || (domain.targetType === 'proxy' && domain.target?.websocket !== normalizedSettings.websocket)
    || (domain.targetType === 'static' && domain.target?.spaFallback !== normalizedSettings.spaFallback)) {
    throw new DomainRegistryError('invalid_domain_state', 'Persisted Domain Nginx settings are invalid', 409);
  }
  validateTarget(domain.targetType, domain.target);
  if (typeof domain.canonicalRedirect !== 'boolean' || typeof domain.httpsRedirect !== 'boolean'
    || !HTTPS_MODES.has(domain.httpsMode) || (domain.httpsMode === 'off' && domain.httpsRedirect)
    || (domain.appliedPrimaryDomain !== null && typeof domain.appliedPrimaryDomain !== 'string')) {
    throw new DomainRegistryError('invalid_domain_state', 'Persisted Domain routing policy is invalid', 409);
  }
  if (domain.appliedPrimaryDomain !== null && normalizeDomains(domain.appliedPrimaryDomain, []).primary !== domain.appliedPrimaryDomain) {
    throw new DomainRegistryError('invalid_domain_state', 'Persisted applied Domain identity is invalid', 409);
  }
  if (domain.lastError !== null && (typeof domain.lastError !== 'string' || !/^[a-z0-9_]{1,120}$/.test(domain.lastError))) {
    throw new DomainRegistryError('invalid_domain_state', 'Persisted Domain error metadata is invalid', 409);
  }
  if (!DOMAIN_STATES.has(domain.state)
    || (domain.suspensionOperationId !== null
      && (typeof domain.suspensionOperationId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(domain.suspensionOperationId)))
    || (domain.suspendedAt !== null
      && (typeof domain.suspendedAt !== 'string'
        || !Number.isFinite(Date.parse(domain.suspendedAt))
        || new Date(domain.suspendedAt).toISOString() !== domain.suspendedAt))
    || (domain.suspendedChecksum !== null
      && (typeof domain.suspendedChecksum !== 'string' || !SHA256_PATTERN.test(domain.suspendedChecksum))
    )
    || (domain.lastSuspensionOperationId !== null
      && (typeof domain.lastSuspensionOperationId !== 'string'
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(domain.lastSuspensionOperationId)))
    || (domain.lastResumedAt !== null
      && (typeof domain.lastResumedAt !== 'string'
        || !Number.isFinite(Date.parse(domain.lastResumedAt))
        || new Date(domain.lastResumedAt).toISOString() !== domain.lastResumedAt))
    || ((domain.lastSuspensionOperationId === null) !== (domain.lastResumedAt === null))
    || (domain.state === 'suspended'
      && (domain.suspensionOperationId === null || domain.suspendedAt === null
        || domain.suspendedChecksum === null || domain.lastError !== null))
    || (domain.state !== 'suspended'
      && (domain.suspensionOperationId !== null || domain.suspendedAt !== null || domain.suspendedChecksum !== null))) {
    throw new DomainRegistryError('invalid_domain_state', 'Persisted Domain suspension metadata is invalid', 409);
  }
  return domain;
}

function diagnosis(domain) {
  if (domain.state === 'suspended') {
    return Object.freeze({
      severity: 'action_required',
      code: 'domain_suspended',
      message: 'Domain traffic is suspended.',
      action: 'Resume the Domain to restore the retained Nginx configuration.',
    });
  }
  if (domain.lastError) {
    return operationErrorDiagnosis('nginx', domain.lastError);
  }
  if (domain.stagedRevision !== domain.desiredRevision) {
    return Object.freeze({ severity: 'action_required', code: 'domain_stage_required', message: 'The desired Domain revision is not staged.', action: 'Stage the current revision.' });
  }
  if (domain.appliedRevision !== domain.desiredRevision) {
    return Object.freeze({ severity: 'action_required', code: 'domain_activation_required', message: 'The staged Domain revision is not active.', action: 'Activate the staged revision.' });
  }
  if (domain.httpsMode === 'managed' && !domain.certificateId) {
    return Object.freeze({
      severity: 'action_required',
      code: 'domain_certificate_required',
      message: domain.httpsRedirect ? 'Managed HTTPS and redirect are waiting for a certificate.' : 'Managed HTTPS is waiting for a certificate.',
      action: 'Issue or select a certificate covering the canonical hostname and every alias.',
    });
  }
  return null;
}

function publicDomain(domain) {
  return {
    ...domain,
    websiteId: domain.websiteId ?? null,
    aliases: [...domain.aliases],
    target: { ...domain.target },
    nginxSettings: { ...domain.nginxSettings, headers: domain.nginxSettings.headers.map((header) => ({ ...header })) },
    parentDomainId: domain.parentDomainId ?? null,
    kind: domain.parentDomainId == null ? 'domain' : 'subdomain',
    diagnosis: diagnosis(domain),
  };
}

function validateTarget(targetType, target) {
  if (!TARGET_TYPES.has(targetType)) throw new DomainRegistryError('invalid_target_type', 'targetType must be static, proxy, passenger or php');
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new DomainRegistryError('invalid_target', 'target must be an object');
  if (targetType === 'static') {
    if (typeof target.root !== 'string' || target.root.length < 2 || target.root.length > 500 || /[\u0000-\u001f\u007f]/.test(target.root)) {
      throw new DomainRegistryError('invalid_static_root', 'Static target root is invalid');
    }
    return { root: target.root, spaFallback: target.spaFallback !== false };
  }
  if (targetType === 'passenger' || targetType === 'php') {
    if (Object.keys(target).length !== 1 || !Object.hasOwn(target, 'applicationId')) {
      throw new DomainRegistryError(`invalid_${targetType}_target`, `${targetType === 'php' ? 'PHP' : 'Passenger'} Domain target must contain only applicationId`);
    }
    try { return { applicationId: assertUuid(target.applicationId, 'applicationId') }; }
    catch { throw new DomainRegistryError(`invalid_${targetType}_target`, `${targetType === 'php' ? 'PHP' : 'Passenger'} Domain target Application identity is invalid`); }
  }
  if (!Number.isInteger(target.upstreamPort) || target.upstreamPort < 1024 || target.upstreamPort > 65535) {
    throw new DomainRegistryError('invalid_upstream_port', 'Proxy upstreamPort must be between 1024 and 65535');
  }
  let upstreamHost;
  try { upstreamHost = normalizeProxyHost(target.upstreamHost ?? '127.0.0.1'); }
  catch { throw new DomainRegistryError('invalid_upstream_host', 'Proxy upstreamHost must be an IP address or DNS hostname without a URL scheme or path'); }
  return { upstreamHost, upstreamPort: target.upstreamPort, websocket: target.websocket !== false };
}

function settings(targetType, value, base = null) {
  try { return normalizeNginxSettings(targetType, value, base); }
  catch (error) {
    if (error instanceof NginxSettingsValidationError) throw new DomainRegistryError(error.code, error.message);
    throw error;
  }
}

function settingsFromTarget(targetType, target) {
  if (targetType === 'proxy') return settings(targetType, { websocket: target?.websocket !== false });
  if (targetType === 'static') return settings(targetType, { spaFallback: target?.spaFallback !== false });
  return settings(targetType, {});
}

function targetWithSettings(targetType, target, nginxSettings) {
  if (targetType === 'proxy') return { ...target, websocket: nginxSettings.websocket };
  if (targetType === 'static') return { ...target, spaFallback: nginxSettings.spaFallback };
  return { ...target };
}

function normalizeDomains(primaryDomain, aliases) {
  try { return normalizeDomainSet(primaryDomain, aliases); }
  catch (error) {
    if (error instanceof DomainValidationError) throw new DomainRegistryError(error.code, error.message);
    throw error;
  }
}

function ownedNames(domain) {
  return [domain.primaryDomain, ...domain.aliases];
}

function requireDomain(state, domainId) {
  const domain = state.domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
  return domain;
}

function suspensionOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new DomainRegistryError(
      'invalid_domain_suspension_operation_id',
      'Domain suspension operation id is invalid',
    );
  }
  return value;
}

function suspensionChecksum(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DomainRegistryError(
      'invalid_domain_suspension_checksum',
      'Domain suspension checksum is invalid',
    );
  }
  return value;
}

function removalConfirmation({
  domainId,
  operationId,
  expectedRevision,
  checksum,
}) {
  return `finalize-domain-remove:${domainId}:${operationId}:${expectedRevision}:${checksum}`;
}

function assertSuspendable(domain, { expectedRevision, checksum }) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || domain.desiredRevision !== expectedRevision
    || domain.stagedRevision !== expectedRevision
    || domain.appliedRevision !== expectedRevision
    || domain.stagedChecksum !== checksum
    || domain.appliedPrimaryDomain !== domain.primaryDomain
    || domain.lastError !== null) {
    throw new DomainRegistryError(
      'domain_suspension_state_drift',
      'Domain routing state changed before suspension',
      409,
    );
  }
}

function normalizeReparentId(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new DomainRegistryError(`invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, `${field} is invalid`);
  }
  return value;
}

function descendantsOf(domains, domainId) {
  const descendants = [];
  const pending = [domainId];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const parentId = pending.shift();
    for (const domain of domains) {
      if ((domain.parentDomainId ?? null) !== parentId || visited.has(domain.id)) continue;
      visited.add(domain.id);
      pending.push(domain.id);
      descendants.push(Object.freeze({ id: domain.id, primaryDomain: domain.primaryDomain, parentDomainId: domain.parentDomainId ?? null }));
    }
  }
  return descendants.sort((left, right) => left.id.localeCompare(right.id));
}

function hierarchySnapshot(domains) {
  return domains.map((domain) => ({
    id: domain.id,
    serverId: domain.serverId,
    websiteId: domain.websiteId ?? null,
    primaryDomain: domain.primaryDomain,
    aliases: [...domain.aliases].sort(),
    parentDomainId: domain.parentDomainId ?? null,
    certificateId: domain.certificateId ?? null,
    desiredRevision: domain.desiredRevision,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function reparentDigest({ domainId, currentParentDomainId, nextParentDomainId, hierarchy }) {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    domainId,
    currentParentDomainId,
    nextParentDomainId,
    hierarchy,
  })).digest('hex');
}

function normalizedUpdate(domain, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)
    || Object.keys(changes).length < 1 || Object.keys(changes).some((key) => !UPDATE_FIELDS.has(key))) {
    throw new DomainRegistryError('invalid_domain_update', 'Domain changes must contain only canonical hostname, HTTPS, redirect or Nginx settings');
  }
  const names = normalizeDomains(changes.primaryDomain ?? domain.primaryDomain, changes.aliases ?? domain.aliases);
  const httpsMode = changes.httpsMode ?? domain.httpsMode;
  if (!HTTPS_MODES.has(httpsMode)) throw new DomainRegistryError('invalid_https_mode', 'httpsMode must be off or managed');
  let httpsRedirect = changes.httpsRedirect ?? domain.httpsRedirect;
  if (Object.hasOwn(changes, 'httpsMode') && httpsMode !== domain.httpsMode && !Object.hasOwn(changes, 'httpsRedirect')) {
    httpsRedirect = httpsMode === 'managed';
  }
  const canonicalRedirect = changes.canonicalRedirect ?? domain.canonicalRedirect;
  if (typeof httpsRedirect !== 'boolean' || typeof canonicalRedirect !== 'boolean' || (httpsMode === 'off' && httpsRedirect)) {
    throw new DomainRegistryError('invalid_redirect_policy', 'Redirect policy is invalid for the selected HTTPS mode');
  }
  const nginxSettings = Object.hasOwn(changes, 'nginxSettings')
    ? settings(domain.targetType, changes.nginxSettings, domain.nginxSettings)
    : settings(domain.targetType, domain.nginxSettings);
  return Object.freeze({
    primaryDomain: names.primary,
    aliases: Object.freeze([...names.aliases]),
    httpsMode,
    httpsRedirect,
    canonicalRedirect,
    nginxSettings,
  });
}

function updateDigest({ domain, next, hierarchy }) {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    domainId: domain.id,
    currentRevision: domain.desiredRevision,
    currentCertificateId: domain.certificateId,
    appliedPrimaryDomain: domain.appliedPrimaryDomain,
    next,
    hierarchy,
  })).digest('hex');
}

function provisioningDomains(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new DomainRegistryError('provisioned_domains_invalid', 'Provisioned Domain evidence must contain one or two Domains');
  }
  const seen = new Set();
  const normalized = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, 'domainId') || !Object.hasOwn(entry, 'expectedRevision')) {
      throw new DomainRegistryError('provisioned_domains_invalid', 'Provisioned Domain evidence is invalid');
    }
    let domainId;
    try { domainId = assertUuid(entry.domainId, 'domainId'); }
    catch { throw new DomainRegistryError('provisioned_domains_invalid', 'Provisioned Domain identity is invalid'); }
    if (seen.has(domainId) || !Number.isSafeInteger(entry.expectedRevision) || entry.expectedRevision < 1) {
      throw new DomainRegistryError('provisioned_domains_invalid', 'Provisioned Domain evidence is invalid');
    }
    seen.add(domainId);
    return Object.freeze({ domainId, expectedRevision: entry.expectedRevision });
  });
  normalized.sort((left, right) => left.domainId.localeCompare(right.domainId));
  return Object.freeze(normalized);
}

export function createDomainRegistry({
  filePath = null,
  now = () => Date.now(),
  serverExists = async () => true,
  getWebsite = null,
  websiteBindingRequired = () => false,
} = {}) {
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

  if (typeof serverExists !== 'function' || (getWebsite !== null && typeof getWebsite !== 'function') || typeof websiteBindingRequired !== 'function') {
    throw new DomainRegistryError('invalid_domain_registry_dependencies', 'Domain registry dependencies are invalid');
  }

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function requireWebsiteBinding(websiteId, serverId) {
    const id = normalizeWebsiteId(websiteId);
    if (id === null) return null;
    if (typeof getWebsite !== 'function') throw new DomainRegistryError('website_registry_unavailable', 'Website registry is required for an explicit domain binding', 503);
    const website = await getWebsite(id);
    if (!website) throw new DomainRegistryError('website_not_found', 'Website does not exist', 404);
    if (website.serverId !== serverId) throw new DomainRegistryError('website_server_mismatch', 'Domain and Website must belong to the same server', 409);
    return id;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (![1, 2, 3, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.domains)) throw new Error('unsupported or invalid domain registry state');
        try {
          validateDomainHierarchy(parsed.domains);
          parsed.domains.forEach((domain) => hydrateDomain(domain, parsed.version));
          for (const domain of parsed.domains) normalizeWebsiteId(domain.websiteId ?? null);
        } catch (error) {
          if (error instanceof DomainHierarchyError || error instanceof DomainRegistryError) throw error;
          throw error;
        }
        state = parsed;
        state.version = STORE_VERSION;
        if (typeof getWebsite === 'function') {
          for (const domain of state.domains) if (domain.websiteId) await requireWebsiteBinding(domain.websiteId, domain.serverId);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function buildReparentPreview(domainId, parentDomainId) {
    const normalizedDomainId = normalizeReparentId(domainId, 'domainId');
    const normalizedParentId = normalizeReparentId(parentDomainId, 'parentDomainId', { nullable: true });
    const domain = requireDomain(state, normalizedDomainId);
    const currentParentDomainId = domain.parentDomainId ?? null;
    if (currentParentDomainId === normalizedParentId) {
      throw new DomainRegistryError('domain_reparent_no_changes', 'Domain already has the selected parent', 409);
    }
    try {
      validateDomainParent(state.domains, { ...domain, parentDomainId: normalizedParentId });
    } catch (error) {
      if (error instanceof DomainHierarchyError) throw new DomainRegistryError(error.code, error.message, error.status);
      throw error;
    }
    const descendants = descendantsOf(state.domains, domain.id);
    const hierarchy = hierarchySnapshot(state.domains);
    const previewDigest = reparentDigest({
      domainId: domain.id,
      currentParentDomainId,
      nextParentDomainId: normalizedParentId,
      hierarchy,
    });
    return Object.freeze({
      version: 1,
      domainId: domain.id,
      currentParentDomainId,
      nextParentDomainId: normalizedParentId,
      previewDigest,
      confirmation: `reparent:${domain.id}:${normalizedParentId ?? 'root'}:${previewDigest}`,
      impact: Object.freeze({
        hierarchyOnly: true,
        domainTrafficChanged: false,
        websiteId: domain.websiteId ?? null,
        certificateId: domain.certificateId ?? null,
        descendantCount: descendants.length,
        descendants: Object.freeze(descendants),
      }),
    });
  }

  function buildDomainUpdatePreview(domainId, changes) {
    const normalizedDomainId = normalizeReparentId(domainId, 'domainId');
    const domain = requireDomain(state, normalizedDomainId);
    if (domain.state === 'suspended') {
      throw new DomainRegistryError(
        'domain_suspended_update_blocked',
        'Resume the Domain before changing routing settings',
        409,
      );
    }
    const next = normalizedUpdate(domain, changes);
    const hostnameChanged = next.primaryDomain !== domain.primaryDomain
      || JSON.stringify(next.aliases) !== JSON.stringify(domain.aliases);
    const policyChanged = next.httpsMode !== domain.httpsMode
      || next.httpsRedirect !== domain.httpsRedirect
      || next.canonicalRedirect !== domain.canonicalRedirect;
    const settingsChanged = JSON.stringify(next.nginxSettings) !== JSON.stringify(domain.nginxSettings);
    if (!hostnameChanged && !policyChanged && !settingsChanged) {
      throw new DomainRegistryError('domain_update_no_changes', 'Domain already has the requested routing settings', 409);
    }
    if (hostnameChanged) {
      const requestedNames = new Set([next.primaryDomain, ...next.aliases]);
      const conflict = state.domains.find((candidate) => candidate.id !== domain.id
        && ownedNames(candidate).some((ownedName) => requestedNames.has(ownedName)));
      if (conflict) throw new DomainRegistryError('domain_conflict', 'A domain or alias is already managed', 409);
      try {
        validateDomainHierarchy(state.domains.map((candidate) => candidate.id === domain.id
          ? { ...candidate, primaryDomain: next.primaryDomain, aliases: [...next.aliases] }
          : candidate));
      } catch (error) {
        if (error instanceof DomainHierarchyError) throw new DomainRegistryError(error.code, error.message, error.status);
        throw error;
      }
    }
    const hierarchy = hierarchySnapshot(state.domains);
    const previewDigest = updateDigest({ domain, next, hierarchy });
    const certificateDetached = domain.certificateId !== null && (hostnameChanged || next.httpsMode === 'off');
    const descendants = descendantsOf(state.domains, domain.id);
    return Object.freeze({
      version: 1,
      domainId: domain.id,
      currentRevision: domain.desiredRevision,
      nextRevision: domain.desiredRevision + 1,
      next,
      previewDigest,
      confirmation: `update-domain:${domain.id}:${previewDigest}`,
      impact: Object.freeze({
        trafficChange: true,
        requiresStageAndActivation: true,
        hostnameChanged,
        policyChanged,
        settingsChanged,
        nginxSettings: Object.freeze({
          current: Object.freeze({
            ...domain.nginxSettings,
            headers: Object.freeze(domain.nginxSettings.headers.map((header) => Object.freeze({ ...header }))),
          }),
          next: next.nginxSettings,
          changedFields: Object.freeze(Object.keys(next.nginxSettings)
            .filter((field) => JSON.stringify(next.nginxSettings[field]) !== JSON.stringify(domain.nginxSettings[field]))),
        }),
        activeConfigRename: domain.appliedPrimaryDomain !== null && domain.appliedPrimaryDomain !== next.primaryDomain,
        certificate: Object.freeze({
          id: domain.certificateId,
          detached: certificateDetached,
          reason: certificateDetached ? (next.httpsMode === 'off' ? 'https_disabled' : 'hostname_set_changed') : null,
        }),
        descendants: Object.freeze(descendants),
      }),
    });
  }

  async function previewDomainReparent({ domainId, parentDomainId = null } = {}) {
    await ensureInitialized();
    return buildReparentPreview(domainId, parentDomainId);
  }

  async function reparentDomain({ domainId, parentDomainId = null, previewDigest } = {}) {
    await ensureInitialized();
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new DomainRegistryError('invalid_domain_reparent_digest', 'A current Domain reparent preview digest is required');
    }
    const preview = buildReparentPreview(domainId, parentDomainId);
    if (preview.previewDigest !== previewDigest) {
      throw new DomainRegistryError('domain_reparent_preview_stale', 'Domain hierarchy changed after preview; request a new preview', 409);
    }
    const domain = requireDomain(state, preview.domainId);
    domain.parentDomainId = preview.nextParentDomainId;
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return Object.freeze({ domain: publicDomain(domain), impact: preview.impact, previewDigest: preview.previewDigest });
  }

  async function previewDomainUpdate({ domainId, changes } = {}) {
    await ensureInitialized();
    return buildDomainUpdatePreview(domainId, changes);
  }

  async function updateDomain({ domainId, changes, previewDigest } = {}) {
    await ensureInitialized();
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new DomainRegistryError('invalid_domain_update_digest', 'A current Domain update preview digest is required');
    }
    const preview = buildDomainUpdatePreview(domainId, changes);
    if (preview.previewDigest !== previewDigest) {
      throw new DomainRegistryError('domain_update_preview_stale', 'Domain routing state changed after preview; request a new preview', 409);
    }
    const domain = requireDomain(state, preview.domainId);
    domain.primaryDomain = preview.next.primaryDomain;
    domain.aliases = [...preview.next.aliases];
    domain.httpsMode = preview.next.httpsMode;
    domain.httpsRedirect = preview.next.httpsRedirect;
    domain.canonicalRedirect = preview.next.canonicalRedirect;
    domain.nginxSettings = {
      ...preview.next.nginxSettings,
      headers: preview.next.nginxSettings.headers.map((header) => ({ ...header })),
    };
    domain.target = targetWithSettings(domain.targetType, domain.target, domain.nginxSettings);
    if (preview.impact.certificate.detached) domain.certificateId = null;
    domain.desiredRevision = preview.nextRevision;
    domain.stagedRevision = 0;
    domain.stagedChecksum = null;
    domain.stagedConfigName = null;
    domain.lastStagedAt = null;
    domain.state = 'draft';
    domain.lastError = null;
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return Object.freeze({ domain: publicDomain(domain), impact: preview.impact, previewDigest });
  }

  async function createDomain({
    domainId = null, serverId, primaryDomain, aliases = [], targetType, target, httpsMode = 'off',
    httpsRedirect = httpsMode === 'managed', canonicalRedirect = false, nginxSettings = undefined,
    parentDomainId = null, websiteId = null,
  }) {
    await ensureInitialized();
    if (typeof serverId !== 'string' || !serverId) throw new DomainRegistryError('invalid_server', 'serverId is required');
    if (!(await serverExists(serverId))) throw new DomainRegistryError('server_not_found', 'Target server does not exist', 404);
    if (!HTTPS_MODES.has(httpsMode)) throw new DomainRegistryError('invalid_https_mode', 'httpsMode must be off or managed');
    if (typeof httpsRedirect !== 'boolean' || typeof canonicalRedirect !== 'boolean' || (httpsMode === 'off' && httpsRedirect)) {
      throw new DomainRegistryError('invalid_redirect_policy', 'Redirect policy is invalid for the selected HTTPS mode');
    }
    const normalizedDomainId = domainId == null ? randomUUID() : (() => {
      try { return assertUuid(domainId, 'domainId'); }
      catch { throw new DomainRegistryError('invalid_domain_id', 'domainId must be a valid UUID'); }
    })();

    const normalizedWebsiteId = await requireWebsiteBinding(websiteId, serverId);
    if (normalizedWebsiteId === null && websiteBindingRequired() === true) {
      throw new DomainRegistryError('website_binding_required', 'New managed domains require an explicit Website binding', 409);
    }
    const normalized = normalizeDomains(primaryDomain, aliases);
    try { validateDomainParent(state.domains, { id: normalizedDomainId, serverId, primaryDomain: normalized.primary, parentDomainId }); }
    catch (error) {
      if (error instanceof DomainHierarchyError) throw new DomainRegistryError(error.code, error.message, error.status);
      throw error;
    }
    const requestedNames = new Set([normalized.primary, ...normalized.aliases]);
    const conflict = state.domains.find((domain) => domain.id !== normalizedDomainId
      && ownedNames(domain).some((ownedName) => requestedNames.has(ownedName)));
    if (conflict) throw new DomainRegistryError('domain_conflict', 'A domain or alias is already managed', 409);

    const normalizedTarget = validateTarget(targetType, target);
    if (['passenger', 'php'].includes(targetType) && normalizedWebsiteId === null) {
      throw new DomainRegistryError(`${targetType}_website_binding_required`, `${targetType === 'php' ? 'PHP' : 'Passenger'} Domain targets require an explicit Website binding`, 409);
    }
    const normalizedNginxSettings = settings(
      targetType,
      nginxSettings ?? {},
      settingsFromTarget(targetType, normalizedTarget),
    );
    const timestamp = new Date(now()).toISOString();
    const domain = {
      id: normalizedDomainId, serverId, websiteId: normalizedWebsiteId, primaryDomain: normalized.primary, parentDomainId,
      aliases: normalized.aliases, targetType,
      target: targetWithSettings(targetType, normalizedTarget, normalizedNginxSettings),
      nginxSettings: { ...normalizedNginxSettings, headers: normalizedNginxSettings.headers.map((header) => ({ ...header })) },
      httpsMode, httpsRedirect, canonicalRedirect,
      certificateId: null, appliedPrimaryDomain: null,
      state: 'draft', desiredRevision: 1, stagedRevision: 0, stagedChecksum: null, stagedConfigName: null,
      lastStagedAt: null, appliedRevision: 0, lastAppliedAt: null, lastError: null,
      suspensionOperationId: null, suspendedAt: null, suspendedChecksum: null,
      lastSuspensionOperationId: null, lastResumedAt: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const existing = state.domains.find((candidate) => candidate.id === normalizedDomainId) ?? null;
    if (existing) {
      if (domainId === null || existing.serverId !== domain.serverId || existing.websiteId !== domain.websiteId
        || existing.primaryDomain !== domain.primaryDomain || (existing.parentDomainId ?? null) !== domain.parentDomainId
        || JSON.stringify(existing.aliases) !== JSON.stringify(domain.aliases) || existing.targetType !== domain.targetType
        || JSON.stringify(existing.target) !== JSON.stringify(domain.target) || existing.httpsMode !== domain.httpsMode
        || JSON.stringify(existing.nginxSettings) !== JSON.stringify(domain.nginxSettings)
        || existing.httpsRedirect !== domain.httpsRedirect || existing.canonicalRedirect !== domain.canonicalRedirect) {
        throw new DomainRegistryError('domain_identity_conflict', 'Domain identity conflicts with existing state', 409);
      }
      return publicDomain(existing);
    }
    state.domains.push(domain);
    await persist();
    return publicDomain(domain);
  }

  async function bindWebsite(domainId, websiteId) {
    await ensureInitialized();
    const domain = hydrateDomain(requireDomain(state, domainId));
    const normalizedWebsiteId = await requireWebsiteBinding(websiteId, domain.serverId);
    if (normalizedWebsiteId === null) throw new DomainRegistryError('website_binding_required', 'A Website ID is required for domain migration');
    if (domain.websiteId === normalizedWebsiteId) return publicDomain(domain);
    if (domain.websiteId !== null) {
      throw new DomainRegistryError('domain_website_rebind_requires_preview', 'Changing an existing Domain Website binding requires an impact preview', 409);
    }
    domain.websiteId = normalizedWebsiteId;
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicDomain(domain);
  }

  async function rollbackWebsiteBinding(domainId, websiteId) {
    await ensureInitialized();
    const domain = hydrateDomain(requireDomain(state, domainId));
    const expectedWebsiteId = normalizeWebsiteId(websiteId);
    if (expectedWebsiteId === null) throw new DomainRegistryError('website_binding_required', 'A Website ID is required for migration rollback');
    if (domain.websiteId === null) return publicDomain(domain);
    if (domain.websiteId !== expectedWebsiteId) {
      throw new DomainRegistryError('domain_website_rollback_mismatch', 'Domain Website binding does not match migration rollback identity', 409);
    }
    domain.websiteId = null;
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicDomain(domain);
  }

  function assertRemovalSuspension(domain, {
    expectedRevision,
    checksum,
    suspensionOperationId: expectedSuspensionOperationId,
  } = {}) {
    const expectedChecksum = suspensionChecksum(checksum);
    const expectedOperationId = suspensionOperationId(expectedSuspensionOperationId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || domain.state !== 'suspended'
      || domain.desiredRevision !== expectedRevision
      || domain.stagedRevision !== expectedRevision
      || domain.appliedRevision !== expectedRevision
      || domain.stagedChecksum !== expectedChecksum
      || domain.suspendedChecksum !== expectedChecksum
      || domain.suspensionOperationId !== expectedOperationId
      || domain.appliedPrimaryDomain !== domain.primaryDomain
      || domain.lastError !== null) {
      throw new DomainRegistryError(
        'domain_removal_suspension_evidence_invalid',
        'Domain removal dependency changes require exact suspended routing evidence',
        409,
      );
    }
    return Object.freeze({
      expectedRevision,
      checksum: expectedChecksum,
      suspensionOperationId: expectedOperationId,
    });
  }

  async function detachWebsiteForRemoval(domainId, {
    expectedWebsiteId,
    expectedRevision,
    checksum,
    suspensionOperationId: expectedSuspensionOperationId,
  } = {}) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    const suspension = assertRemovalSuspension(domain, {
      expectedRevision,
      checksum,
      suspensionOperationId: expectedSuspensionOperationId,
    });
    const websiteId = normalizeWebsiteId(expectedWebsiteId);
    if (websiteId === null) {
      throw new DomainRegistryError(
        'domain_removal_website_id_invalid',
        'Domain removal requires the exact Website binding identity',
      );
    }
    if (domain.websiteId === null) {
      return Object.freeze({
        changed: false,
        domain: publicDomain(domain),
        detachedWebsiteId: websiteId,
        suspension,
      });
    }
    if (domain.websiteId !== websiteId) {
      throw new DomainRegistryError(
        'domain_removal_website_binding_drift',
        'Domain Website binding changed before removal cleanup',
        409,
      );
    }
    domain.websiteId = null;
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return Object.freeze({
      changed: true,
      domain: publicDomain(domain),
      detachedWebsiteId: websiteId,
      suspension,
    });
  }

  async function detachCertificateForRemoval(domainId, {
    expectedCertificateId,
    expectedRevision,
    checksum,
    suspensionOperationId: expectedSuspensionOperationId,
  } = {}) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    const suspension = assertRemovalSuspension(domain, {
      expectedRevision,
      checksum,
      suspensionOperationId: expectedSuspensionOperationId,
    });
    if (typeof expectedCertificateId !== 'string' || expectedCertificateId.length < 1
      || expectedCertificateId.length > 256
      || /[\u0000-\u001f\u007f]/.test(expectedCertificateId)) {
      throw new DomainRegistryError(
        'domain_removal_certificate_id_invalid',
        'Domain removal requires the exact certificate binding identity',
      );
    }
    if (domain.certificateId === null) {
      return Object.freeze({
        changed: false,
        domain: publicDomain(domain),
        detachedCertificateId: expectedCertificateId,
        suspension,
      });
    }
    if (domain.certificateId !== expectedCertificateId) {
      throw new DomainRegistryError(
        'domain_removal_certificate_binding_drift',
        'Domain certificate binding changed before removal cleanup',
        409,
      );
    }
    domain.certificateId = null;
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return Object.freeze({
      changed: true,
      domain: publicDomain(domain),
      detachedCertificateId: expectedCertificateId,
      suspension,
    });
  }

  async function listDomains() {
    await ensureInitialized();
    return state.domains.map((domain) => publicDomain(hydrateDomain(domain)));
  }

  async function getDomain(domainId) {
    await ensureInitialized();
    const domain = state.domains.find((candidate) => candidate.id === domainId);
    return domain ? publicDomain(hydrateDomain(domain)) : null;
  }

  async function attachCertificate(domainId, certificateId, { domains = null } = {}) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    if (domain.state === 'suspended') {
      throw new DomainRegistryError(
        'domain_suspended_update_blocked',
        'Resume the Domain before changing certificate routing state',
        409,
      );
    }
    if (domain.httpsMode !== 'managed') throw new DomainRegistryError('https_not_managed', 'Certificate can only be attached to a managed HTTPS domain', 409);
    if (typeof certificateId !== 'string' || !certificateId) throw new DomainRegistryError('invalid_certificate', 'certificateId is required');
    if (domains !== null) {
      const covered = normalizeDomains(domains?.[0], domains?.slice(1) ?? []);
      if ([covered.primary, ...covered.aliases].join('\n') !== [domain.primaryDomain, ...domain.aliases].join('\n')) {
        throw new DomainRegistryError('certificate_domain_mismatch', 'Certificate domains do not match current Domain routing state', 409);
      }
    }
    if (domain.certificateId === certificateId) return publicDomain(domain);
    domain.certificateId = certificateId;
    domain.desiredRevision += 1;
    domain.stagedRevision = 0;
    domain.stagedChecksum = null;
    domain.stagedConfigName = null;
    domain.lastStagedAt = null;
    domain.state = 'draft';
    domain.lastError = null;
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicDomain(domain);
  }

  async function activateProvisionedDomains({ websiteId, domains, checksum, configName } = {}) {
    await ensureInitialized();
    const normalizedWebsiteId = normalizeWebsiteId(websiteId);
    if (normalizedWebsiteId === null) {
      throw new DomainRegistryError('provisioned_domains_website_invalid', 'Provisioned Domains require a Website identity');
    }
    const expected = provisioningDomains(domains);
    if (typeof checksum !== 'string' || !SHA256_PATTERN.test(checksum)) {
      throw new DomainRegistryError('invalid_staged_checksum', 'Provisioned Domain checksum is invalid');
    }
    if (typeof configName !== 'string' || configName.length < 1 || configName.length > 300) {
      throw new DomainRegistryError('invalid_staged_config', 'Provisioned Domain config name is invalid');
    }

    let changed = false;
    const targets = expected.map((entry) => {
      const domain = requireDomain(state, entry.domainId);
      if (domain.websiteId !== normalizedWebsiteId || domain.desiredRevision !== entry.expectedRevision) {
        throw new DomainRegistryError('provisioned_domain_state_drift', 'Provisioned Domain identity or desired revision changed before activation', 409);
      }
      const active = domain.stagedRevision === entry.expectedRevision
        && domain.appliedRevision === entry.expectedRevision
        && domain.stagedChecksum === checksum
        && domain.stagedConfigName === configName
        && domain.appliedPrimaryDomain === domain.primaryDomain
        && domain.state === 'active'
        && domain.lastError === null;
      const pristine = domain.certificateId === null
        && domain.stagedRevision === 0 && domain.appliedRevision === 0
        && domain.stagedChecksum === null && domain.stagedConfigName === null
        && domain.lastStagedAt === null && domain.lastAppliedAt === null
        && domain.appliedPrimaryDomain === null && domain.state === 'draft'
        && domain.lastError === null;
      if (!active && !pristine) {
        throw new DomainRegistryError('provisioned_domain_state_drift', 'Provisioned Domain routing state changed before activation', 409);
      }
      changed ||= pristine;
      return { domain, active };
    });

    if (changed) {
      const timestamp = new Date(now()).toISOString();
      for (const { domain, active } of targets) {
        if (active) continue;
        domain.stagedRevision = domain.desiredRevision;
        domain.stagedChecksum = checksum;
        domain.stagedConfigName = configName;
        domain.lastStagedAt = timestamp;
        domain.appliedRevision = domain.desiredRevision;
        domain.appliedPrimaryDomain = domain.primaryDomain;
        domain.lastAppliedAt = timestamp;
        domain.state = 'active';
        domain.lastError = null;
        domain.updatedAt = timestamp;
      }
      await persist();
    }
    return Object.freeze(targets.map(({ domain }) => Object.freeze(publicDomain(domain))));
  }

  async function resetProvisionedDomains({ websiteId, domains, checksum, configName } = {}) {
    await ensureInitialized();
    const normalizedWebsiteId = normalizeWebsiteId(websiteId);
    if (normalizedWebsiteId === null) {
      throw new DomainRegistryError('provisioned_domains_website_invalid', 'Provisioned Domains require a Website identity');
    }
    const expected = provisioningDomains(domains);
    if (typeof checksum !== 'string' || !SHA256_PATTERN.test(checksum)) {
      throw new DomainRegistryError('invalid_staged_checksum', 'Provisioned Domain checksum is invalid');
    }
    if (typeof configName !== 'string' || configName.length < 1 || configName.length > 300) {
      throw new DomainRegistryError('invalid_staged_config', 'Provisioned Domain config name is invalid');
    }

    let changed = false;
    const targets = expected.map((entry) => {
      const domain = requireDomain(state, entry.domainId);
      if (domain.websiteId !== normalizedWebsiteId || domain.desiredRevision !== entry.expectedRevision) {
        throw new DomainRegistryError('provisioned_domain_compensation_drift', 'Provisioned Domain identity or desired revision changed before compensation', 409);
      }
      const pristine = domain.certificateId === null
        && domain.stagedRevision === 0 && domain.appliedRevision === 0
        && domain.stagedChecksum === null && domain.stagedConfigName === null
        && domain.lastStagedAt === null && domain.lastAppliedAt === null
        && domain.appliedPrimaryDomain === null && domain.state === 'draft'
        && domain.lastError === null;
      const ownedActive = domain.certificateId === null
        && domain.stagedRevision === entry.expectedRevision
        && domain.appliedRevision === entry.expectedRevision
        && domain.stagedChecksum === checksum
        && domain.stagedConfigName === configName
        && domain.appliedPrimaryDomain === domain.primaryDomain
        && domain.state === 'active'
        && domain.lastError === null;
      if (!pristine && !ownedActive) {
        throw new DomainRegistryError('provisioned_domain_compensation_drift', 'Provisioned Domain routing state changed after activation', 409);
      }
      changed ||= ownedActive;
      return { domain, pristine };
    });

    if (changed) {
      const timestamp = new Date(now()).toISOString();
      for (const { domain, pristine } of targets) {
        if (pristine) continue;
        domain.stagedRevision = 0;
        domain.stagedChecksum = null;
        domain.stagedConfigName = null;
        domain.lastStagedAt = null;
        domain.appliedRevision = 0;
        domain.appliedPrimaryDomain = null;
        domain.lastAppliedAt = null;
        domain.state = 'draft';
        domain.lastError = null;
        domain.updatedAt = timestamp;
      }
      await persist();
    }
    return Object.freeze(targets.map(({ domain }) => Object.freeze(publicDomain(domain))));
  }

  async function markStaged(domainId, { checksum, configName }) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    if (domain.state === 'suspended') {
      throw new DomainRegistryError(
        'domain_suspended_stage_blocked',
        'Resume the Domain before staging routing changes',
        409,
      );
    }
    if (typeof checksum !== 'string' || !SHA256_PATTERN.test(checksum)) throw new DomainRegistryError('invalid_staged_checksum', 'Staged domain checksum is invalid');
    if (typeof configName !== 'string' || configName.length < 1 || configName.length > 300) throw new DomainRegistryError('invalid_staged_config', 'Staged domain config name is invalid');
    const timestamp = new Date(now()).toISOString();
    domain.stagedRevision = domain.desiredRevision;
    domain.stagedChecksum = checksum;
    domain.stagedConfigName = configName;
    domain.lastStagedAt = timestamp;
    domain.state = 'staged';
    domain.lastError = null;
    domain.updatedAt = timestamp;
    await persist();
    return publicDomain(domain);
  }

  async function markApplied(domainId, { checksum } = {}) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    if (domain.state === 'suspended') {
      throw new DomainRegistryError(
        'domain_suspended_activation_blocked',
        'Resume the Domain through the suspension lifecycle before activation',
        409,
      );
    }
    if (domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum) throw new DomainRegistryError('staged_revision_required', 'Current desired domain revision has not been staged', 409);
    if (checksum !== domain.stagedChecksum) throw new DomainRegistryError('staged_checksum_mismatch', 'Activated checksum does not match staged desired state', 409);
    const timestamp = new Date(now()).toISOString();
    domain.appliedRevision = domain.desiredRevision;
    domain.appliedPrimaryDomain = domain.primaryDomain;
    domain.state = 'active';
    domain.lastAppliedAt = timestamp;
    domain.lastError = null;
    domain.updatedAt = timestamp;
    await persist();
    return publicDomain(domain);
  }

  async function markSuspended(domainId, {
    expectedRevision,
    checksum,
    operationId,
  } = {}) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    const expectedChecksum = suspensionChecksum(checksum);
    const expectedOperationId = suspensionOperationId(operationId);
    if (domain.state === 'suspended') {
      if (domain.desiredRevision !== expectedRevision
        || domain.suspendedChecksum !== expectedChecksum
        || domain.suspensionOperationId !== expectedOperationId) {
        throw new DomainRegistryError(
          'domain_suspension_state_drift',
          'Domain is already suspended by different routing evidence',
          409,
        );
      }
      return publicDomain(domain);
    }
    if (domain.state !== 'active') {
      throw new DomainRegistryError(
        'domain_suspension_active_required',
        'Only an active Domain can be suspended',
        409,
      );
    }
    assertSuspendable(domain, { expectedRevision, checksum: expectedChecksum });
    const timestamp = new Date(now()).toISOString();
    domain.state = 'suspended';
    domain.suspensionOperationId = expectedOperationId;
    domain.suspendedAt = timestamp;
    domain.suspendedChecksum = expectedChecksum;
    domain.updatedAt = timestamp;
    await persist();
    return publicDomain(domain);
  }

  async function markResumed(domainId, {
    expectedRevision,
    checksum,
    operationId,
  } = {}) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    const expectedChecksum = suspensionChecksum(checksum);
    const expectedOperationId = suspensionOperationId(operationId);
    if (domain.state === 'active'
      && domain.suspensionOperationId === null
      && domain.suspendedAt === null
      && domain.suspendedChecksum === null
      && domain.lastSuspensionOperationId === expectedOperationId
      && domain.desiredRevision === expectedRevision
      && domain.stagedRevision === expectedRevision
      && domain.appliedRevision === expectedRevision
      && domain.stagedChecksum === expectedChecksum
      && domain.appliedPrimaryDomain === domain.primaryDomain
      && domain.lastError === null) {
      return publicDomain(domain);
    }
    if (domain.state !== 'suspended'
      || domain.desiredRevision !== expectedRevision
      || domain.stagedRevision !== expectedRevision
      || domain.appliedRevision !== expectedRevision
      || domain.stagedChecksum !== expectedChecksum
      || domain.suspendedChecksum !== expectedChecksum
      || domain.suspensionOperationId !== expectedOperationId
      || domain.appliedPrimaryDomain !== domain.primaryDomain
      || domain.lastError !== null) {
      throw new DomainRegistryError(
        'domain_resume_state_drift',
        'Domain suspension state changed before resume',
        409,
      );
    }
    const timestamp = new Date(now()).toISOString();
    domain.state = 'active';
    domain.suspensionOperationId = null;
    domain.suspendedAt = null;
    domain.suspendedChecksum = null;
    domain.lastSuspensionOperationId = expectedOperationId;
    domain.lastResumedAt = timestamp;
    domain.lastAppliedAt = timestamp;
    domain.updatedAt = timestamp;
    await persist();
    return publicDomain(domain);
  }

  async function finalizeDomainRemoval(domainId, {
    operationId,
    expectedRevision,
    checksum,
    confirmation,
  } = {}) {
    await ensureInitialized();
    const normalizedDomainId = normalizeReparentId(domainId, 'domainId');
    const domain = requireDomain(state, normalizedDomainId);
    const expectedOperationId = suspensionOperationId(operationId);
    const expectedChecksum = suspensionChecksum(checksum);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainRegistryError(
        'invalid_domain_removal_revision',
        'Domain removal expected revision is invalid',
      );
    }
    const expectedConfirmation = removalConfirmation({
      domainId: domain.id,
      operationId: expectedOperationId,
      expectedRevision,
      checksum: expectedChecksum,
    });
    if (confirmation !== expectedConfirmation) {
      throw new DomainRegistryError(
        'domain_removal_confirmation_invalid',
        'Domain removal finalization confirmation is invalid',
        409,
      );
    }
    const descendants = descendantsOf(state.domains, domain.id);
    if (descendants.length > 0) {
      throw new DomainRegistryError(
        'domain_removal_descendants_present',
        'Domain cannot be finalized while child Domains remain',
        409,
      );
    }
    if (domain.websiteId !== null) {
      throw new DomainRegistryError(
        'domain_removal_website_binding_present',
        'Domain cannot be finalized while Website binding remains',
        409,
      );
    }
    if (domain.certificateId !== null) {
      throw new DomainRegistryError(
        'domain_removal_certificate_present',
        'Domain cannot be finalized while certificate binding remains',
        409,
      );
    }
    if (domain.state !== 'suspended'
      || domain.desiredRevision !== expectedRevision
      || domain.stagedRevision !== expectedRevision
      || domain.appliedRevision !== expectedRevision
      || domain.stagedChecksum !== expectedChecksum
      || domain.suspendedChecksum !== expectedChecksum
      || domain.suspensionOperationId !== expectedOperationId
      || domain.appliedPrimaryDomain !== domain.primaryDomain
      || domain.lastError !== null) {
      throw new DomainRegistryError(
        'domain_removal_suspension_evidence_invalid',
        'Domain removal finalization requires exact suspended routing evidence',
        409,
      );
    }

    const removed = Object.freeze({
      id: domain.id,
      serverId: domain.serverId,
      primaryDomain: domain.primaryDomain,
      parentDomainId: domain.parentDomainId ?? null,
      desiredRevision: domain.desiredRevision,
      suspensionOperationId: domain.suspensionOperationId,
      suspendedChecksum: domain.suspendedChecksum,
    });
    state.domains = state.domains.filter((candidate) => candidate.id !== domain.id);
    try { validateDomainHierarchy(state.domains); }
    catch (error) {
      if (error instanceof DomainHierarchyError) {
        throw new DomainRegistryError(error.code, error.message, error.status);
      }
      throw error;
    }
    await persist();
    return Object.freeze({
      removed: true,
      domain: removed,
      confirmation: expectedConfirmation,
    });
  }

  async function markFailed(domainId, errorCode) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    if (domain.state === 'suspended') {
      throw new DomainRegistryError(
        'domain_suspended_failure_blocked',
        'Suspended Domain state can be changed only through the resume lifecycle',
        409,
      );
    }
    domain.state = 'error';
    domain.lastError = typeof errorCode === 'string' && /^[a-z0-9_]{1,120}$/.test(errorCode) ? errorCode : 'apply_failed';
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicDomain(domain);
  }

  return {
    init,
    createDomain,
    previewDomainUpdate,
    updateDomain,
    previewDomainReparent,
    reparentDomain,
    bindWebsite,
    rollbackWebsiteBinding,
    detachWebsiteForRemoval,
    detachCertificateForRemoval,
    listDomains,
    getDomain,
    attachCertificate,
    activateProvisionedDomains,
    resetProvisionedDomains,
    markStaged,
    markApplied,
    markSuspended,
    markResumed,
    finalizeDomainRemoval,
    markFailed,
  };
}

export const domainRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  targetTypes: Object.freeze([...TARGET_TYPES]),
  domainStates: Object.freeze([...DOMAIN_STATES]),
  validateTarget,
  settingsFromTarget,
  targetWithSettings,
  normalizeWebsiteId,
  normalizeReparentId,
  descendantsOf,
  hierarchySnapshot,
  reparentDigest,
  normalizedUpdate,
  updateDigest,
  removalConfirmation,
  provisioningDomains,
  diagnosis,
  hydrateDomain,
});
