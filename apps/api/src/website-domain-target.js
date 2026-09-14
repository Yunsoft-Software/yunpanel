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

function passengerBindingDrift(message) {
  throw new DomainRegistryError('passenger_runtime_binding_drift', message, 409);
}

async function resolvePassengerRuntimeTarget({
  domain,
  website,
  applicationRegistry,
  runtimeBindingRegistry,
}) {
  if (website.runtimeType !== 'node' || !website.applicationId) return null;

  requireDependency(
    runtimeBindingRegistry,
    'getBinding',
    'runtime_binding_registry_unavailable',
    'Runtime binding registry is required to resolve Node Website traffic target',
  );
  const binding = await runtimeBindingRegistry.getBinding(website.applicationId);
  if (!binding || binding.adapter === 'direct-systemd') return null;
  if (binding.adapter !== 'passenger') {
    passengerBindingDrift('Node Website runtime binding adapter is not supported');
  }

  requireDependency(
    applicationRegistry,
    'getApplication',
    'application_registry_unavailable',
    'Application registry is required to validate Passenger traffic authority',
  );
  const application = await applicationRegistry.getApplication(website.applicationId);
  if (!application) passengerBindingDrift('Passenger runtime binding Application no longer exists');
  if (application.serverId !== domain.serverId || binding.serverId !== domain.serverId) {
    passengerBindingDrift('Passenger runtime binding server identity drifted');
  }
  if (binding.applicationId !== application.id || binding.websiteId !== website.id) {
    passengerBindingDrift('Passenger runtime binding resource identity drifted');
  }
  if (binding.releaseId !== application.currentReleaseId) {
    passengerBindingDrift('Passenger runtime binding release drifted from the active Application release');
  }
  if (binding.websiteRevision !== website.revision) {
    passengerBindingDrift('Passenger runtime binding Website revision drifted');
  }
  const domainEvidence = binding.domains.find((entry) => entry.domainId === domain.id);
  if (!domainEvidence || domain.desiredRevision < domainEvidence.desiredRevision) {
    passengerBindingDrift('Passenger runtime binding Domain revision drifted');
  }

  return Object.freeze({
    source: 'passenger',
    targetType: 'passenger',
    target: Object.freeze({
      root: binding.passengerTarget.appRoot,
      startupFile: binding.passengerTarget.startupFile,
      nodeBinary: binding.passengerTarget.nodeBinary,
    }),
  });
}

export async function resolveWebsiteDomainTarget({
  domain,
  websiteRegistry = null,
  dockerComposeProjectRegistry = null,
  applicationRegistry = null,
  runtimeBindingRegistry = null,
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
  if (binding === null) {
    const passengerTarget = await resolvePassengerRuntimeTarget({
      domain,
      website,
      applicationRegistry,
      runtimeBindingRegistry,
    });
    return passengerTarget ?? persistedDomainTarget(domain);
  }
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

export const websiteDomainTargetInternals = Object.freeze({
  persistedDomainTarget,
  resolvePassengerRuntimeTarget,
});
