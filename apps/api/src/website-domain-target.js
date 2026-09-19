import { DomainRegistryError } from './domain-registry.js';
import {
  ManagedComposeWebsiteBindingError,
  resolveManagedComposeWebsiteBinding,
} from './managed-compose-website-binding.js';

const PHP_SOCKET_PATTERN = /^\/run\/php\/yunpanel-yunapp-[a-f0-9]{12}\.sock$/;

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

function phpBindingDrift(message) {
  throw new DomainRegistryError('php_runtime_binding_drift', message, 409);
}

function staticBindingDrift(message) {
  throw new DomainRegistryError('static_runtime_binding_drift', message, 409);
}

async function resolveStaticRuntimeTarget({
  domain,
  website,
  applicationRegistry,
  runtimeBindingRegistry,
}) {
  if (website.runtimeType !== 'static' || !website.applicationId) return null;

  requireDependency(
    runtimeBindingRegistry,
    'getBinding',
    'runtime_binding_registry_unavailable',
    'Runtime binding registry is required to resolve Static Website traffic target',
  );
  const binding = await runtimeBindingRegistry.getBinding(website.applicationId);
  if (!binding) return null;
  if (binding.adapter !== 'static') {
    staticBindingDrift('Static Website runtime binding adapter is not supported');
  }
  if (domain.targetType !== 'static') {
    staticBindingDrift('Static Domain target type does not match the bound Website runtime');
  }

  requireDependency(
    applicationRegistry,
    'getApplication',
    'application_registry_unavailable',
    'Application registry is required to validate Static traffic authority',
  );
  const application = await applicationRegistry.getApplication(website.applicationId);
  if (!application) staticBindingDrift('Static runtime binding Application no longer exists');
  if (application.serverId !== domain.serverId || binding.serverId !== domain.serverId) {
    staticBindingDrift('Static runtime binding server identity drifted');
  }
  if (binding.applicationId !== application.id || binding.websiteId !== website.id) {
    staticBindingDrift('Static runtime binding resource identity drifted');
  }
  if (binding.releaseId !== application.currentReleaseId) {
    staticBindingDrift('Static runtime binding release drifted from the active Application release');
  }
  if (binding.websiteRevision !== website.revision) {
    staticBindingDrift('Static runtime binding Website revision drifted');
  }
  const domainEvidence = binding.domains.find((entry) => entry.domainId === domain.id);
  if (!domainEvidence || domain.desiredRevision < domainEvidence.desiredRevision) {
    staticBindingDrift('Static runtime binding Domain revision drifted');
  }

  return Object.freeze({
    source: 'static',
    targetType: 'static',
    target: Object.freeze({
      root: binding.staticTarget.documentRoot,
      spaFallback: domain.nginxSettings?.spaFallback !== false,
    }),
  });
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

async function resolvePhpRuntimeTarget({
  domain,
  website,
  applicationRegistry,
  phpFpmSiteManager,
  serviceUmaskManager,
}) {
  if (website.runtimeType !== 'php') return null;
  if (!website.applicationId || !website.unixUser || !website.documentRoot) {
    phpBindingDrift('PHP Website runtime identity is incomplete');
  }
  if (domain.targetType !== 'php' || domain.target?.applicationId !== website.applicationId) {
    phpBindingDrift('PHP Domain target does not match the Website Application');
  }

  requireDependency(
    applicationRegistry,
    'getApplication',
    'application_registry_unavailable',
    'Application registry is required to validate PHP traffic authority',
  );
  requireDependency(
    phpFpmSiteManager,
    'inspect',
    'php_runtime_inspector_unavailable',
    'PHP-FPM runtime inspector is required to resolve PHP traffic authority',
  );
  requireDependency(
    serviceUmaskManager,
    'inspect',
    'php_umask_inspector_unavailable',
    'Managed service umask inspector is required to resolve PHP traffic authority',
  );

  const application = await applicationRegistry.getApplication(website.applicationId);
  if (!application || application.type !== 'php') {
    phpBindingDrift('PHP Website Application no longer exists or changed type');
  }
  if (application.serverId !== domain.serverId || application.webRoot !== website.documentRoot) {
    phpBindingDrift('PHP Website Application path or server identity drifted');
  }

  const runtime = await phpFpmSiteManager.inspect({
    websiteId: website.id,
    applicationId: application.id,
    unixUser: website.unixUser,
    documentRoot: website.documentRoot,
  });
  if (!runtime || runtime.satisfied !== true || runtime.adapter !== 'php-fpm') {
    throw new DomainRegistryError(
      'php_runtime_binding_required',
      `PHP Domain target cannot be staged until the managed PHP-FPM runtime is healthy${runtime?.reason ? ` (${runtime.reason})` : ''}`,
      409,
    );
  }
  const umask = await serviceUmaskManager.inspect('php');
  if (!umask || umask.satisfied !== true || umask.umask !== '0027') {
    throw new DomainRegistryError(
      'php_runtime_binding_required',
      `PHP Domain target cannot be staged until the PHP-FPM UMask=0027 policy is healthy${umask?.reason ? ` (${umask.reason})` : ''}`,
      409,
    );
  }
  if (runtime.websiteId !== website.id || runtime.applicationId !== application.id
    || runtime.unixUser !== website.unixUser || runtime.documentRoot !== website.documentRoot
    || typeof runtime.socketPath !== 'string' || !PHP_SOCKET_PATTERN.test(runtime.socketPath)) {
    phpBindingDrift('PHP-FPM runtime evidence drifted from the Website identity');
  }

  return Object.freeze({
    source: 'php',
    targetType: 'php',
    target: Object.freeze({
      root: runtime.documentRoot,
      socketPath: runtime.socketPath,
    }),
  });
}

export async function resolveWebsiteDomainTarget({
  domain,
  websiteRegistry = null,
  dockerComposeProjectRegistry = null,
  applicationRegistry = null,
  runtimeBindingRegistry = null,
  phpFpmSiteManager = null,
  serviceUmaskManager = null,
} = {}) {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
    throw new DomainRegistryError('invalid_domain_target_state', 'Domain target state is invalid', 409);
  }
  if (!domain.websiteId) {
    if (domain.targetType === 'passenger') {
      throw new DomainRegistryError(
        'passenger_runtime_binding_required',
        'Passenger Domain target requires a Website runtime binding before staging',
        409,
      );
    }
    if (domain.targetType === 'php') {
      throw new DomainRegistryError(
        'php_runtime_binding_required',
        'PHP Domain target requires a Website runtime binding before staging',
        409,
      );
    }
    return persistedDomainTarget(domain);
  }

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
    const staticTarget = await resolveStaticRuntimeTarget({
      domain,
      website,
      applicationRegistry,
      runtimeBindingRegistry,
    });
    if (staticTarget) return staticTarget;
    const passengerTarget = await resolvePassengerRuntimeTarget({
      domain,
      website,
      applicationRegistry,
      runtimeBindingRegistry,
    });
    if (passengerTarget) return passengerTarget;
    const phpTarget = await resolvePhpRuntimeTarget({
      domain,
      website,
      applicationRegistry,
      phpFpmSiteManager,
      serviceUmaskManager,
    });
    if (phpTarget) return phpTarget;
    if (domain.targetType === 'passenger') {
      throw new DomainRegistryError(
        'passenger_runtime_binding_required',
        'Passenger Domain target cannot be staged until the canonical Passenger runtime binding is active',
        409,
      );
    }
    if (domain.targetType === 'php') {
      throw new DomainRegistryError(
        'php_runtime_binding_required',
        'PHP Domain target cannot be staged until the canonical PHP runtime is active',
        409,
      );
    }
    return persistedDomainTarget(domain);
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
  resolveStaticRuntimeTarget,
  resolvePassengerRuntimeTarget,
  resolvePhpRuntimeTarget,
  phpSocketPattern: PHP_SOCKET_PATTERN,
});
