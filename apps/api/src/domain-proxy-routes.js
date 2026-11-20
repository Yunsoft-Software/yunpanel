import { OPERATIONS } from '@yunpanel/protocol';
import { assertUuid } from '@yunpanel/shared';
import { DomainRegistryError } from './domain-registry.js';
import {
  ManagedComposeWebsiteBindingError,
  resolveManagedComposeWebsiteBinding,
} from './managed-compose-website-binding.js';
import { SiteMutationLockError } from './site-mutation-lock.js';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function isOwnerManagementAuth(auth) {
  return Boolean(
    auth?.user?.role === 'owner'
    && auth?.access?.mode === 'management'
    && auth?.security?.managementAllowed === true
    && (!Array.isArray(auth?.access?.permissions) || auth.access.permissions.includes('*')),
  );
}

export function requireOwnerDockerAccess(request, response, next) {
  const auth = request.auth;
  if (!auth?.user || !auth?.access || !auth?.security) {
    return response.status(401).json({
      error: { code: 'unauthorized', message: 'Authenticated panel context is required.' },
    });
  }
  if (!isOwnerManagementAuth(auth)) {
    return response.status(403).json({
      error: { code: 'docker_owner_required', message: 'Docker management is restricted to Owner accounts.' },
    });
  }
  return next();
}

export function assertOwnerProxyRouteAccess(request, currentRoutes, nextSettings) {
  if (!nextSettings || typeof nextSettings !== 'object' || Array.isArray(nextSettings)) return;
  if (!Object.hasOwn(nextSettings, 'proxyRoutes')) return;
  if (!request?.auth) return;
  if (isOwnerManagementAuth(request.auth)) return;

  const nextRoutes = nextSettings.proxyRoutes;
  if (currentRoutes === undefined) {
    throw new DomainRegistryError(
      'proxy_routes_owner_only',
      'Sub-path proxy routes can only be managed by an Owner account',
      403,
    );
  }
  if (currentRoutes === null && nextRoutes === null) return;
  if (Array.isArray(currentRoutes) && Array.isArray(nextRoutes) && stableJson(currentRoutes) === stableJson(nextRoutes)) {
    return;
  }
  throw new DomainRegistryError(
    'proxy_routes_owner_only',
    'Sub-path proxy routes can only be managed by an Owner account',
    403,
  );
}

export function proxyRouteProjectIds(...routeLists) {
  const ids = new Set();
  for (const list of routeLists) {
    if (!Array.isArray(list)) continue;
    for (const route of list) {
      if (typeof route?.projectId !== 'string') continue;
      try {
        ids.add(assertUuid(route.projectId, 'projectId'));
      } catch {
        // Invalid UUIDs are rejected by schema validation before locking.
      }
    }
  }
  return [...ids].sort();
}

export async function withProxyRouteProjectLocks(
  siteMutationLock,
  projectIds,
  action,
  ErrorClass = DomainRegistryError,
) {
  const ids = [...new Set((projectIds ?? []).filter((id) => typeof id === 'string' && id.length > 0))].sort();
  if (!siteMutationLock || ids.length === 0) return action();
  try {
    if (typeof siteMutationLock.withDockerProjectLocks === 'function') {
      return await siteMutationLock.withDockerProjectLocks(ids, action);
    }
    if (typeof siteMutationLock.withDockerProjectLock === 'function') {
      const acquire = (index) => {
        if (index >= ids.length) return action();
        return siteMutationLock.withDockerProjectLock(ids[index], () => acquire(index + 1));
      };
      return await acquire(0);
    }
    if (typeof siteMutationLock.withLock === 'function') {
      const acquire = (index) => {
        if (index >= ids.length) return action();
        return siteMutationLock.withLock({ resourceType: 'docker_project', resourceId: ids[index] }, () => acquire(index + 1));
      };
      return await acquire(0);
    }
    return await action();
  } catch (error) {
    if (error instanceof SiteMutationLockError || error?.name === 'SiteMutationLockError') {
      throw new ErrorClass(error.code, error.message, error.status ?? 409);
    }
    throw error;
  }
}

