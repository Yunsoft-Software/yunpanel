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
  normalizePythonRuntimeConfig,
  normalizeStaticBuildConfig,
  ProxyTargetValidationError,
} from '@yunpanel/shared';
import { DomainHierarchyError, validateDomainParent } from './domain-hierarchy.js';

const SITE_NAMESPACE = Buffer.from('0bcd2cf8883b49f997294b5d225cf15e', 'hex');
const SOURCE_KINDS = new Set(['existing_application', 'existing_docker', 'existing_managed_compose', 'new_static', 'new_node', 'new_php', 'new_python', 'external_proxy']);
const WWW_MODES = new Set(['none', 'alias', 'independent']);
const HTTPS_MODES = new Set(['off', 'managed']);
const DATABASE_MODES = new Set(['none', 'create']);
const MAIL_MODES = new Set(['none', 'local', 'external']);
const DNS_MODES = new Set(['local', 'external']);
const DATABASE_SOURCE_KINDS = new Set(['existing_application', 'new_static', 'new_node', 'new_php', 'new_python']);
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
    if (source.kind === 'existing_docker') {
      exactObject(source, new Set(['kind', 'dockerWorkloadId']), 'site_create_source_invalid', 'Existing Docker source requires only kind and dockerWorkloadId');
      return Object.freeze({ kind: source.kind, dockerWorkloadId: uuid(source.dockerWorkloadId, 'dockerWorkloadId') });
    }
    if (source.kind === 'existing_managed_compose') {
      const allowed = new Set(['kind', 'projectId', 'serviceName', 'targetPort', 'protocol']);
      if (!source || typeof source !== 'object' || Array.isArray(source)
        || Object.keys(source).some((key) => !allowed.has(key))
        || !source.projectId || !source.serviceName || source.targetPort === undefined) {
        throw new SiteCreateError('site_create_source_invalid', 'Existing managed compose source requires kind, projectId, serviceName, and targetPort');
      }
      const projectId = uuid(source.projectId, 'projectId');
      if (typeof source.serviceName !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(source.serviceName)) {
        throw new SiteCreateError('site_create_service_name_invalid', 'Managed compose service name is invalid');
      }
      if (!Number.isSafeInteger(source.targetPort) || source.targetPort < 1 || source.targetPort > 65535) {
        throw new SiteCreateError('site_create_target_port_invalid', 'Managed compose target port must be between 1 and 65535');
      }
      const protocol = source.protocol ?? 'tcp';
      if (protocol !== 'tcp') {
        throw new SiteCreateError('site_create_protocol_unsupported', 'Managed compose protocol must be tcp');
      }
      return Object.freeze({
        kind: source.kind,
        projectId,
        serviceName: source.serviceName,
        targetPort: source.targetPort,
        protocol,
      });
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
    if (source.kind === 'new_php') {
      exactObject(source, new Set(['kind']), 'site_create_source_invalid', 'New PHP source accepts only kind');
      return Object.freeze({ kind: source.kind });
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
    if (source.kind === 'new_python') {
      let pythonRuntime;
      try {
        pythonRuntime = normalizePythonRuntimeConfig(source.runtime ?? {});
      } catch (error) {
        throw new SiteCreateError(error.code ?? 'site_create_python_runtime_invalid', error.message);
      }
      return Object.freeze({ ...common, runtime: Object.freeze(pythonRuntime) });
    }
    if (!source.runtime || typeof source.runtime !== 'object' || Array.isArray(source.runtime)
      || Object.hasOwn(source.runtime, 'port')
      || Object.keys(source.runtime).some((key) => ![
        'nodeMajor', 'installMode', 'buildScript', 'startMode', 'start', 'entryFile', 'startScript',
        'healthPath', 'healthTimeoutSeconds', 'restartPolicy',
      ].includes(key))) {
      throw new SiteCreateError('site_create_node_runtime_invalid', 'Passenger Node runtime must omit port and unsupported fields');
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

function normalizedDatabase(value, source) {
  const input = value ?? { mode: 'none' };
  exactObject(
    input,
    new Set(['mode']),
    'site_create_database_invalid',
    'Initial database accepts only mode',
  );
  if (!DATABASE_MODES.has(input.mode)) {
    throw new SiteCreateError('site_create_database_invalid', 'Initial database mode must be none or create');
  }
  if (input.mode === 'create' && !DATABASE_SOURCE_KINDS.has(source.kind)) {
    throw new SiteCreateError(
      'site_create_database_source_unsupported',
      'Initial database requires a managed Application Website',
      409,
    );
  }
  return Object.freeze({ mode: input.mode });
}

function normalizedMail(value, httpsMode) {
  const input = value ?? { mode: 'none' };
  exactObject(
    input,
    new Set(['mode']),
    'site_create_mail_invalid',
    'Initial mail configuration accepts only mode',
  );
  if (!MAIL_MODES.has(input.mode)) {
    throw new SiteCreateError(
      'site_create_mail_invalid',
      'Mail mode must be none, local or external',
    );
  }
  if (input.mode === 'local' && httpsMode !== 'managed') {
    throw new SiteCreateError(
      'site_create_local_mail_https_required',
      'Local mail with shared webmail requires managed HTTPS',
      409,
    );
  }
  return Object.freeze({ mode: input.mode });
}

function normalizedDns(value, parentDomainId) {
  const input = value ?? { mode: parentDomainId === null ? 'local' : 'external' };
  exactObject(
    input,
    new Set(['mode']),
    'site_create_dns_invalid',
    'Initial DNS configuration accepts only mode',
  );
  if (!DNS_MODES.has(input.mode)) {
    throw new SiteCreateError(
      'site_create_dns_invalid',
      'DNS mode must be local or external',
    );
  }
  if (input.mode === 'local' && parentDomainId !== null) {
    throw new SiteCreateError(
      'site_create_subdomain_dns_unsupported',
      'Subdomain Website cannot create a separate authoritative local zone',
      409,
    );
  }
  return Object.freeze({ mode: input.mode });
}

function normalizeInput(input) {
  const allowedFields = new Set([
    'operationId', 'serverId', 'name', 'primaryDomain', 'parentDomainId', 'wwwMode', 'httpsMode', 'source',
    'database', 'mail', 'dns',
  ]);
  const requiredFields = [...allowedFields].filter((field) => !['database', 'mail', 'dns'].includes(field));
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !allowedFields.has(key))
    || requiredFields.some((field) => !Object.hasOwn(input, field))) {
    throw new SiteCreateError('site_create_input_invalid', 'Send the complete documented site-create input');
  }
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
  const source = normalizedSource(input.source);
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
    source,
    database: normalizedDatabase(input.database, source),
    mail: normalizedMail(input.mail, input.httpsMode),
    dns: normalizedDns(input.dns, parentDomainId),
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
    runtimeAdapter: application.runtimeAdapter ?? null,
    webRoot: application.webRoot ?? null,
  };
}

