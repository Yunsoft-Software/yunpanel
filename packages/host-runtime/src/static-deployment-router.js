import { createStaticDeploymentLegacyFallback } from './static-deployment-legacy-fallback.js';
import { createWebsiteStaticDeploymentManager } from './website-static-deployment-manager.js';

const LEGACY_ELIGIBLE_WEBSITE_ERRORS = new Set([
  'website_static_identity_missing',
  'website_static_identity_drift',
]);

export class StaticDeploymentRouterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticDeploymentRouterError';
    this.code = code;
  }
}

export function createStaticDeploymentRouter({
  websiteManager = null,
  legacyFallbackManager = null,
  createWebsiteManager = createWebsiteStaticDeploymentManager,
  createLegacyFallback = createStaticDeploymentLegacyFallback,
  ...managerOptions
} = {}) {
  if ((websiteManager !== null && typeof websiteManager?.deployStatic !== 'function')
    || (legacyFallbackManager !== null && typeof legacyFallbackManager?.deployStatic !== 'function')
    || typeof createWebsiteManager !== 'function'
    || typeof createLegacyFallback !== 'function') {
    throw new StaticDeploymentRouterError(
      'static_deployment_router_dependencies_invalid',
      'Static deployment router dependencies are invalid',
    );
  }

  const canonicalManager = websiteManager ?? createWebsiteManager(managerOptions);
  const legacyManager = legacyFallbackManager ?? createLegacyFallback(managerOptions);
  if (!canonicalManager || typeof canonicalManager.deployStatic !== 'function'
    || !legacyManager || typeof legacyManager.deployStatic !== 'function') {
    throw new StaticDeploymentRouterError(
      'static_deployment_router_dependencies_invalid',
      'Static deployment router managers are invalid',
    );
  }

  async function deployStatic(spec, options = {}) {
    try {
      return await canonicalManager.deployStatic(spec, options);
    } catch (error) {
      if (!LEGACY_ELIGIBLE_WEBSITE_ERRORS.has(error?.code)) throw error;
      try {
        return await legacyManager.deployStatic(spec, options);
      } catch {
        // Legacy fallback is migration-only. If its positive ownership proof is
        // absent, preserve the canonical failure so operators remediate the
        // Website identity instead of treating an unproven account as legacy.
        throw error;
      }
    }
  }

  return Object.freeze({ deployStatic });
}

export const staticDeploymentRouter = createStaticDeploymentRouter();

export const staticDeploymentRouterInternals = Object.freeze({
  legacyEligibleWebsiteErrors: Object.freeze([...LEGACY_ELIGIBLE_WEBSITE_ERRORS]),
});
