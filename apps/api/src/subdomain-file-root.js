import path from 'node:path';

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WEB_PUBLIC_LEAF_DIRS = new Set([
  'httpdocs',
  'public',
  'public_html',
  'html',
  'www',
  'current',
  'htdocs',
]);
const DEFAULT_VHOSTS_ROOT = '/var/www/vhosts';

export class SubdomainFileRootError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SubdomainFileRootError';
    this.code = code;
    this.status = status;
  }
}

function normalizeHostnameInput(value, fieldName) {
  const raw = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' && typeof value.primaryDomain === 'string' ? value.primaryDomain : null);
  if (typeof raw !== 'string') {
    throw new SubdomainFileRootError(`invalid_${fieldName}`, `${fieldName} must be a non-empty domain string`);
  }
  const trimmed = raw.trim().toLowerCase();
  if (
    !trimmed
    || trimmed.length > 253
    || trimmed.includes('..')
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new SubdomainFileRootError(`invalid_${fieldName}`, `${fieldName} contains invalid or unsafe characters`);
  }
  const labels = trimmed.split('.');
  if (labels.length < 2 || labels.some((label) => !DNS_LABEL_PATTERN.test(label))) {
    throw new SubdomainFileRootError(`invalid_${fieldName}`, `${fieldName} is not a valid DNS hostname`);
  }
  return trimmed;
}

export function extractSubdomainPrefix(primaryDomain, parentPrimaryDomain) {
  const childHost = normalizeHostnameInput(primaryDomain, 'subdomain_domain');
  const parentHost = normalizeHostnameInput(parentPrimaryDomain, 'parent_domain');

  const suffix = `.${parentHost}`;
  if (childHost === parentHost || !childHost.endsWith(suffix)) {
    throw new SubdomainFileRootError(
      'subdomain_not_under_parent',
      `Subdomain "${childHost}" must be a strict child of parent domain "${parentHost}"`,
    );
  }

  const prefix = childHost.slice(0, childHost.length - suffix.length);
  if (
    !prefix
    || prefix.includes('..')
    || prefix.includes('/')
    || prefix.includes('\\')
    || prefix.startsWith('.')
    || prefix.endsWith('.')
  ) {
    throw new SubdomainFileRootError('invalid_subdomain_prefix', 'Subdomain prefix is invalid');
  }

  const prefixLabels = prefix.split('.');
  if (prefixLabels.some((label) => !DNS_LABEL_PATTERN.test(label))) {
    throw new SubdomainFileRootError('invalid_subdomain_prefix', 'Subdomain prefix contains invalid DNS labels');
  }

  return prefix;
}

function assertSafePosixAbsolutePath(rawPath, fieldName) {
  if (
    typeof rawPath !== 'string'
    || rawPath.trim().length < 2
    || rawPath.length > 4096
    || /[\u0000-\u001f\u007f]/.test(rawPath)
    || rawPath.includes('\\')
  ) {
    throw new SubdomainFileRootError(`invalid_${fieldName}`, `${fieldName} must be a safe POSIX path`);
  }
  const segments = rawPath.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new SubdomainFileRootError(`invalid_${fieldName}`, `${fieldName} cannot contain path traversal segments`);
  }
  const normalized = path.posix.normalize(rawPath.trim());
  if (!path.posix.isAbsolute(normalized) || normalized === '/') {
    throw new SubdomainFileRootError(`invalid_${fieldName}`, `${fieldName} must be a non-root absolute path`);
  }
  return normalized.replace(/\/+$/, '');
}

export function resolveParentWorkspaceRoot({ parentDomain, parentWebsite = null } = {}) {
  const parentHost = normalizeHostnameInput(parentDomain, 'parent_domain');

  const explicitWorkspaceRoot = parentWebsite?.workspaceRoot
    ?? (parentDomain && typeof parentDomain === 'object' ? parentDomain.workspaceRoot : null);
  if (explicitWorkspaceRoot != null) {
    return assertSafePosixAbsolutePath(explicitWorkspaceRoot, 'parent_workspace_root');
  }

  const candidateDocRoot = parentWebsite?.documentRoot
    ?? (parentDomain && typeof parentDomain === 'object'
      ? (parentDomain.documentRoot ?? parentDomain.target?.root ?? null)
      : null);

  if (candidateDocRoot != null) {
    const normalizedDocRoot = assertSafePosixAbsolutePath(candidateDocRoot, 'parent_document_root');
    const base = path.posix.basename(normalizedDocRoot);
    const parentDir = path.posix.dirname(normalizedDocRoot);
    if (WEB_PUBLIC_LEAF_DIRS.has(base) && parentDir && parentDir !== '/') {
      return parentDir;
    }
    return normalizedDocRoot;
  }

  return path.posix.join(DEFAULT_VHOSTS_ROOT, parentHost);
}