function stableWebsite(website) {
  return {
    id: website.id,
    serverId: website.serverId,
    name: website.name,
    applicationId: website.applicationId,
    dockerWorkloadId: website.dockerWorkloadId ?? null,
    managedComposeBinding: website.managedComposeBinding ? { ...website.managedComposeBinding } : null,
    runtimeType: website.runtimeType,
    documentRoot: website.documentRoot,
    unixUser: website.unixUser,
    proxyTarget: website.proxyTarget,
    revision: website.revision,
  };
}

function stableDockerWorkload(workload) {
  return {
    id: workload.id,
    serverId: workload.serverId,
    name: workload.name,
    managementMode: workload.managementMode,
    state: workload.state,
    proxyTarget: workload.proxyTarget,
    revision: workload.revision,
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

function stableMailDomain(mailDomain) {
  return {
    id: mailDomain.id,
    domainName: mailDomain.domainName,
    webDomainId: mailDomain.webDomainId ?? null,
    managementMode: mailDomain.managementMode,
  };
}

function ensureExact(existing, expected, code, message, project = (value) => value) {
  if (!existing) return false;
  if (!same(project(existing), expected)) throw new SiteCreateError(code, message, 409);
  return true;
}

function domainTarget(application, source, dockerWorkload = null, managedComposeTarget = null) {
  if (source.kind === 'external_proxy') {
    return Object.freeze({
      targetType: 'proxy',
      target: Object.freeze({ upstreamHost: source.target.host, upstreamPort: source.target.port, websocket: source.target.websocket }),
    });
  }
  if (source.kind === 'existing_managed_compose') {
    if (!managedComposeTarget || !LOOPBACK_HOSTS.has(managedComposeTarget.host)
      || !Number.isInteger(managedComposeTarget.port) || managedComposeTarget.port < 1024 || managedComposeTarget.port > 65535) {
      throw new SiteCreateError('site_create_managed_compose_target_invalid', 'Managed Compose published target is invalid', 409);
    }
    return Object.freeze({
      targetType: 'proxy',
      target: Object.freeze({ upstreamHost: managedComposeTarget.host, upstreamPort: managedComposeTarget.port, websocket: true }),
    });
  }
  if (source.kind === 'existing_docker') {
    if (!dockerWorkload || dockerWorkload.id !== source.dockerWorkloadId
      || dockerWorkload.managementMode !== 'external'
      || !dockerWorkload.proxyTarget || typeof dockerWorkload.proxyTarget !== 'object') {
      throw new SiteCreateError('site_create_docker_target_invalid', 'Selected Docker workload target is invalid', 409);
    }
    const { host, port, websocket } = dockerWorkload.proxyTarget;
    if (!LOOPBACK_HOSTS.has(host) || !Number.isInteger(port) || port < 1024 || port > 65535 || typeof websocket !== 'boolean') {
      throw new SiteCreateError('site_create_docker_target_invalid', 'Selected Docker workload target is invalid', 409);
    }
    return Object.freeze({
      targetType: 'proxy',
      target: Object.freeze({ upstreamHost: host, upstreamPort: port, websocket }),
    });
  }
  if (application.type === 'static') {
    if (application.webRoot !== `/var/www/yunpanel/apps/${application.id}/current`) {
      throw new SiteCreateError('site_create_application_root_drift', 'Selected static Application document root is outside managed state', 409);
    }
    return Object.freeze({ targetType: 'static', target: Object.freeze({ root: application.webRoot, spaFallback: true }) });
  }
  if (application.type === 'php') {
    if (application.webRoot !== `/var/lib/yunpanel/apps/${application.id}/current/public`) {
      throw new SiteCreateError('site_create_application_root_drift', 'Selected PHP Application document root is outside managed state', 409);
    }
    return Object.freeze({ targetType: 'php', target: Object.freeze({ applicationId: application.id }) });
  }
  if (application.type === 'python') {
    const isSocket = !application.runtime?.port;
    return Object.freeze({
      targetType: 'python',
      target: Object.freeze({
        applicationId: application.id,
        proxyMode: isSocket ? 'unix_socket' : 'port',
        socketPath: isSocket ? `/run/yunpanel/python-${application.id}.sock` : null,
        port: isSocket ? null : application.runtime.port,
        websocket: true,
      }),
    });
  }
  if (application.runtimeAdapter === 'passenger') {
    if (application.runtime?.port !== null) {
      throw new SiteCreateError('site_create_application_runtime_drift', 'Passenger Node Application must not persist a backend port', 409);
    }
    return Object.freeze({
      targetType: 'passenger',
      target: Object.freeze({ applicationId: application.id }),
    });
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

function canonicalState({
  applications,
  dockerWorkloads,
  websites,
  domains,
  mailDomains = [],
  excludedIds,
  selectedApplicationId,
  selectedDockerWorkloadId,
  serverId,
}) {
  return {
    applications: applications.filter((item) => item.serverId === serverId
      && (item.id !== excludedIds.applicationId || item.id === selectedApplicationId))
      .map(stableApplication).sort((left, right) => left.id.localeCompare(right.id)),
    dockerWorkloads: dockerWorkloads.filter((item) => item.serverId === serverId && item.id !== selectedDockerWorkloadId)
      .map(stableDockerWorkload).sort((left, right) => left.id.localeCompare(right.id)),
    websites: websites.filter((item) => item.serverId === serverId && item.id !== excludedIds.websiteId)
      .map(stableWebsite).sort((left, right) => left.id.localeCompare(right.id)),
    domains: domains.filter((item) => item.serverId === serverId && !excludedIds.domainIds.has(item.id))
      .map(stableDomain).sort((left, right) => left.id.localeCompare(right.id)),
    mailDomains: mailDomains
      .filter((item) => item.id !== excludedIds.mailDomainId)
      .map(stableMailDomain)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function previewSiteCreate({
  input,
  registry,
  applicationRegistry,
  dockerWorkloadRegistry,
  dockerComposeProjectRegistry = null,
  websiteRegistry,
  domainRegistry,
  mailDomainRegistry = null,
  serverDnsIdentityRegistry = null,
} = {}) {
  for (const [dependency, methods] of [
    [registry, ['getServer']],
    [applicationRegistry, ['getApplication', 'listApplications']],
    [dockerWorkloadRegistry, ['getWorkload', 'listWorkloads']],
    [websiteRegistry, ['getWebsite', 'listWebsites']],
    [domainRegistry, ['getDomain', 'listDomains']],
  ]) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== 'function')) {
      throw new SiteCreateError('site_create_dependencies_invalid', 'Site-create dependencies are unavailable', 503);
    }
  }
  const normalized = normalizeInput(input);
  if (normalized.mail.mode !== 'none'
    && (!mailDomainRegistry
      || typeof mailDomainRegistry.getMailDomain !== 'function'
      || typeof mailDomainRegistry.listMailDomains !== 'function')) {
    throw new SiteCreateError(
      'site_create_mail_dependencies_invalid',
      'Mail Domain registry is required for requested site mail provisioning',
      503,
    );
  }
  if (!(await registry.getServer(normalized.serverId))) throw new SiteCreateError('server_not_found', 'Target server does not exist', 404);

  const ids = Object.freeze({
    applicationId: ['new_static', 'new_node', 'new_php', 'new_python'].includes(normalized.source.kind) ? resourceId(normalized.operationId, 'application') : null,
    websiteId: resourceId(normalized.operationId, 'website'),
    primaryDomainId: resourceId(normalized.operationId, 'primary-domain'),
    wwwDomainId: normalized.wwwMode === 'independent' ? resourceId(normalized.operationId, 'www-domain') : null,
    mailDomainId: normalized.mail.mode === 'none' ? null : resourceId(normalized.operationId, 'mail-domain'),
  });
  const [applications, dockerWorkloads, websites, domains, mailDomains] = await Promise.all([
    applicationRegistry.listApplications(),
    dockerWorkloadRegistry.listWorkloads(),
    websiteRegistry.listWebsites(),
    domainRegistry.listDomains(),
    normalized.mail.mode === 'none' ? Promise.resolve([]) : mailDomainRegistry.listMailDomains(),
  ]);

  let application = null;
  let dockerWorkload = null;
  let managedComposeTarget = null;
  let applicationExpected = null;
  const assignedPort = null;
  if (normalized.source.kind === 'existing_application') {
    application = applications.find((candidate) => candidate.id === normalized.source.applicationId) ?? null;
    if (!application) throw new SiteCreateError('application_not_found', 'Selected Application does not exist', 404);
    if (application.serverId !== normalized.serverId) throw new SiteCreateError('site_create_application_server_mismatch', 'Selected Application belongs to a different server', 409);
    if (!['static', 'node', 'python'].includes(application.type)) throw new SiteCreateError('site_create_application_type_unsupported', 'Selected Application type is not supported', 409);
  } else if (normalized.source.kind === 'existing_docker') {
    dockerWorkload = dockerWorkloads.find((candidate) => candidate.id === normalized.source.dockerWorkloadId) ?? null;
    if (!dockerWorkload) throw new SiteCreateError('docker_workload_not_found', 'Selected Docker workload does not exist', 404);
    if (dockerWorkload.serverId !== normalized.serverId) {
      throw new SiteCreateError('site_create_docker_server_mismatch', 'Selected Docker workload belongs to a different server', 409);
    }
  } else if (normalized.source.kind === 'existing_managed_compose') {
    if (!dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function') {
      throw new SiteCreateError(
        'site_create_managed_compose_dependencies_invalid',
        'Managed Compose project registry is required for requested site compose provisioning',
        503,
      );
    }
    const project = await dockerComposeProjectRegistry.getProject(normalized.source.projectId);
    if (!project) {
      throw new SiteCreateError('managed_compose_project_not_found', 'Selected Managed Compose project does not exist', 404);
    }
    if (project.serverId !== normalized.serverId) {
      throw new SiteCreateError('site_create_managed_compose_server_mismatch', 'Selected Managed Compose project belongs to a different server', 409);
    }
    const service = project.services.find((s) => s.name === normalized.source.serviceName) ?? null;
    if (!service) {
      throw new SiteCreateError('site_create_managed_compose_service_not_found', 'Selected Managed Compose service does not exist in project', 404);
    }
    const portMatch = service.publishedPorts.find((p) => p.targetPort === normalized.source.targetPort && p.protocol === normalized.source.protocol) ?? null;
    if (!portMatch) {
      throw new SiteCreateError('site_create_managed_compose_port_not_published', 'Selected Managed Compose target port is not published', 409);
    }
    const host = (portMatch.hostIp === null || portMatch.hostIp === '0.0.0.0' || portMatch.hostIp === '::')
      ? '127.0.0.1'
      : portMatch.hostIp;
    managedComposeTarget = Object.freeze({
      host,
      port: portMatch.publishedPort,
      targetPort: portMatch.targetPort,
      protocol: portMatch.protocol,
    });
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
      runtimeAdapter: null,
      webRoot: `/var/www/yunpanel/apps/${ids.applicationId}/current`,
    };
    const existing = applications.find((candidate) => candidate.id === ids.applicationId) ?? null;
    ensureExact(existing, applicationExpected, 'site_create_application_identity_conflict', 'Planned Application identity conflicts with existing state', stableApplication);
    application = existing ?? applicationExpected;
  } else if (normalized.source.kind === 'new_node') {
    const existing = applications.find((candidate) => candidate.id === ids.applicationId) ?? null;
    let runtime;
    try { runtime = normalizeNodeRuntimeConfig(normalized.source.runtime, { requirePort: false }); }
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
      runtimeAdapter: 'passenger',
      webRoot: null,
    };
    ensureExact(existing, applicationExpected, 'site_create_application_identity_conflict', 'Planned Application identity conflicts with existing state', stableApplication);
    application = existing ?? applicationExpected;
  } else if (normalized.source.kind === 'new_php') {
    const existing = applications.find((candidate) => candidate.id === ids.applicationId) ?? null;
    applicationExpected = {
      id: ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
      type: 'php',
      repositoryUrl: null,
      branch: null,
      retention: 2,
      build: null,
      runtime: null,
      runtimeAdapter: null,
      webRoot: `/var/lib/yunpanel/apps/${ids.applicationId}/current/public`,
    };
    ensureExact(existing, applicationExpected, 'site_create_application_identity_conflict', 'Planned PHP Application identity conflicts with existing state', stableApplication);
    application = existing ?? applicationExpected;
  } else if (normalized.source.kind === 'new_python') {
    const existing = applications.find((candidate) => candidate.id === ids.applicationId) ?? null;
    const runtime = normalizePythonRuntimeConfig(normalized.source.runtime ?? {});
    applicationExpected = {
      id: ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
      type: 'python',
      repositoryUrl: normalized.source.repositoryUrl,
      branch: normalized.source.branch,
      retention: normalized.source.retention,
      build: null,
      runtime,
      runtimeAdapter: null,
      webRoot: null,
    };
    ensureExact(existing, applicationExpected, 'site_create_application_identity_conflict', 'Planned Python Application identity conflicts with existing state', stableApplication);
    application = existing ?? applicationExpected;
  }

  if (application) {
    const boundElsewhere = websites.find((website) => website.applicationId === application.id && website.id !== ids.websiteId);
    if (boundElsewhere) throw new SiteCreateError('application_already_bound', 'Application is already bound to another Website', 409);
  }
  if (dockerWorkload) {
    const boundElsewhere = websites.find((website) => website.dockerWorkloadId === dockerWorkload.id && website.id !== ids.websiteId);
    if (boundElsewhere) throw new SiteCreateError('docker_workload_already_bound', 'Docker workload is already bound to another Website', 409);
  }
  if (normalized.source.kind === 'existing_managed_compose') {
    const boundElsewhere = websites.find((website) => website.managedComposeBinding
      && website.managedComposeBinding.projectId === normalized.source.projectId
      && website.managedComposeBinding.serviceName === normalized.source.serviceName
      && website.managedComposeBinding.targetPort === normalized.source.targetPort
      && (website.managedComposeBinding.protocol ?? 'tcp') === (normalized.source.protocol ?? 'tcp')
      && website.id !== ids.websiteId);
    if (boundElsewhere) throw new SiteCreateError('managed_compose_binding_already_bound', 'Managed Compose service port is already bound to another Website', 409);
  }
  const target = domainTarget(application, normalized.source, dockerWorkload, managedComposeTarget);
  const websiteExpected = normalized.source.kind === 'external_proxy'
    ? {
        id: ids.websiteId, serverId: normalized.serverId, name: normalized.name, applicationId: null,
        dockerWorkloadId: null, managedComposeBinding: null, runtimeType: 'proxy', documentRoot: null, unixUser: null, proxyTarget: normalized.source.target, revision: 1,
      }
    : normalized.source.kind === 'existing_docker'
      ? {
          id: ids.websiteId, serverId: normalized.serverId, name: normalized.name, applicationId: null,
          dockerWorkloadId: dockerWorkload.id, managedComposeBinding: null, runtimeType: 'docker', documentRoot: null, unixUser: null,
          proxyTarget: dockerWorkload.proxyTarget, revision: 1,
        }
    : normalized.source.kind === 'existing_managed_compose'
      ? {
          id: ids.websiteId, serverId: normalized.serverId, name: normalized.name, applicationId: null,
          dockerWorkloadId: null,
          managedComposeBinding: {
            projectId: normalized.source.projectId,
            serviceName: normalized.source.serviceName,
            targetPort: normalized.source.targetPort,
            protocol: normalized.source.protocol ?? 'tcp',
          },
          runtimeType: 'docker', documentRoot: null, unixUser: null,
          proxyTarget: null, revision: 1,
        }
    : {
        id: ids.websiteId, serverId: normalized.serverId, name: normalized.name, applicationId: application.id,
        dockerWorkloadId: null, managedComposeBinding: null, runtimeType: application.type,
        documentRoot: ['static', 'php'].includes(application.type) ? application.webRoot : `/var/lib/yunpanel/apps/${application.id}/current`,
        unixUser: `yunapp-${createHash('sha256').update(application.id).digest('hex').slice(0, 12)}`, proxyTarget: null, revision: 1,
      };
  const websiteExisting = websites.find((candidate) => candidate.id === ids.websiteId) ?? null;
  const websiteReady = ensureExact(websiteExisting, websiteExpected, 'site_create_website_identity_conflict', 'Planned Website identity conflicts with existing state', stableWebsite);
  const databaseExpected = normalized.database.mode === 'create' ? Object.freeze({
    serverId: normalized.serverId,
    databaseName: `yp_${createHash('sha256').update(ids.websiteId).digest('hex').slice(0, 32)}`,
    websiteId: ids.websiteId,
    applicationId: websiteExpected.applicationId,
    unixUser: websiteExpected.unixUser,
  }) : null;
  if (databaseExpected && (!databaseExpected.applicationId || !databaseExpected.unixUser)) {
    throw new SiteCreateError(
      'site_create_database_source_unsupported',
      'Initial database requires a managed Application Website',
      409,
    );
  }

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

  const mailDomainExpected = normalized.mail.mode === 'none'
    ? null
    : Object.freeze({
      id: ids.mailDomainId,
      domainName: normalized.primaryDomain,
      webDomainId: ids.primaryDomainId,
      managementMode: normalized.mail.mode,
      initialStatus: normalized.mail.mode === 'local' ? 'disabled' : 'unverified',
      desiredStatus: normalized.mail.mode === 'local' ? 'enabled' : null,
    });
  let mailDomainReady = normalized.mail.mode === 'none';
  if (mailDomainExpected) {
    const sameName = mailDomains.find((candidate) => candidate.domainName === mailDomainExpected.domainName) ?? null;
    const sameWebDomain = mailDomains.find((candidate) => candidate.webDomainId === mailDomainExpected.webDomainId) ?? null;
    const expectedExisting = mailDomains.find((candidate) => candidate.id === mailDomainExpected.id) ?? null;
    if ((sameName && sameName.id !== mailDomainExpected.id)
      || (sameWebDomain && sameWebDomain.id !== mailDomainExpected.id)) {
      throw new SiteCreateError(
        'site_create_mail_domain_conflict',
        'Planned Mail Domain name or Web Domain relationship is already managed',
        409,
      );
    }
    mailDomainReady = ensureExact(
      expectedExisting,
      stableMailDomain(mailDomainExpected),
      'site_create_mail_domain_identity_conflict',
      'Planned Mail Domain identity conflicts with existing state',
      stableMailDomain,
    );
  }
  const webmailExpected = normalized.mail.mode === 'local'
    ? Object.freeze({
      hostname: `webmail.${normalized.primaryDomain}`,
      sharedRoundcube: true,
      certificateCoverageRequired: true,
    })
    : null;

  const applicationReady = normalized.source.kind === 'existing_application'
    || normalized.source.kind === 'existing_docker'
    || normalized.source.kind === 'existing_managed_compose'
    || normalized.source.kind === 'external_proxy'
    || applications.some((candidate) => candidate.id === ids.applicationId);
  const state = canonicalState({
    applications,
    dockerWorkloads,
    websites,
    domains,
    mailDomains,
    excludedIds: {
      applicationId: ids.applicationId,
      websiteId: ids.websiteId,
      domainIds: new Set([ids.primaryDomainId, ids.wwwDomainId].filter(Boolean)),
      mailDomainId: ids.mailDomainId,
    },
    selectedApplicationId: normalized.source.kind === 'existing_application' ? normalized.source.applicationId : null,
    selectedDockerWorkloadId: normalized.source.kind === 'existing_docker' ? normalized.source.dockerWorkloadId : null,
    serverId: normalized.serverId,
  });

  let dnsIdentity = null;
  if (serverDnsIdentityRegistry && typeof serverDnsIdentityRegistry.getForServer === 'function') {
    try {
      dnsIdentity = await serverDnsIdentityRegistry.getForServer(normalized.serverId);
    } catch {
      dnsIdentity = null;
    }
  }

  const runtimeExpected = Object.freeze({
    type: websiteExpected.runtimeType,
    adapter: websiteExpected.runtimeType === 'node' ? 'passenger'
      : websiteExpected.runtimeType === 'php' ? 'php-fpm'
      : websiteExpected.runtimeType === 'static' ? 'static'
      : websiteExpected.runtimeType === 'python' ? (normalized.source.runtime?.appServer ?? 'gunicorn')
      : normalized.source.kind === 'existing_managed_compose' ? 'managed_compose'
      : websiteExpected.runtimeType,
    documentRoot: websiteExpected.documentRoot,
    appRoot: websiteExpected.documentRoot,
    nodeMajor: normalized.source.runtime?.nodeMajor ?? null,
    startMode: normalized.source.runtime?.start?.mode ?? null,
    entryFile: normalized.source.runtime?.start?.entryFile ?? null,
    healthPath: normalized.source.runtime?.healthPath ?? null,
    ...(normalized.source.kind === 'existing_managed_compose' ? {
      serviceName: normalized.source.serviceName,
      targetPort: normalized.source.targetPort,
      protocol: normalized.source.protocol ?? 'tcp',
      publishedPort: managedComposeTarget?.port ?? null,
    } : {}),
  });

  const dnsExpected = Object.freeze({
    mode: normalized.parentDomainId !== null ? 'inherited' : normalized.dns.mode,
    zoneName: normalized.primaryDomain,
    authoritative: normalized.parentDomainId === null && normalized.dns.mode === 'local',
    serverDnsIdentityConfigured: Boolean(dnsIdentity),
    publicIpv4: dnsIdentity?.settings?.publicIpv4 ?? null,
    publicIpv6: dnsIdentity?.settings?.publicIpv6 ?? null,
    nameservers: dnsIdentity?.settings?.ns1?.hostname && dnsIdentity?.settings?.ns2?.hostname
      ? Object.freeze([dnsIdentity.settings.ns1.hostname, dnsIdentity.settings.ns2.hostname])
      : Object.freeze([]),
  });

  const ipExpected = Object.freeze({
    publicIpv4: dnsIdentity?.settings?.publicIpv4 ?? null,
    publicIpv6: dnsIdentity?.settings?.publicIpv6 ?? null,
  });

  const certificateExpected = Object.freeze({
    mode: normalized.httpsMode,
    purpose: normalized.httpsMode === 'managed' ? 'web' : null,
    primaryDomain: normalized.primaryDomain,
    coverage: Object.freeze([normalized.primaryDomain, ...normalized.aliases]),
    issuer: normalized.httpsMode === 'managed' ? 'letsencrypt' : null,
    webmailCoverage: normalized.mail.mode === 'local' ? Object.freeze({
      hostname: `webmail.${normalized.primaryDomain}`,
      purpose: 'webmail',
      issuer: 'letsencrypt',
    }) : null,
  });

  const sftpExpected = ['node', 'php', 'static', 'python'].includes(websiteExpected.runtimeType)
    ? Object.freeze({
      adapter: 'openssh-internal-sftp',
      websiteId: ids.websiteId,
      applicationId: websiteExpected.applicationId,
      unixUser: websiteExpected.unixUser,
      homeDirectory: `/var/lib/yunpanel/homes/${websiteExpected.unixUser}`,
      documentRoot: websiteExpected.documentRoot,
    })
    : null;

  const blockers = [];
  if (normalized.dns.mode === 'local' && normalized.parentDomainId === null && !dnsIdentity && serverDnsIdentityRegistry) {
    blockers.push('dns_identity_required');
  }
  if (normalized.source.kind === 'new_node' && normalized.source.runtime?.start?.mode && normalized.source.runtime.start.mode !== 'node') {
    blockers.push('passenger_start_mode_unsupported');
  }

  const planCore = {
    version: 1,
    input: normalized,
    resources: {
      application: applicationExpected ?? (application ? stableApplication(application) : null),
      dockerWorkload: dockerWorkload ? stableDockerWorkload(dockerWorkload) : null,
      managedComposeBinding: websiteExpected.managedComposeBinding ?? null,
      website: websiteExpected,
      database: databaseExpected,
      mailDomain: mailDomainExpected,
      webmail: webmailExpected,
      primaryDomain: primaryExpected,
      wwwDomain: wwwExpected,
      runtime: runtimeExpected,
      dns: dnsExpected,
      ip: ipExpected,
      certificate: certificateExpected,
      sftp: sftpExpected,
    },
    state,
  };
  const previewDigest = createHash('sha256').update(JSON.stringify(planCore)).digest('hex');
  const complete = applicationReady
    && websiteReady
    && primaryReady
    && (normalized.wwwMode !== 'independent' || wwwReady)
    && mailDomainReady;
  return Object.freeze({
    version: 1,
    operationId: normalized.operationId,
    previewDigest,
    confirmation: `create-site:${normalized.operationId}:${previewDigest}`,
    destructive: false,
    autoApply: false,
    complete: complete && blockers.length === 0,
    resumeRequired: !complete && (
      applicationReady
      || websiteReady
      || primaryReady
      || wwwReady
      || (normalized.mail.mode !== 'none' && mailDomainReady)
    ),
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
    steps: Object.freeze({
      applicationReady,
      ...(normalized.source.kind === 'existing_docker' ? { dockerWorkloadReady: true } : {}),
      ...(normalized.source.kind === 'existing_managed_compose' ? { managedComposeReady: true } : {}),
      websiteReady,
      primaryDomainReady: primaryReady,
      wwwDomainReady: normalized.wwwMode === 'independent' ? wwwReady : null,
      mailDomainReady: normalized.mail.mode === 'none' ? null : mailDomainReady,
    }),
    blockers: Object.freeze(blockers),
    lifecycle: Object.freeze({
      dnsPublished: false,
      certificateIssued: false,
      mailDomainCreated: normalized.mail.mode !== 'none' && mailDomainReady,
      ...(normalized.mail.mode === 'local' ? { webmailMappingActive: false } : {}),
      ...(normalized.source.kind === 'existing_docker' ? { containersChanged: false } : {}),
      ...(normalized.source.kind === 'existing_managed_compose' ? { containersChanged: false } : {}),
    }),
    plan: Object.freeze(planCore.resources),
  });
}

export async function createSite({
  input,
  previewDigest,
  confirmation,
  registry,
  applicationRegistry,
  dockerWorkloadRegistry,
  dockerComposeProjectRegistry = null,
  websiteRegistry,
  domainRegistry,
  mailDomainRegistry = null,
  serverDnsIdentityRegistry = null,
} = {}) {
  if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
    throw new SiteCreateError('site_create_preview_digest_invalid', 'A current site-create preview digest is required');
  }
  const preview = await previewSiteCreate({
    input, registry, applicationRegistry, dockerWorkloadRegistry, dockerComposeProjectRegistry, websiteRegistry, domainRegistry,
    mailDomainRegistry, serverDnsIdentityRegistry,
  });
  if (preview.previewDigest !== previewDigest) {
    throw new SiteCreateError('site_create_preview_stale', 'Site-create state changed after preview; request a new preview', 409);
  }
  if (preview.blockers?.length > 0) {
    throw new SiteCreateError(
      'site_create_blocked_by_dependency',
      `Site creation is blocked by unresolved dependencies: ${preview.blockers.join(', ')}`,
      409,
    );
  }
  if (confirmation !== preview.confirmation) {
    throw new SiteCreateError('site_create_confirmation_required', `Confirm site creation with ${preview.confirmation}`);
  }
  const normalized = normalizeInput(input);
  let application = normalized.source.kind === 'existing_application'
    ? await applicationRegistry.getApplication(normalized.source.applicationId)
    : null;
  const dockerWorkload = normalized.source.kind === 'existing_docker'
    ? await dockerWorkloadRegistry.getWorkload(normalized.source.dockerWorkloadId)
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
      runtimeAdapter: 'passenger',
      runtime: normalized.source.runtime,
      retention: normalized.source.retention,
    });
  } else if (normalized.source.kind === 'new_php') {
    if (typeof applicationRegistry.createPhpApplication !== 'function') {
      throw new SiteCreateError('site_create_dependencies_invalid', 'PHP Application creation is unavailable', 503);
    }
    application = await applicationRegistry.createPhpApplication({
      applicationId: preview.ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
    });
  } else if (normalized.source.kind === 'new_python') {
    if (typeof applicationRegistry.createPythonApplication !== 'function') {
      throw new SiteCreateError('site_create_dependencies_invalid', 'Python Application creation is unavailable', 503);
    }
    application = await applicationRegistry.createPythonApplication({
      applicationId: preview.ids.applicationId,
      serverId: normalized.serverId,
      name: normalized.name,
      repositoryUrl: normalized.source.repositoryUrl,
      branch: normalized.source.branch,
      runtime: normalized.source.runtime,
      retention: normalized.source.retention,
    });
  }

  const website = await websiteRegistry.createWebsite({
    websiteId: preview.ids.websiteId,
    serverId: normalized.serverId,
    name: normalized.name,
    applicationId: application?.id ?? null,
    dockerWorkloadId: dockerWorkload?.id ?? null,
    managedComposeBinding: preview.plan.managedComposeBinding ? { ...preview.plan.managedComposeBinding } : null,
    runtimeType: preview.plan.website.runtimeType,
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
  let mailDomain = null;
  if (preview.plan.mailDomain) {
    if (!mailDomainRegistry || typeof mailDomainRegistry.createMailDomain !== 'function'
      || typeof mailDomainRegistry.getMailDomain !== 'function') {
      throw new SiteCreateError(
        'site_create_mail_dependencies_invalid',
        'Mail Domain registry is required for requested site mail provisioning',
        503,
      );
    }
    mailDomain = await mailDomainRegistry.getMailDomain(preview.plan.mailDomain.id);
    if (!mailDomain) {
      mailDomain = await mailDomainRegistry.createMailDomain({
        mailDomainId: preview.plan.mailDomain.id,
        domainName: preview.plan.mailDomain.domainName,
        webDomainId: primaryDomain.id,
        managementMode: preview.plan.mailDomain.managementMode,
      });
    }
  }
  return Object.freeze({
    created: !preview.complete,
    resumed: preview.resumeRequired,
    operationId: normalized.operationId,
    application,
    dockerWorkload,
    website,
    primaryDomain,
    wwwDomain,
    mailDomain,
    lifecycle: preview.lifecycle,
  });
}

export const siteCreateInternals = Object.freeze({
  resourceId,
  normalizeInput,
  normalizedSource,
  normalizedDatabase,
  normalizedMail,
  stableMailDomain,
  stableApplication,
  stableDockerWorkload,
  stableWebsite,
  stableDomain,
  domainTarget,
});