export async function verifyDomainProxyRoutes({
  routes,
  serverId,
  dockerComposeProjectRegistry,
  jobRegistry = null,
} = {}) {
  if (!Array.isArray(routes) || routes.length === 0) return [];
  if (!dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function') {
    throw new DomainRegistryError(
      'docker_project_registry_unavailable',
      'Docker project registry is unavailable',
      503,
    );
  }

  const projectCache = new Map();
  const checkedRemoval = new Set();

  for (const route of routes) {
    if (jobRegistry && typeof jobRegistry.listJobs === 'function' && !checkedRemoval.has(route.projectId)) {
      checkedRemoval.add(route.projectId);
      const jobs = await jobRegistry.listJobs({ resourceType: 'docker_project', resourceId: route.projectId });
      if (Array.isArray(jobs) && jobs.some((job) => (
        job?.operation === OPERATIONS.DOCKER_COMPOSE_REMOVE && ACTIVE_JOB_STATUSES.has(job.status)
      ))) {
        throw new DomainRegistryError(
          'docker_compose_project_removing',
          'Docker Compose project retirement is active',
          409,
        );
      }
    }

    let project = projectCache.get(route.projectId);
    if (project === undefined) {
      project = await dockerComposeProjectRegistry.getProject(route.projectId);
      projectCache.set(route.projectId, project);
    }

    let resolved;
    try {
      resolved = resolveManagedComposeWebsiteBinding({
        binding: {
          projectId: route.projectId,
          serviceName: route.serviceName,
          targetPort: route.targetPort,
          protocol: route.protocol,
        },
        serverId,
        project,
      });
    } catch (error) {
      if (error instanceof ManagedComposeWebsiteBindingError) {
        throw new DomainRegistryError(error.code, error.message, error.status ?? 409);
      }
      throw error;
    }

    if (!Number.isSafeInteger(resolved.proxyTarget.port)
      || resolved.proxyTarget.port < 1024
      || resolved.proxyTarget.port > 65535) {
      throw new DomainRegistryError(
        'docker_proxy_route_port_privileged',
        'Sub-path proxy route target port must be published on a non-privileged host port (1024-65535)',
        409,
      );
    }

    if (route.upstreamHost !== resolved.proxyTarget.host || route.upstreamPort !== resolved.proxyTarget.port) {
      throw new DomainRegistryError(
        'docker_proxy_route_binding_mismatch',
        'Sub-path proxy route upstream does not match the current Docker Compose published port binding',
        409,
      );
    }
  }

  return routes;
}

export async function collectProjectProxyRouteReferences({
  projectId,
  serverId = null,
  domainRegistry = null,
  jobRegistry = null,
  ErrorClass = DomainRegistryError,
} = {}) {
  const references = [];
  const domainsById = new Map();

  if (domainRegistry !== null && domainRegistry !== undefined) {
    if (typeof domainRegistry.listDomains !== 'function') {
      throw new ErrorClass('docker_compose_removal_inventory_unavailable', 'Domain inventory is unavailable', 409);
    }
    const domains = await domainRegistry.listDomains();
    if (!Array.isArray(domains)) {
      throw new ErrorClass('docker_compose_removal_inventory_unavailable', 'Domain inventory is unavailable', 409);
    }
    for (const domain of domains) {
      if (!domain || (serverId !== null && domain.serverId !== serverId)) continue;
      domainsById.set(domain.id, domain);

      // 1. Desired draft proxyRoutes
      const desiredRoutes = domain.nginxSettings?.proxyRoutes;
      if (Array.isArray(desiredRoutes)) {
        for (const route of desiredRoutes) {
          if (route?.projectId === projectId) {
            references.push({
              source: 'domain',
              domainId: domain.id,
              primaryDomain: domain.primaryDomain ?? null,
              route,
            });
          }
        }
      }

      // 2. Staged config proxyRoutes tied to stagedChecksum
      if (typeof domain.stagedChecksum === 'string' && domain.stagedChecksum.length > 0
        && Array.isArray(domain.stagedProxyRoutes)) {
        for (const route of domain.stagedProxyRoutes) {
          if (route?.projectId === projectId) {
            references.push({
              source: 'staged_domain',
              domainId: domain.id,
              primaryDomain: domain.primaryDomain ?? null,
              route,
            });
          }
        }
      }

      // 3. Applied live config proxyRoutes tied to appliedChecksum (with active legacy fallback)
      if (typeof domain.appliedChecksum === 'string' && domain.appliedChecksum.length > 0) {
        const appliedRoutes = Array.isArray(domain.appliedProxyRoutes)
          ? domain.appliedProxyRoutes
          : (!Object.hasOwn(domain, 'appliedProxyRoutes')
            && domain.state === 'active'
            && domain.appliedRevision === domain.desiredRevision
            && Array.isArray(desiredRoutes)
            ? desiredRoutes
            : []);
        for (const route of appliedRoutes) {
          if (route?.projectId === projectId) {
            references.push({
              source: 'applied_domain',
              domainId: domain.id,
              primaryDomain: domain.primaryDomain ?? null,
              route,
            });
          }
        }
      }
    }
  }

  if (jobRegistry !== null && jobRegistry !== undefined) {
    if (typeof jobRegistry.listJobs !== 'function') {
      throw new ErrorClass('docker_compose_job_state_unavailable', 'Domain job inventory is unavailable', 503);
    }
    const jobs = await jobRegistry.listJobs();
    if (!Array.isArray(jobs)) {
      throw new ErrorClass('docker_compose_job_state_unavailable', 'Domain job inventory is unavailable', 503);
    }
    for (const job of jobs) {
      if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) continue;
      if (serverId !== null && job.serverId !== serverId) continue;

      if (job.operation === OPERATIONS.DOMAIN_STAGE) {
        const routes = job.payload?.nginxSettings?.proxyRoutes;
        if (!Array.isArray(routes)) continue;
        for (const route of routes) {
          if (route?.projectId === projectId) {
            references.push({
              source: 'pending_domain_stage',
              jobId: job.id,
              domainId: job.resourceId ?? null,
              primaryDomain: job.payload?.primaryDomain ?? null,
              route,
            });
          }
        }
      } else if (job.operation === OPERATIONS.DOMAIN_ACTIVATE) {
        const domain = domainsById.get(job.resourceId) ?? (
          typeof domainRegistry?.getDomain === 'function'
            ? await domainRegistry.getDomain(job.resourceId)
            : null
        );
        if (domain) {
          for (const candidateList of [
            domain.nginxSettings?.proxyRoutes,
            domain.stagedProxyRoutes,
            domain.appliedProxyRoutes,
          ]) {
            if (!Array.isArray(candidateList)) continue;
            for (const route of candidateList) {
              if (route?.projectId === projectId) {
                references.push({
                  source: 'pending_domain_activate',
                  jobId: job.id,
                  domainId: domain.id,
                  primaryDomain: domain.primaryDomain ?? job.payload?.primaryDomain ?? null,
                  route,
                });
              }
            }
          }
        }
        // Also inspect staged config jobs matching this activation's checksum in case
        // the domain draft cleared proxyRoutes after staging while activation is still running.
        const checksum = job.payload?.checksum;
        if (checksum) {
          for (const candidate of jobs) {
            if (candidate?.operation !== OPERATIONS.DOMAIN_STAGE
              || candidate.resourceId !== job.resourceId
              || candidate.result?.checksum !== checksum) continue;
            const stageRoutes = candidate.payload?.nginxSettings?.proxyRoutes;
            if (!Array.isArray(stageRoutes)) continue;
            for (const route of stageRoutes) {
              if (route?.projectId === projectId) {
                references.push({
                  source: 'pending_domain_activate',
                  jobId: job.id,
                  domainId: job.resourceId ?? null,
                  primaryDomain: candidate.payload?.primaryDomain ?? job.payload?.primaryDomain ?? null,
                  route,
                });
              }
            }
          }
        }
      }
    }
  }

  return references;
}

