import { assertUuid } from '@yunpanel/shared';
import {
  createDomainRegistry as createBaseDomainRegistry,
  DomainRegistryError,
  domainRegistryInternals,
} from './domain-registry-base.js';

function mismatch(message = 'Domain routing target does not match the bound Website') {
  throw new DomainRegistryError('domain_website_target_mismatch', message, 409);
}

function websiteTargetMatches(website, targetType, target) {
  if (!website || typeof website !== 'object' || typeof website.runtimeType !== 'string') return true;
  const normalized = domainRegistryInternals.validateTarget(targetType, target);

  if (website.runtimeType === 'static') {
    if (targetType !== 'static' || normalized.root !== website.documentRoot) {
      mismatch('Static Domain root does not match the bound Website document root');
    }
    return true;
  }

  if (website.runtimeType === 'php') {
    if (targetType !== 'php' || normalized.applicationId !== website.applicationId) {
      mismatch('PHP Domain Application identity does not match the bound Website');
    }
    return true;
  }

  if (website.runtimeType === 'node') {
    if (targetType === 'passenger') {
      if (normalized.applicationId !== website.applicationId) {
        mismatch('Passenger Domain Application identity does not match the bound Website');
      }
      return true;
    }
    // Legacy direct-systemd Node Websites do not persist their proxy binding on
    // the Website record. Keep that migration-compatible proxy shape until the
    // retained runtime is fully migrated to Passenger.
    if (targetType === 'proxy') return true;
    mismatch('Node Domain target type does not match the bound Website runtime');
  }

  if (website.runtimeType === 'docker' || website.runtimeType === 'proxy') {
    if (targetType !== 'proxy') mismatch('Proxy-backed Website requires a proxy Domain target');
    if (!website.proxyTarget) return true;
    if (normalized.upstreamHost !== website.proxyTarget.host
      || normalized.upstreamPort !== website.proxyTarget.port
      || normalized.websocket !== website.proxyTarget.websocket) {
      mismatch('Proxy Domain upstream does not match the bound Website target');
    }
    return true;
  }

  return true;
}

function normalizedWebsiteId(value) {
  if (value == null) return null;
  try { return assertUuid(value, 'websiteId'); }
  catch { return null; }
}

async function assertWebsiteTargetBinding(options, input) {
  const websiteId = normalizedWebsiteId(input?.websiteId);
  if (websiteId === null || typeof options.getWebsite !== 'function') return;
  const website = await options.getWebsite(websiteId);
  if (!website) return;
  websiteTargetMatches(website, input?.targetType, input?.target);
}

export function createDomainRegistry(options = {}) {
  const base = createBaseDomainRegistry(options);
  return Object.freeze({
    ...base,
    async createDomain(input = {}) {
      await assertWebsiteTargetBinding(options, input);
      return base.createDomain(input);
    },
    async bindWebsite(domainId, websiteId) {
      const normalized = normalizedWebsiteId(websiteId);
      if (normalized !== null && typeof options.getWebsite === 'function') {
        const [domain, website] = await Promise.all([
          base.getDomain(domainId),
          options.getWebsite(normalized),
        ]);
        if (domain && website) websiteTargetMatches(website, domain.targetType, domain.target);
      }
      return base.bindWebsite(domainId, websiteId);
    },
  });
}

export { DomainRegistryError, domainRegistryInternals };

export const domainWebsiteTargetBindingInternals = Object.freeze({
  websiteTargetMatches,
  normalizedWebsiteId,
  assertWebsiteTargetBinding,
});
