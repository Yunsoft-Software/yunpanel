import { DomainRegistryError } from './domain-registry.js';
import {
  ManagedComposeWebsiteBindingError,
  resolveManagedComposeWebsiteBinding,
} from './managed-compose-website-binding.js';

function persistedDomainTarget(domain) {
  return Object.freeze({
    source: 'domain',
    targetType: domain.targetType,
    target: Object.freeze({ ...domain.target }),
  });
}

function requireDependency(value, method, code, message) {
  if (!value || typeof value[method] !== 'function') {
    throw new DomainRegistryError(code, message, 503);
  }
  return value;
}

export async function resolveWebsiteDomainTarget({
  domain,
  websiteRegistry = null,
  dockerComposeProjectRegistry = null,
} = {}) {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
    throw new DomainRegistryError('invalid_domain_target_state', 'Domain target state is invalid', 409);
  }
  if (!domain.websiteId) return persistedDomainTarget(domain);

  requireDependency(
    websiteRegistry,
    'getWebsite',
    'website_registry_unavailable',
    'Website registry is required to resolve Domain traffic target',
  );
  const website = await websiteRegistry.getWebsite(domain.websiteId);
  if (!website) throw new DomainRegistryError('website_not_found', 'Domain Website does not exist', 404);
  if (website.serverId !== domain.serverId) {
    throw new DomainRegistryError('website_server_mismatch', 'Domain and Website must belong to the same server', 409);
  }

  const binding = website.managedComposeBinding ?? null;
  if (binding === null) return persistedDomainTarget(domain);
  if (website.runtimeType !== 'docker' || website.applicationId !== null
    || website.dockerWorkloadId !== null || website.proxyTarget !== null) {
    throw new DomainRegistryError(
      'managed_compose_website_state_invalid',
      'Managed Compose Website binding conflicts with Website runtime state',
      409,
    );
  }
  if (domain.targetType !== 'proxy') {
    throw new DomainRegistryError(
      'managed_compose_domain_target_type_mismatch',
      'Managed Compose Websites require an explicit proxy Domain target',
      409,
    );
  }

  requireDependency(
    dockerComposeProjectRegistry,
    'getProject',
    'docker_compose_project_registry_unavailable',
    'Docker Compose project registry is required to resolve Domain traffic target',
  );
  const project = await dockerComposeProjectRegistry.getProject(binding.projectId);
  let resolved;
  try {
    resolved = resolveManagedComposeWebsiteBinding({
      binding,
      serverId: website.serverId,
      project,
    });
  } catch (error) {
    if (error instanceof ManagedComposeWebsiteBindingError) {
      throw new DomainRegistryError(error.code, error.message, error.status);
    }
    throw error;
  }

  return Object.freeze({
    source: 'managed_compose',
    targetType: 'proxy',
    target: Object.freeze({
      upstreamHost: resolved.proxyTarget.host,
      upstreamPort: resolved.proxyTarget.port,
      websocket: domain.nginxSettings?.websocket !== false,
    }),
  });
}