export function resolveSubdomainFileRoot({
  parentDomain,
  parentWebsite = null,
  subdomainDomain,
} = {}) {
  const parentHost = normalizeHostnameInput(parentDomain, 'parent_domain');
  const subdomainHost = normalizeHostnameInput(subdomainDomain, 'subdomain_domain');
  const subdomainPrefix = extractSubdomainPrefix(subdomainHost, parentHost);
  const parentWorkspaceRoot = resolveParentWorkspaceRoot({ parentDomain, parentWebsite });
  const relativeFromParentRoot = `subdomains/${subdomainPrefix}`;
  const subdomainRootPath = path.posix.join(parentWorkspaceRoot, 'subdomains', subdomainPrefix);

  const relativeCheck = path.posix.relative(parentWorkspaceRoot, subdomainRootPath);
  if (
    !relativeCheck
    || relativeCheck.startsWith('..')
    || path.posix.isAbsolute(relativeCheck)
    || relativeCheck !== relativeFromParentRoot
  ) {
    throw new SubdomainFileRootError(
      'subdomain_root_escape_rejected',
      'Resolved subdomain file root escaped the parent domain workspace root',
    );
  }

  return Object.freeze({
    parentDomain: parentHost,
    subdomainDomain: subdomainHost,
    subdomainPrefix,
    parentWorkspaceRoot,
    subdomainRootPath,
    relativeFromParentRoot,
    supportsIndependentRuntime: true,
    supportsDatabaseBinding: true,
    supportsDockerProxy: true,
  });
}

function resolveNodeRuntimeSummary({ domain, website, applicationsById, isSubdomain = false }) {
  const appId = domain?.applicationId
    ?? domain?.target?.applicationId
    ?? (!isSubdomain ? website?.applicationId : null)
    ?? null;
  const application = appId ? (applicationsById.get(appId) ?? null) : null;
  const runtimeType = domain?.runtimeType
    ?? application?.runtime
    ?? application?.runtimeType
    ?? (!isSubdomain ? website?.runtimeType : null)
    ?? domain?.targetType
    ?? 'static';
  const targetType = domain?.targetType ?? (runtimeType === 'docker' ? 'proxy' : runtimeType);

  return Object.freeze({
    runtimeType,
    targetType,
    applicationId: appId,
    applicationName: application?.name ?? null,
    phpVersion: domain?.phpConfig?.phpVersion ?? (!isSubdomain ? website?.phpConfig?.phpVersion : null) ?? application?.phpVersion ?? null,
    nodeVersion: application?.nodeVersion ?? null,
    pythonVersion: application?.pythonVersion ?? null,
  });
}

function resolveNodeDatabases({ domain, website, runtimeSummary, databases, isSubdomain = false }) {
  const matched = [];
  for (const db of databases) {
    if (!db || typeof db !== 'object') continue;
    if (db.domainId) {
      if (db.domainId === domain.id) matched.push(db);
      continue;
    }
    if (runtimeSummary.applicationId && db.applicationId === runtimeSummary.applicationId) {
      matched.push(db);
      continue;
    }
    if (
      !isSubdomain
      && (
        (domain.websiteId && db.websiteId === domain.websiteId)
        || (website?.id && db.websiteId === website.id)
      )
    ) {
      matched.push(db);
    }
  }
  return Object.freeze(matched.map((db) => Object.freeze({
    id: db.id ?? null,
    name: db.name ?? db.databaseName ?? null,
    engine: db.engine ?? 'mariadb',
    websiteId: db.websiteId ?? null,
    domainId: db.domainId ?? domain.id ?? null,
    applicationId: db.applicationId ?? null,
  })));
}

