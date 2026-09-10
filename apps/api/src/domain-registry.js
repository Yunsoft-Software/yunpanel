import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';
import { DomainHierarchyError, validateDomainHierarchy, validateDomainParent } from './domain-hierarchy.js';

const STORE_VERSION = 1;
const TARGET_TYPES = new Set(['static', 'proxy']);
const HTTPS_MODES = new Set(['off', 'managed']);
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

function hydrateDomain(domain) {
  if (domain.websiteId === undefined) domain.websiteId = null;
  return domain;
}

function publicDomain(domain) {
  return {
    ...domain,
    websiteId: domain.websiteId ?? null,
    aliases: [...domain.aliases],
    target: { ...domain.target },
    parentDomainId: domain.parentDomainId ?? null,
    kind: domain.parentDomainId == null ? 'domain' : 'subdomain',
  };
}

function validateTarget(targetType, target) {
  if (!TARGET_TYPES.has(targetType)) throw new DomainRegistryError('invalid_target_type', 'targetType must be static or proxy');
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new DomainRegistryError('invalid_target', 'target must be an object');
  if (targetType === 'static') {
    if (typeof target.root !== 'string' || target.root.length < 2 || target.root.length > 500 || /[\u0000-\u001f\u007f]/.test(target.root)) {
      throw new DomainRegistryError('invalid_static_root', 'Static target root is invalid');
    }
    return { root: target.root, spaFallback: target.spaFallback !== false };
  }
  if (!Number.isInteger(target.upstreamPort) || target.upstreamPort < 1024 || target.upstreamPort > 65535) {
    throw new DomainRegistryError('invalid_upstream_port', 'Proxy upstreamPort must be between 1024 and 65535');
  }
  return { upstreamHost: '127.0.0.1', upstreamPort: target.upstreamPort, websocket: target.websocket !== false };
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
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.domains)) throw new Error('unsupported or invalid domain registry state');
        try {
          validateDomainHierarchy(parsed.domains);
          for (const domain of parsed.domains) normalizeWebsiteId(domain.websiteId ?? null);
        } catch (error) {
          if (error instanceof DomainHierarchyError || error instanceof DomainRegistryError) throw error;
          throw error;
        }
        state = parsed;
        state.domains.forEach(hydrateDomain);
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

  async function createDomain({ serverId, primaryDomain, aliases = [], targetType, target, httpsMode = 'off', parentDomainId = null, websiteId = null }) {
    await ensureInitialized();
    if (typeof serverId !== 'string' || !serverId) throw new DomainRegistryError('invalid_server', 'serverId is required');
    if (!(await serverExists(serverId))) throw new DomainRegistryError('server_not_found', 'Target server does not exist', 404);
    if (!HTTPS_MODES.has(httpsMode)) throw new DomainRegistryError('invalid_https_mode', 'httpsMode must be off or managed');

    const normalizedWebsiteId = await requireWebsiteBinding(websiteId, serverId);
    if (normalizedWebsiteId === null && websiteBindingRequired() === true) {
      throw new DomainRegistryError('website_binding_required', 'New managed domains require an explicit Website binding', 409);
    }
    const normalized = normalizeDomains(primaryDomain, aliases);
    try { validateDomainParent(state.domains, { serverId, primaryDomain: normalized.primary, parentDomainId }); }
    catch (error) {
      if (error instanceof DomainHierarchyError) throw new DomainRegistryError(error.code, error.message, error.status);
      throw error;
    }
    const requestedNames = new Set([normalized.primary, ...normalized.aliases]);
    const conflict = state.domains.find((domain) => ownedNames(domain).some((ownedName) => requestedNames.has(ownedName)));
    if (conflict) throw new DomainRegistryError('domain_conflict', 'A domain or alias is already managed', 409);

    const timestamp = new Date(now()).toISOString();
    const domain = {
      id: randomUUID(), serverId, websiteId: normalizedWebsiteId, primaryDomain: normalized.primary, parentDomainId,
      aliases: normalized.aliases, targetType, target: validateTarget(targetType, target), httpsMode, certificateId: null,
      state: 'draft', desiredRevision: 1, stagedRevision: 0, stagedChecksum: null, stagedConfigName: null,
      lastStagedAt: null, appliedRevision: 0, lastAppliedAt: null, lastError: null, createdAt: timestamp, updatedAt: timestamp,
    };
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

  async function listDomains() {
    await ensureInitialized();
    return state.domains.map((domain) => publicDomain(hydrateDomain(domain)));
  }

  async function getDomain(domainId) {
    await ensureInitialized();
    const domain = state.domains.find((candidate) => candidate.id === domainId);
    return domain ? publicDomain(hydrateDomain(domain)) : null;
  }

  async function attachCertificate(domainId, certificateId) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    if (domain.httpsMode !== 'managed') throw new DomainRegistryError('https_not_managed', 'Certificate can only be attached to a managed HTTPS domain', 409);
    if (typeof certificateId !== 'string' || !certificateId) throw new DomainRegistryError('invalid_certificate', 'certificateId is required');
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

  async function markStaged(domainId, { checksum, configName }) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
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
    if (domain.stagedRevision !== domain.desiredRevision || !domain.stagedChecksum) throw new DomainRegistryError('staged_revision_required', 'Current desired domain revision has not been staged', 409);
    if (checksum !== domain.stagedChecksum) throw new DomainRegistryError('staged_checksum_mismatch', 'Activated checksum does not match staged desired state', 409);
    const timestamp = new Date(now()).toISOString();
    domain.appliedRevision = domain.desiredRevision;
    domain.state = 'active';
    domain.lastAppliedAt = timestamp;
    domain.lastError = null;
    domain.updatedAt = timestamp;
    await persist();
    return publicDomain(domain);
  }

  async function markFailed(domainId, errorCode) {
    await ensureInitialized();
    const domain = requireDomain(state, domainId);
    domain.state = 'error';
    domain.lastError = typeof errorCode === 'string' ? errorCode.slice(0, 120) : 'apply_failed';
    domain.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicDomain(domain);
  }

  return {
    init,
    createDomain,
    bindWebsite,
    rollbackWebsiteBinding,
    listDomains,
    getDomain,
    attachCertificate,
    markStaged,
    markApplied,
    markFailed,
  };
}

export const domainRegistryInternals = Object.freeze({ storeVersion: STORE_VERSION, normalizeWebsiteId, hydrateDomain });
