import { createHash } from 'node:crypto';
import {
  ApplicationValidationError,
  assertUuid,
  DomainValidationError,
  normalizeDomainSet,
  normalizeGitBranch,
  normalizeGithubRepositoryUrl,
  normalizeNodeRuntimeConfig,
  normalizeProxyHost,
  normalizeStaticBuildConfig,
  ProxyTargetValidationError,
} from '@yunpanel/shared';
import { DomainHierarchyError, validateDomainParent } from './domain-hierarchy.js';

const SITE_NAMESPACE = Buffer.from('0bcd2cf8883b49f997294b5d225cf15e', 'hex');
const SOURCE_KINDS = new Set(['existing_application', 'new_static', 'new_node', 'external_proxy']);
const WWW_MODES = new Set(['none', 'alias', 'independent']);
const HTTPS_MODES = new Set(['off', 'managed']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class SiteCreateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SiteCreateError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch { throw new SiteCreateError('site_create_invalid_id', `${field} must be a UUID`); }
}

function resourceId(operationId, resource) {
  const operation = uuid(operationId, 'operationId');
  const digest = createHash('sha1').update(SITE_NAMESPACE).update(operation).update(':').update(resource).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactObject(value, fields, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.has(key)) || Object.keys(value).length !== fields.size) {
    throw new SiteCreateError(code, message);
  }
  return value;
}

function displayName(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SiteCreateError('site_create_name_invalid', 'Site name must be a printable string up to 80 characters');
  }
  return value.trim();
}

function retention(value) {
  if (value === undefined) return 5;
  if (!Number.isInteger(value) || value < 2 || value > 20) {
    throw new SiteCreateError('site_create_retention_invalid', 'Retention must be between 2 and 20');
  }
  return value;
}

function normalizedSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || !SOURCE_KINDS.has(source.kind)) {
    if (source?.kind === 'docker') throw new SiteCreateError('site_create_target_not_supported', 'Docker site creation is not implemented yet', 409);
    throw new SiteCreateError('site_create_source_invalid', 'Site source kind is invalid');
  }
  try {
    if (source.kind === 'existing_application') {
      exactObject(source, new Set(['kind', 'applicationId']), 'site_create_source_invalid', 'Existing application source requires only kind and applicationId');
      return Object.freeze({ kind: source.kind, applicationId: uuid(source.applicationId, 'applicationId') });
    }
    if (source.kind === 'external_proxy') {
      exactObject(source, new Set(['kind', 'target']), 'site_create_source_invalid', 'External proxy source requires only kind and target');
      if (!source.target || typeof source.target !== 'object' || Array.isArray(source.target)
        || Object.keys(source.target).some((key) => !['host', 'port', 'websocket'].includes(key))) {
        throw new SiteCreateError('site_create_proxy_invalid', 'External proxy target accepts only host, port and websocket');
      }
      if (!Number.isInteger(source.target.port) || source.target.port < 1024 || source.target.port > 65535
        || (source.target.websocket !== undefined && typeof source.target.websocket !== 'boolean')) {
        throw new SiteCreateError('site_create_proxy_invalid', 'External proxy port or websocket setting is invalid');
      }
      return Object.freeze({
        kind: source.kind,
        target: Object.freeze({
          host: normalizeProxyHost(source.target.host),
          port: source.target.port,
          websocket: source.target.websocket !== false,
        }),
      });
    }

    const allowed = source.kind === 'new_static'
      ? new Set(['kind', 'repositoryUrl', 'branch', 'build', 'retention'])
      : new Set(['kind', 'repositoryUrl', 'branch', 'runtime', 'retention']);
    if (Object.keys(source).some((key) => !allowed.has(key))) {
      throw new SiteCreateError('site_create_source_invalid', 'New application source contains unsupported fields');
    }
    const common = {
      kind: source.kind,
      repositoryUrl: normalizeGithubRepositoryUrl(source.repositoryUrl),
      branch: normalizeGitBranch(source.branch ?? 'main'),
      retention: retention(source.retention),
    };
    if (source.kind === 'new_static') {
      if (source.build !== undefined && (!source.build || typeof source.build !== 'object' || Array.isArray(source.build)
        || Object.keys(source.build).some((key) => !['mode', 'installMode', 'buildScript', 'outputDir', 'healthFile'].includes(key)))) {
        throw new SiteCreateError('site_create_static_build_invalid', 'Static build contains unsupported fields');
      }
      return Object.freeze({ ...common, build: Object.freeze(normalizeStaticBuildConfig(source.build ?? {})) });
    }
    if (!source.runtime || typeof source.runtime !== 'object' || Array.isArray(source.runtime)
      || Object.hasOwn(source.runtime, 'port')
      || Object.keys(source.runtime).some((key) => ![
        'nodeMajor', 'installMode', 'buildScript', 'startMode', 'start', 'entryFile', 'startScript',
        'healthPath', 'healthTimeoutSeconds', 'restartPolicy',
      ].includes(key))) {
      throw new SiteCreateError('site_create_node_runtime_invalid', 'Node runtime must omit backend-assigned port and unsupported fields');
    }
    if (source.runtime.start !== undefined && (!source.runtime.start || typeof source.runtime.start !== 'object'
      || Array.isArray(source.runtime.start)
      || Object.keys(source.runtime.start).some((key) => !['mode', 'entryFile', 'script'].includes(key)))) {
      throw new SiteCreateError('site_create_node_runtime_invalid', 'Node start config contains unsupported fields');
    }
    return Object.freeze({ ...common, runtime: Object.freeze({ ...source.runtime }) });
  } catch (error) {
    if (error instanceof SiteCreateError) throw error;
    if (error instanceof ApplicationValidationError || error instanceof ProxyTargetValidationError) {
      throw new SiteCreateError(error.code, error.message);
    }
    throw error;
  }
}

