import { OPERATIONS } from '@yunpanel/protocol';
import { DomainRegistryError } from './domain-registry.js';
import { resolveWebsiteDomainTarget } from './website-domain-target.js';

export class DomainStageTargetJobRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainStageTargetJobRegistryError';
    this.code = code;
  }
}

function assertDependencies(registry, domainRegistry, websiteRegistry, dockerComposeProjectRegistry) {
  if (!registry || typeof registry.enqueue !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function') {
    throw new DomainStageTargetJobRegistryError(
      'domain_stage_target_dependencies_invalid',
      'Domain stage target job registry dependencies are invalid',
    );
  }
}

export function createDomainStageTargetJobRegistry({
  registry,
  domainRegistry,
  websiteRegistry,
  dockerComposeProjectRegistry,
} = {}) {
  assertDependencies(registry, domainRegistry, websiteRegistry, dockerComposeProjectRegistry);

  async function enqueue(input) {
    if (input?.operation !== OPERATIONS.DOMAIN_STAGE) return registry.enqueue(input);
    if (input.resourceType !== 'domain' || typeof input.resourceId !== 'string') {
      throw new DomainRegistryError('domain_stage_resource_invalid', 'Domain stage job resource identity is invalid', 409);
    }
    const domain = await domainRegistry.getDomain(input.resourceId);
    if (!domain || domain.serverId !== input.serverId) {
      throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    }
    const resolved = await resolveWebsiteDomainTarget({
      domain,
      websiteRegistry,
      dockerComposeProjectRegistry,
    });
    return registry.enqueue({
      ...input,
      payload: {
        ...(input.payload ?? {}),
        targetType: resolved.targetType,
        target: resolved.target,
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
