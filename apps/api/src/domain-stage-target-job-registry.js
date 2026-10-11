import { createPhpFpmSiteManager } from '@yunpanel/host-runtime';
import { createServiceUmaskManager } from '@yunpanel/host-runtime/service-umask-manager';
import { OPERATIONS } from '@yunpanel/protocol';
import { domainNginxSettingsForTarget } from './domain-nginx-settings.js';
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
  serviceUmaskManager,
) {
  if (!registry || typeof registry.enqueue !== 'function' || typeof registry.listJobs !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !runtimeBindingRegistry || typeof runtimeBindingRegistry.getBinding !== 'function'
    || !phpFpmSiteManager || typeof phpFpmSiteManager.inspect !== 'function'
    || !serviceUmaskManager || typeof serviceUmaskManager.inspect !== 'function') {
    throw new DomainStageTargetJobRegistryError(
      'domain_stage_target_dependencies_invalid',
      'Domain stage target job registry dependencies are invalid',
    );
  }
}

function resolvedNginxSettings(domain, resolved, current) {
  if (!['passenger', 'php'].includes(resolved.targetType)) return current;
  return domainNginxSettingsForTarget(domain, resolved.targetType);
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
  serviceUmaskManager = createServiceUmaskManager(),
  siteMutationLock = null,
} = {}) {
  assertDependencies(
    registry,
    domainRegistry,
    websiteRegistry,
    dockerComposeProjectRegistry,
    applicationRegistry,
    runtimeBindingRegistry,
    phpFpmSiteManager,
    serviceUmaskManager,
  );

  async function enqueueStage(input, lockedApplicationId = null) {
    if (input.resourceType !== 'domain' || typeof input.resourceId !== 'string') {
      throw new DomainRegistryError('domain_stage_resource_invalid', 'Domain stage job resource identity is invalid', 409);
    }
    const domain = await domainRegistry.getDomain(input.resourceId);
    if (!domain || domain.serverId !== input.serverId) {
      throw new DomainRegistryError('domain_not_found', 'Domain not found', 404);
    }
    if (lockedApplicationId !== null) {
      const website = await websiteRegistry.getWebsite(domain.websiteId);
      if (website?.applicationId !== lockedApplicationId) throw new DomainRegistryError('passenger_runtime_binding_drift', 'Domain Application changed while acquiring its routing lock', 409);
    }
    await assertPassengerMigrationIdle(registry);
    const resolved = await resolveWebsiteDomainTarget({
      domain,
      websiteRegistry,
      dockerComposeProjectRegistry,
      applicationRegistry,
      runtimeBindingRegistry,
      phpFpmSiteManager,
      serviceUmaskManager,
      allowPassengerDomainAttachment: true,
    });
    if (resolved.source === 'passenger') {
      if (resolved.passengerAttachment && lockedApplicationId === null) {
        throw new DomainRegistryError('passenger_domain_attachment_lock_unavailable', 'New Passenger Domain attachment requires the site routing lock', 503);
      }
      for (const job of await registry.listJobs()) {
        if (job.operation !== OPERATIONS.DOMAIN_STAGE || job.payload?.targetType !== 'passenger'
          || !['queued', 'running'].includes(job.status) || job.serverId !== domain.serverId) continue;
        const queuedDomain = await domainRegistry.getDomain(job.resourceId);
        if (queuedDomain?.websiteId === domain.websiteId) {
          throw new DomainRegistryError('passenger_domain_routing_busy', 'Wait for this Website Domain preparation to finish before preparing another Domain', 409);
        }
      }
    }
    // Attachment authority is produced here, never accepted from a caller.
    const { passengerAttachment: _callerAttachment, ...payload } = input.payload ?? {};
    return registry.enqueue({
      ...input,
      payload: {
        ...payload,
        domainRevision: domain.desiredRevision,
        targetType: resolved.targetType,
        target: resolved.target,
        nginxSettings: resolvedNginxSettings(domain, resolved, input.payload?.nginxSettings),
        ...(resolved.passengerAttachment ? { passengerAttachment: resolved.passengerAttachment } : {}),
      },
    });
  }

  async function enqueue(input) {
    if ([OPERATIONS.SSL_ISSUE, OPERATIONS.SSL_RENEW].includes(input?.operation)) {
      await assertPassengerMigrationIdle(registry);
      return registry.enqueue(input);
    }
    if (input?.operation !== OPERATIONS.DOMAIN_STAGE) return registry.enqueue(input);
    const domain = input.resourceType === 'domain' ? await domainRegistry.getDomain(input.resourceId) : null;
    const website = domain?.websiteId ? await websiteRegistry.getWebsite(domain.websiteId) : null;
    if (website?.runtimeType === 'node' && website.applicationId && typeof siteMutationLock?.withApplicationLock === 'function') {
      return siteMutationLock.withApplicationLock(website.applicationId, () => enqueueStage(input, website.applicationId));
    }
    return enqueueStage(input);
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