function normalizeInput(input) {
  exactObject(input, new Set([
    'operationId', 'serverId', 'name', 'primaryDomain', 'parentDomainId', 'wwwMode', 'httpsMode', 'source',
  ]), 'site_create_input_invalid', 'Send the complete documented site-create input');
  if (!WWW_MODES.has(input.wwwMode)) throw new SiteCreateError('site_create_www_mode_invalid', 'wwwMode must be none, alias or independent');
  if (!HTTPS_MODES.has(input.httpsMode)) throw new SiteCreateError('site_create_https_mode_invalid', 'httpsMode must be off or managed');
  const operationId = uuid(input.operationId, 'operationId');
  const serverId = uuid(input.serverId, 'serverId');
  const parentDomainId = input.parentDomainId === null ? null : uuid(input.parentDomainId, 'parentDomainId');
  let primary;
  try { primary = normalizeDomainSet(input.primaryDomain, []).primary; }
  catch (error) {
    if (error instanceof DomainValidationError) throw new SiteCreateError(error.code, error.message);
    throw error;
  }
  if (input.wwwMode !== 'none' && primary.startsWith('www.')) {
    throw new SiteCreateError('site_create_www_mode_invalid', 'wwwMode must be none when the primary hostname already starts with www');
  }
  let aliases = [];
  let wwwPrimaryDomain = null;
  if (input.wwwMode === 'alias') {
    try { aliases = normalizeDomainSet(primary, [`www.${primary}`]).aliases; }
    catch (error) {
      if (error instanceof DomainValidationError) throw new SiteCreateError(error.code, error.message);
      throw error;
    }
  } else if (input.wwwMode === 'independent') {
    try { wwwPrimaryDomain = normalizeDomainSet(`www.${primary}`, []).primary; }
    catch (error) {
      if (error instanceof DomainValidationError) throw new SiteCreateError(error.code, error.message);
      throw error;
    }
  }
  return Object.freeze({
    operationId,
    serverId,
    name: displayName(input.name),
    primaryDomain: primary,
    parentDomainId,
    wwwMode: input.wwwMode,
    httpsMode: input.httpsMode,
    aliases: Object.freeze(aliases),
    wwwPrimaryDomain,
    source: normalizedSource(input.source),
  });
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableApplication(application) {
  return {
    id: application.id,
    serverId: application.serverId,
    name: application.name,
    type: application.type,
    repositoryUrl: application.repositoryUrl,
    branch: application.branch,
    retention: application.retention,
    build: application.build ?? null,
    runtime: application.runtime ?? null,
    webRoot: application.webRoot ?? null,
  };
}

function stableWebsite(website) {
  return {
    id: website.id,
    serverId: website.serverId,
    name: website.name,
    applicationId: website.applicationId,
    runtimeType: website.runtimeType,
    documentRoot: website.documentRoot,
    unixUser: website.unixUser,
    proxyTarget: website.proxyTarget,
    revision: website.revision,
  };
}

function stableDomain(domain) {
  return {
    id: domain.id,
    serverId: domain.serverId,
    websiteId: domain.websiteId ?? null,
    primaryDomain: domain.primaryDomain,
    parentDomainId: domain.parentDomainId ?? null,
    aliases: [...domain.aliases],
    targetType: domain.targetType,
    target: domain.target,
    httpsMode: domain.httpsMode,
  };
}

function ensureExact(existing, expected, code, message, project = (value) => value) {
  if (!existing) return false;
  if (!same(project(existing), expected)) throw new SiteCreateError(code, message, 409);
  return true;
}

function domainTarget(application, source) {
  if (source.kind === 'external_proxy') {
    return Object.freeze({
      targetType: 'proxy',
      target: Object.freeze({ upstreamHost: source.target.host, upstreamPort: source.target.port, websocket: source.target.websocket }),
    });
  }
  if (application.type === 'static') {
    if (application.webRoot !== `/var/www/yunpanel/apps/${application.id}/current`) {
      throw new SiteCreateError('site_create_application_root_drift', 'Selected static Application document root is outside managed state', 409);
    }
    return Object.freeze({ targetType: 'static', target: Object.freeze({ root: application.webRoot, spaFallback: true }) });
  }
  if (!application.proxyTarget || application.proxyTarget.host !== '127.0.0.1'
    || !Number.isInteger(application.proxyTarget.port) || application.proxyTarget.port !== application.runtime?.port) {
    throw new SiteCreateError('site_create_application_proxy_drift', 'Selected Node Application proxy target does not match managed runtime state', 409);
  }
  return Object.freeze({
    targetType: 'proxy',
    target: Object.freeze({ upstreamHost: application.proxyTarget.host, upstreamPort: application.proxyTarget.port, websocket: true }),
  });
}

function validatePlannedDomain(domains, expected) {
  const existing = domains.find((domain) => domain.id === expected.id) ?? null;
  const ownedElsewhere = domains.find((domain) => domain.id !== expected.id
    && [domain.primaryDomain, ...domain.aliases].some((hostname) => [expected.primaryDomain, ...expected.aliases].includes(hostname)));
  if (ownedElsewhere) throw new SiteCreateError('site_create_domain_conflict', 'A planned hostname or alias is already managed', 409);
  ensureExact(existing, expected, 'site_create_domain_identity_conflict', 'Planned Domain identity conflicts with existing state', stableDomain);
  return Boolean(existing);
}

function canonicalState({ applications, websites, domains, excludedIds, selectedApplicationId, serverId }) {
  return {
    applications: applications.filter((item) => item.serverId === serverId
      && (item.id !== excludedIds.applicationId || item.id === selectedApplicationId))
      .map(stableApplication).sort((left, right) => left.id.localeCompare(right.id)),
    websites: websites.filter((item) => item.serverId === serverId && item.id !== excludedIds.websiteId)
      .map(stableWebsite).sort((left, right) => left.id.localeCompare(right.id)),
    domains: domains.filter((item) => item.serverId === serverId && !excludedIds.domainIds.has(item.id))
      .map(stableDomain).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function previewSiteCreate({ input, registry, applicationRegistry, websiteRegistry, domainRegistry } = {}) {
  for (const [dependency, methods] of [
    [registry, ['getServer']],
    [applicationRegistry, ['getApplication', 'listApplications', 'allocateNodePort']],
    [websiteRegistry, ['getWebsite', 'listWebsites']],
    [domainRegistry, ['getDomain', 'listDomains']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      throw new SiteCreateError('site_create_dependencies_invalid', 'Site-create dependencies are unavailable', 503);
    }
  }
  const normalized = normalizeInput(input);
  if (!(await registry.getServer(normalized.serverId))) throw new SiteCreateError('server_not_found', 'Target server does not exist', 404);

  const ids = Object.freeze({
    applicationId: ['new_static', 'new_node'].includes(normalized.source.kind) ? resourceId(normalized.operationId, 'application') : null,
    websiteId: resourceId(normalized.operationId, 'website'),
    primaryDomainId: resourceId(normalized.operationId, 'primary-domain'),
    wwwDomainId: normalized.wwwMode === 'independent' ? resourceId(normalized.operationId, 'www-domain') : null,
  });
  const [applications, websites, domains] = await Promise.all([
    applicationRegistry.listApplications(), websiteRegistry.listWebsites(), domainRegistry.listDomains(),
  ]);

  let application = null;
  let applicationExpected = null;
  let assignedPort = null;
  if (normalized.source.kind === 'existing_application') {
    application = applications.find((candidate) => candidate.id === normalized.source.applicationId) ?? null;
    if (!application) throw new SiteCreateError('application_not_found', 'Selected Application does not exist', 404);
    if (application.serverId !== normalized.serverId) throw new SiteCreateError('site_create_application_server_mismatch', 'Selected Application belongs to a different server', 409);
    if (!['static', 'node'].includes(application.type)) throw new SiteCreateError('site_create_application_type_unsupported', 'Selected Application type is not supported', 409);
  } else if (normalized.source.kind === 'new_static') {
    applicationExpected = {
      id: ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
      type: 'static',
      repositoryUrl: normalized.source.repositoryUrl,
      branch: normalized.source.branch,
      retention: normalized.source.retention,
      build: normalized.source.build,
      runtime: null,
      webRoot: `/var/www/yunpanel/apps/${ids.applicationId}/current`,
    };
    const existing = applications.find((candidate) => candidate.id === ids.applicationId) ?? null;
    ensureExact(existing, applicationExpected, 'site_create_application_identity_conflict', 'Planned Application identity conflicts with existing state', stableApplication);
    application = existing ?? applicationExpected;
  } else if (normalized.source.kind === 'new_node') {
    const existing = applications.find((candidate) => candidate.id === ids.applicationId) ?? null;
    if (existing) assignedPort = existing.runtime?.port;
    else {
      const reservedPorts = domains.filter((domain) => domain.serverId === normalized.serverId
        && domain.targetType === 'proxy' && LOOPBACK_HOSTS.has(domain.target?.upstreamHost))
        .map((domain) => domain.target.upstreamPort);
      assignedPort = await applicationRegistry.allocateNodePort({ serverId: normalized.serverId, reservedPorts });
    }
    let runtime;
    try { runtime = normalizeNodeRuntimeConfig({ ...normalized.source.runtime, port: assignedPort }); }
    catch (error) {
      if (error instanceof ApplicationValidationError) throw new SiteCreateError(error.code, error.message);
      throw error;
    }
    applicationExpected = {
      id: ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
      type: 'node',
      repositoryUrl: normalized.source.repositoryUrl,
      branch: normalized.source.branch,
      retention: normalized.source.retention,
      build: null,
      runtime,
      webRoot: null,
    };
    ensureExact(existing, applicationExpected, 'site_create_application_identity_conflict', 'Planned Application identity conflicts with existing state', stableApplication);
    application = existing ?? { ...applicationExpected, proxyTarget: { host: '127.0.0.1', port: assignedPort } };
  }

  if (application) {
    const boundElsewhere = websites.find((website) => website.applicationId === application.id && website.id !== ids.websiteId);
    if (boundElsewhere) throw new SiteCreateError('application_already_bound', 'Application is already bound to another Website', 409);
  }
  const target = domainTarget(application, normalized.source);
  const websiteExpected = normalized.source.kind === 'external_proxy'
    ? {
        id: ids.websiteId, serverId: normalized.serverId, name: normalized.name, applicationId: null,
        runtimeType: 'proxy', documentRoot: null, unixUser: null, proxyTarget: normalized.source.target, revision: 1,
      }
    : {
        id: ids.websiteId, serverId: normalized.serverId, name: normalized.name, applicationId: application.id,
        runtimeType: application.type, documentRoot: application.type === 'static' ? application.webRoot : `/var/lib/yunpanel/apps/${application.id}/current`,
        unixUser: `yunapp-${createHash('sha256').update(application.id).digest('hex').slice(0, 12)}`, proxyTarget: null, revision: 1,
      };
  const websiteExisting = websites.find((candidate) => candidate.id === ids.websiteId) ?? null;
  const websiteReady = ensureExact(websiteExisting, websiteExpected, 'site_create_website_identity_conflict', 'Planned Website identity conflicts with existing state', stableWebsite);

  const primaryExpected = {
    id: ids.primaryDomainId,
    serverId: normalized.serverId,
    websiteId: ids.websiteId,
    primaryDomain: normalized.primaryDomain,
    parentDomainId: normalized.parentDomainId,
    aliases: [...normalized.aliases],
    targetType: target.targetType,
    target: target.target,
    httpsMode: normalized.httpsMode,
  };
  const primaryReady = validatePlannedDomain(domains, primaryExpected);
  const prospectiveDomains = primaryReady ? domains : [...domains, primaryExpected];
  try { validateDomainParent(prospectiveDomains, primaryExpected); }
  catch (error) {
    if (error instanceof DomainHierarchyError) throw new SiteCreateError(error.code, error.message, error.status);
    throw error;
  }

  let wwwExpected = null;
  let wwwReady = false;
  if (normalized.wwwMode === 'independent') {
    wwwExpected = {
      id: ids.wwwDomainId,
      serverId: normalized.serverId,
      websiteId: ids.websiteId,
      primaryDomain: normalized.wwwPrimaryDomain,
      parentDomainId: ids.primaryDomainId,
      aliases: [],
      targetType: target.targetType,
      target: target.target,
      httpsMode: normalized.httpsMode,
    };
    wwwReady = validatePlannedDomain(domains, wwwExpected);
    try { validateDomainParent(wwwReady ? prospectiveDomains : [...prospectiveDomains, wwwExpected], wwwExpected); }
    catch (error) {
      if (error instanceof DomainHierarchyError) throw new SiteCreateError(error.code, error.message, error.status);
      throw error;
    }
  }

  const applicationReady = normalized.source.kind === 'existing_application'
    || normalized.source.kind === 'external_proxy'
    || applications.some((candidate) => candidate.id === ids.applicationId);
  const state = canonicalState({
    applications,
    websites,
    domains,
    excludedIds: { applicationId: ids.applicationId, websiteId: ids.websiteId, domainIds: new Set([ids.primaryDomainId, ids.wwwDomainId].filter(Boolean)) },
    selectedApplicationId: normalized.source.kind === 'existing_application' ? normalized.source.applicationId : null,
    serverId: normalized.serverId,
  });
  const planCore = {
    version: 1,
    input: normalized,
    resources: { application: applicationExpected ?? (application ? stableApplication(application) : null), website: websiteExpected, primaryDomain: primaryExpected, wwwDomain: wwwExpected },
    state,
  };
  const previewDigest = createHash('sha256').update(JSON.stringify(planCore)).digest('hex');
  const complete = applicationReady && websiteReady && primaryReady && (normalized.wwwMode !== 'independent' || wwwReady);
  return Object.freeze({
    version: 1,
    operationId: normalized.operationId,
    previewDigest,
    confirmation: `create-site:${normalized.operationId}:${previewDigest}`,
    destructive: false,
    autoApply: false,
    complete,
    resumeRequired: !complete && (applicationReady || websiteReady || primaryReady || wwwReady),
    assignedPort,
    ids,
    source: normalized.source,
    hostname: Object.freeze({
      primaryDomain: normalized.primaryDomain,
      parentDomainId: normalized.parentDomainId,
      wwwMode: normalized.wwwMode,
      aliases: normalized.aliases,
      independentWwwDomain: normalized.wwwPrimaryDomain,
    }),
    steps: Object.freeze({ applicationReady, websiteReady, primaryDomainReady: primaryReady, wwwDomainReady: normalized.wwwMode === 'independent' ? wwwReady : null }),
    lifecycle: Object.freeze({ dnsPublished: false, certificateIssued: false, mailDomainCreated: false }),
    plan: Object.freeze(planCore.resources),
  });
}

export async function createSite({ input, previewDigest, confirmation, registry, applicationRegistry, websiteRegistry, domainRegistry } = {}) {
  if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
    throw new SiteCreateError('site_create_preview_digest_invalid', 'A current site-create preview digest is required');
  }
  const preview = await previewSiteCreate({ input, registry, applicationRegistry, websiteRegistry, domainRegistry });
  if (preview.previewDigest !== previewDigest) {
    throw new SiteCreateError('site_create_preview_stale', 'Site-create state changed after preview; request a new preview', 409);
  }
  if (confirmation !== preview.confirmation) {
    throw new SiteCreateError('site_create_confirmation_required', `Confirm site creation with ${preview.confirmation}`);
  }
  const normalized = normalizeInput(input);
  let application = normalized.source.kind === 'existing_application'
    ? await applicationRegistry.getApplication(normalized.source.applicationId)
    : null;
  if (normalized.source.kind === 'new_static') {
    application = await applicationRegistry.createApplication({
      applicationId: preview.ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
      repositoryUrl: normalized.source.repositoryUrl,
      branch: normalized.source.branch,
      build: normalized.source.build,
      retention: normalized.source.retention,
    });
  } else if (normalized.source.kind === 'new_node') {
    application = await applicationRegistry.createNodeApplication({
      applicationId: preview.ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
      repositoryUrl: normalized.source.repositoryUrl,
      branch: normalized.source.branch,
      runtime: { ...normalized.source.runtime, port: preview.assignedPort },
      retention: normalized.source.retention,
    });
  }

  const website = await websiteRegistry.createWebsite({
    websiteId: preview.ids.websiteId,
    serverId: normalized.serverId,
    name: normalized.name,
    applicationId: application?.id ?? null,
    runtimeType: application?.type ?? 'proxy',
    proxyTarget: normalized.source.kind === 'external_proxy' ? normalized.source.target : null,
  });
  const primaryDomain = await domainRegistry.createDomain({
    domainId: preview.ids.primaryDomainId,
    serverId: normalized.serverId,
    websiteId: website.id,
    primaryDomain: preview.plan.primaryDomain.primaryDomain,
    parentDomainId: preview.plan.primaryDomain.parentDomainId,
    aliases: preview.plan.primaryDomain.aliases,
    targetType: preview.plan.primaryDomain.targetType,
    target: preview.plan.primaryDomain.target,
    httpsMode: preview.plan.primaryDomain.httpsMode,
  });
  const wwwDomain = preview.plan.wwwDomain ? await domainRegistry.createDomain({
    domainId: preview.ids.wwwDomainId,
    serverId: normalized.serverId,
    websiteId: website.id,
    primaryDomain: preview.plan.wwwDomain.primaryDomain,
    parentDomainId: primaryDomain.id,
    aliases: [],
    targetType: preview.plan.wwwDomain.targetType,
    target: preview.plan.wwwDomain.target,
    httpsMode: preview.plan.wwwDomain.httpsMode,
  }) : null;
  return Object.freeze({
    created: !preview.complete,
    resumed: preview.resumeRequired,
    operationId: normalized.operationId,
    application,
    website,
    primaryDomain,
    wwwDomain,
    lifecycle: preview.lifecycle,
  });
}

export const siteCreateInternals = Object.freeze({
  resourceId,
  normalizeInput,
  normalizedSource,
  stableApplication,
  stableWebsite,
  stableDomain,
  domainTarget,
});