function resolveNodeDockerProxy({ domain, website, dockerProjectsById }) {
  const composeBinding = domain?.managedComposeBinding
    ?? domain?.target?.managedComposeBinding
    ?? website?.managedComposeBinding
    ?? null;

  if (composeBinding && composeBinding.projectId) {
    const project = dockerProjectsById.get(composeBinding.projectId) ?? null;
    const service = project?.services?.find((item) => item?.name === composeBinding.serviceName) ?? null;
    const innerPort = composeBinding.targetPort ?? composeBinding.innerPort ?? null;
    const published = service?.publishedPorts?.find(
      (port) => port?.targetPort === innerPort && (port?.protocol ?? 'tcp') === (composeBinding.protocol ?? 'tcp'),
    ) ?? service?.publishedPorts?.[0] ?? null;
    const outerPort = published?.publishedPort ?? composeBinding.publishedPort ?? composeBinding.outerPort ?? null;
    return Object.freeze({
      mode: 'existing_managed_compose',
      projectId: composeBinding.projectId,
      projectName: project?.projectName ?? null,
      serviceName: composeBinding.serviceName ?? service?.name ?? null,
      innerPort,
      outerPort,
      targetPort: innerPort,
      publishedPort: outerPort,
      upstreamHost: '127.0.0.1',
      upstreamPort: outerPort,
      websocket: true,
    });
  }

  if (domain?.dockerProjectId && dockerProjectsById.has(domain.dockerProjectId)) {
    const project = dockerProjectsById.get(domain.dockerProjectId);
    const service = project?.services?.find((item) => item?.name === domain.dockerServiceName)
      ?? project?.services?.[0]
      ?? null;
    const published = service?.publishedPorts?.[0] ?? null;
    const innerPort = domain.innerPort ?? domain.targetPort ?? published?.targetPort ?? null;
    const outerPort = domain.outerPort ?? domain.publishedPort ?? published?.publishedPort ?? null;
    return Object.freeze({
      mode: 'existing_managed_compose',
      projectId: project.id,
      projectName: project.projectName ?? null,
      serviceName: service?.name ?? null,
      innerPort,
      outerPort,
      targetPort: innerPort,
      publishedPort: outerPort,
      upstreamHost: '127.0.0.1',
      upstreamPort: outerPort,
      websocket: true,
    });
  }

  if (domain?.targetType === 'proxy' && domain?.target) {
    const outerPort = domain.target.upstreamPort ?? domain.target.port ?? null;
    const innerPort = domain.target.innerPort ?? domain.target.targetPort ?? outerPort;
    return Object.freeze({
      mode: domain.target.mode ?? 'external_proxy',
      projectId: domain.target.projectId ?? null,
      projectName: domain.target.projectName ?? null,
      serviceName: domain.target.serviceName ?? null,
      innerPort,
      outerPort,
      targetPort: innerPort,
      publishedPort: outerPort,
      upstreamHost: domain.target.upstreamHost ?? domain.target.host ?? '127.0.0.1',
      upstreamPort: outerPort,
      websocket: domain.target.websocket !== false,
    });
  }

  if (website?.proxyTarget && (website.runtimeType === 'docker' || website.runtimeType === 'proxy')) {
    const outerPort = website.proxyTarget.port ?? null;
    const innerPort = website.proxyTarget.innerPort ?? outerPort;
    return Object.freeze({
      mode: website.dockerWorkloadId ? 'existing_docker' : 'external_proxy',
      projectId: null,
      projectName: null,
      serviceName: null,
      innerPort,
      outerPort,
      targetPort: innerPort,
      publishedPort: outerPort,
      upstreamHost: website.proxyTarget.host ?? '127.0.0.1',
      upstreamPort: outerPort,
      websocket: website.proxyTarget.websocket !== false,
    });
  }

  return null;
}