export async function assertProjectNotReferencedByProxyRoutes({
  projectId,
  serverId = null,
  domainRegistry = null,
  jobRegistry = null,
  ErrorClass = DomainRegistryError,
  code = 'docker_compose_project_in_use',
} = {}) {
  const references = await collectProjectProxyRouteReferences({
    projectId,
    serverId,
    domainRegistry,
    jobRegistry,
    ErrorClass,
  });
  if (references.length > 0) {
    throw new ErrorClass(
      code,
      'Remove active or pending Domain sub-path proxy routes before retiring this Compose project',
      409,
    );
  }
}

export async function assertProjectUpdatePreservesProxyRoutes({
  project,
  nextServices,
  domainRegistry = null,
  jobRegistry = null,
  ErrorClass = DomainRegistryError,
} = {}) {
  if (!project || typeof project !== 'object') return;
  const references = await collectProjectProxyRouteReferences({
    projectId: project.id,
    serverId: project.serverId ?? null,
    domainRegistry,
    jobRegistry,
    ErrorClass,
  });
  if (references.length === 0) return;

  const candidateProject = {
    id: project.id,
    serverId: project.serverId,
    services: Array.isArray(nextServices) ? nextServices : [],
  };

  for (const ref of references) {
    const { route } = ref;
    let resolved = null;
    try {
      resolved = resolveManagedComposeWebsiteBinding({
        binding: {
          projectId: route.projectId,
          serviceName: route.serviceName,
          targetPort: route.targetPort,
          protocol: route.protocol,
        },
        serverId: project.serverId,
        project: candidateProject,
      });
    } catch {
      resolved = null;
    }

    const preserved = Boolean(
      resolved
      && Number.isSafeInteger(resolved.proxyTarget.port)
      && resolved.proxyTarget.port >= 1024
      && resolved.proxyTarget.port <= 65535
      && resolved.proxyTarget.host === route.upstreamHost
      && resolved.proxyTarget.port === route.upstreamPort,
    );

    if (!preserved) {
      const targetLabel = ref.primaryDomain ?? ref.domainId ?? 'domain';
      throw new ErrorClass(
        'docker_compose_proxy_route_in_use',
        `Compose update would break sub-path proxy route ${route.path} on ${targetLabel} (${route.serviceName}:${route.targetPort} -> ${route.upstreamHost}:${route.upstreamPort})`,
        409,
      );
    }
  }
}
