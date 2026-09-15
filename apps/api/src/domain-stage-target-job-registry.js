import { createPhpFpmSiteManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { normalizeNginxSettings } from '@yunpanel/shared';
import { DomainRegistryError } from './domain-registry.js';
import { resolveWebsiteDomainTarget } from './website-domain-target.js';

export class DomainStageTargetJobRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainStageTargetJobRegistryError';
    this.code = code;
  }
}

function assertDependencies(
  registry,
  domainRegistry,
  websiteRegistry,
  dockerComposeProjectRegistry,
  applicationRegistry,
  runtimeBindingRegistry,
  phpFpmSiteManager,
) {
  if (!registry || typeof registry.enqueue !== 'function' || typeof registry.listJobs !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !runtimeBindingRegistry || typeof runtimeBindingRegistry.getBinding !== 'function'
    || !phpFpmSiteManager || typeof phpFpmSiteManager.inspect !== 'function') {
    throw new DomainStageTargetJobRegistryError(
      'domain_stage_target_dependencies_invalid',
      'Domain stage target job registry dependencies are invalid',
    );
  }
}

function resolvedNginxSettings(domain, resolved, current) {
  if (!['passenger', 'php'].includes(resolved.targetType)) return current;
  return normalizeNginxSettings(resolved.targetType, {
    clientMaxBodySizeMb: domain.nginxSettings?.clientMaxBodySizeMb ?? null,
    headers: domain.nginxSettings?.headers ?? [],
  });
}

async function assertPassengerMigrationIdle(registry) {
  const jobs = await registry.listJobs();
  if (jobs.some((job) => job.operation === OPERATIONS.APP_NODE_PASSENGER_MIGRATE
    && (job.status === 'queued' || job.status === 'running'))) {
    throw new DomainRegistryError(
      'node_passenger_migration_routing_busy',
      'Wait for Passenger migration to finish before changing Domain, Nginx or certificate routing',
      409,
    );
  }
}

export function createDomainStageTargetJobRegistry({
  registry,
  domainRegistry,
  websiteRegistry,
  dockerComposeProjectRegistry,
  applicationRegistry,
  runtimeBindingRegistry,
  phpFpmSiteManager = createPhpFpmSiteManager(),
} = {}) {
  assertDependencies(
    registry,
    domainRegistry,
    websiteRegistry,
    dockerComposeProjectRegistry,
    applicationRegistry,
    runtimeBindingRegistry,
    phpFpmSiteManager,
  );

  async function enqueue(input) {
    if ([OPERATIONS.SSL_ISSUE, OPERATIONS.SSL_RENEW].includes(input?.operation)) {
      await assertPassengerMigrationIdle(registry);
      return registry.enqueue(input);
    }
    if (input?.operation !== OPERATIONS.DOMAIN_STAGE) return registry.enqueue(input);
    if (input.resourceType !== 'domain' || typeof input.resourceId !== 'string') {
      throw new DomainRegistryError('domain_stage_resource_invalid', 'Domain stage job resource identity is invalid', 409);
    }
    const domain = await domainRegistry.getDomain(input.resourceId);
    if (!domain || domain.serverId !== input.serverId) {
      throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    }
    await assertPassengerMigrationIdle(registry);
    const resolved = await resolveWebsiteDomainTarget({
      domain,
      websiteRegistry,
      dockerComposeProjectRegistry,
      applicationRegistry,
      runtimeBindingRegistry,
      phpFpmSiteManager,
    });
    return registry.enqueue({
      ...input,
      payload: {
        ...(input.payload ?? {}),
        targetType: resolved.targetType,
        target: resolved.target,
        nginxSettings: resolvedNginxSettings(domain, resolved, input.payload?.nginxSettings),
      },
    });
  }

  return new Proxy(registry, {
    get(target, property, receiver) {
      if (property === 'enqueue') return enqueue;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const domainStageTargetJobRegistryInternals = Object.freeze({
  resolvedNginxSettings,
  assertPassengerMigrationIdle,
});