export function buildDomainHierarchyTree({
  websites = [],
  domains = [],
  applications = [],
  databases = [],
  dockerProjects = [],
} = {}) {
  if (!Array.isArray(websites) || !Array.isArray(domains) || !Array.isArray(applications)
    || !Array.isArray(databases) || !Array.isArray(dockerProjects)) {
    throw new SubdomainFileRootError('invalid_hierarchy_input', 'Hierarchy collections must be arrays');
  }

  const websitesById = new Map(websites.filter((w) => w && w.id).map((w) => [w.id, w]));
  const domainsById = new Map(domains.filter((d) => d && d.id).map((d) => [d.id, d]));
  const applicationsById = new Map(applications.filter((a) => a && a.id).map((a) => [a.id, a]));
  const dockerProjectsById = new Map(dockerProjects.filter((p) => p && p.id).map((p) => [p.id, p]));

  const childrenByParentId = new Map();
  const rootDomains = [];

  const sortedDomains = [...domains].sort((a, b) => String(a?.primaryDomain ?? '').localeCompare(String(b?.primaryDomain ?? '')));
  for (const domain of sortedDomains) {
    if (!domain || typeof domain !== 'object') continue;
    const parentId = domain.parentDomainId ?? null;
    if (parentId && domainsById.has(parentId)) {
      if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
      childrenByParentId.get(parentId).push(domain);
    } else {
      rootDomains.push(domain);
    }
  }

  let totalSubdomains = 0;

  function findRootAncestor(domain) {
    let current = domain;
    const visited = new Set([current.id]);
    while (current.parentDomainId && domainsById.has(current.parentDomainId)) {
      const next = domainsById.get(current.parentDomainId);
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      current = next;
    }
    return current;
  }

  function buildNode(domain, rootDomain, rootWebsite) {
    const isSubdomain = domain.parentDomainId != null && domainsById.has(domain.parentDomainId);
    const ownWebsite = domain.websiteId ? (websitesById.get(domain.websiteId) ?? null) : null;
    const effectiveWebsite = ownWebsite ?? rootWebsite ?? null;

    let fileRootResolution = null;
    let workspaceRoot = null;
    let fileRootPath = null;
    let relativeFromParentRoot = null;
    let subdomainPrefix = null;

    if (isSubdomain) {
      totalSubdomains += 1;
      fileRootResolution = resolveSubdomainFileRoot({
        parentDomain: rootDomain,
        parentWebsite: rootWebsite,
        subdomainDomain: domain,
      });
      workspaceRoot = fileRootResolution.parentWorkspaceRoot;
      fileRootPath = fileRootResolution.subdomainRootPath;
      relativeFromParentRoot = fileRootResolution.relativeFromParentRoot;
      subdomainPrefix = fileRootResolution.subdomainPrefix;
    } else {
      workspaceRoot = resolveParentWorkspaceRoot({ parentDomain: domain, parentWebsite: ownWebsite });
      fileRootPath = ownWebsite?.documentRoot
        ?? domain.documentRoot
        ?? domain.target?.root
        ?? workspaceRoot;
    }

    const runtime = resolveNodeRuntimeSummary({
      domain,
      website: ownWebsite ?? effectiveWebsite,
      applicationsById,
      isSubdomain,
    });
    const boundDatabases = resolveNodeDatabases({
      domain,
      website: ownWebsite ?? effectiveWebsite,
      runtimeSummary: runtime,
      databases,
      isSubdomain,
    });
    const dockerProxy = resolveNodeDockerProxy({
      domain,
      website: ownWebsite,
      dockerProjectsById,
    });

    const childDomains = childrenByParentId.get(domain.id) ?? [];
    const subdomains = Object.freeze(
      childDomains.map((child) => buildNode(child, rootDomain, rootWebsite)),
    );

    return Object.freeze({
      id: domain.id,
      websiteId: domain.websiteId ?? rootWebsite?.id ?? null,
      parentDomainId: domain.parentDomainId ?? null,
      kind: isSubdomain ? 'subdomain' : 'domain',
      primaryDomain: domain.primaryDomain,
      aliases: Object.freeze([...(domain.aliases ?? [])]),
      subdomainPrefix,
      workspaceRoot,
      fileRootPath,
      subdomainRootPath: isSubdomain ? fileRootPath : null,
      relativeFromParentRoot,
      runtime,
      databases: boundDatabases,
      boundDatabases,
      dockerProxy,
      supportsIndependentRuntime: true,
      supportsDatabaseBinding: true,
      supportsDockerProxy: true,
      capabilities: Object.freeze({
        supportsIndependentRuntime: true,
        supportsDatabaseBinding: true,
        supportsDockerProxy: true,
      }),
      subdomains,
    });
  }

  const roots = rootDomains.map((rootDomain) => {
    const rootAncestor = findRootAncestor(rootDomain);
    const rootWebsite = rootAncestor.websiteId ? (websitesById.get(rootAncestor.websiteId) ?? null) : null;
    return buildNode(rootDomain, rootAncestor, rootWebsite);
  });

  Object.defineProperty(roots, 'roots', {
    value: roots,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(roots, 'totalRootDomains', {
    value: roots.length,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(roots, 'totalSubdomains', {
    value: totalSubdomains,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return Object.freeze(roots);
}

export const subdomainFileRootInternals = Object.freeze({
  normalizeHostnameInput,
  assertSafePosixAbsolutePath,
  DEFAULT_VHOSTS_ROOT,
});
