import { createApplicationIdentity } from './application-identity.js';
import { createStaticDeploymentLegacyFallback } from './static-deployment-legacy-fallback.js';
import { createStaticRollbackManager } from './static-rollback-manager.js';
import { createWebsiteStaticDeploymentManager } from './website-static-deployment-manager.js';

const LEGACY_ELIGIBLE_WEBSITE_ERRORS = new Set([
  'website_static_identity_missing',
  'website_static_identity_drift',
]);

export class StaticRollbackRouterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticRollbackRouterError';
    this.code = code;
  }
}

export function createStaticRollbackRouter({
  buildRoot = '/var/lib/yunpanel/build',
  webRoot = '/var/www/yunpanel/apps',
  dataRoot = '/var/lib/yunpanel/data',
  canonicalIdentityManager = null,
  legacyFallbackInspector = null,
  rollbackManager = null,
  createCanonicalManager = createWebsiteStaticDeploymentManager,
  createLegacyFallback = createStaticDeploymentLegacyFallback,
  createRollbackManager = createStaticRollbackManager,
  ...managerOptions
} = {}) {
  if ((canonicalIdentityManager !== null && typeof canonicalIdentityManager?.inspectIdentity !== 'function')
    || (legacyFallbackInspector !== null && typeof legacyFallbackInspector?.inspectLegacyIdentity !== 'function')
    || (rollbackManager !== null && typeof rollbackManager?.rollbackStatic !== 'function')
    || typeof createCanonicalManager !== 'function'
    || typeof createLegacyFallback !== 'function'
    || typeof createRollbackManager !== 'function') {
    throw new StaticRollbackRouterError(
      'static_rollback_router_dependencies_invalid',
      'Static rollback router dependencies are invalid',
    );
  }

  const canonicalManager = canonicalIdentityManager ?? createCanonicalManager({
    buildRoot,
    webRoot,
    dataRoot,
    ...managerOptions,
  });
  const legacyInspector = legacyFallbackInspector ?? createLegacyFallback({
    buildRoot,
    webRoot,
    ...managerOptions,
  });
  const resolvedRollbackManager = rollbackManager ?? createRollbackManager({
    webRoot,
    ...managerOptions,
  });
  if (!canonicalManager || typeof canonicalManager.inspectIdentity !== 'function'
    || !legacyInspector || typeof legacyInspector.inspectLegacyIdentity !== 'function'
    || !resolvedRollbackManager || typeof resolvedRollbackManager.rollbackStatic !== 'function') {
    throw new StaticRollbackRouterError(
      'static_rollback_router_dependencies_invalid',
      'Static rollback router managers are invalid',
    );
  }

  function identityFor(applicationId) {
    try {
      return createApplicationIdentity(applicationId, {
        dataRoot,
        staticBuildRoot: buildRoot,
        staticPublishRoot: webRoot,
      });
    } catch {
      throw new StaticRollbackRouterError(
        'static_rollback_identity_invalid',
        'Static rollback Application identity is invalid',
      );
    }
  }

  async function verifyIdentity(applicationId) {
    const identity = identityFor(applicationId);
    try {
      await canonicalManager.inspectIdentity(identity);
      return Object.freeze({ mode: 'canonical', applicationId: identity.applicationId, unixUser: identity.unixUser });
    } catch (error) {
      if (!LEGACY_ELIGIBLE_WEBSITE_ERRORS.has(error?.code)) throw error;
      let legacy;
      try { legacy = await legacyInspector.inspectLegacyIdentity(identity.applicationId); }
      catch { throw error; }
      if (legacy?.eligible !== true) throw error;
      return Object.freeze({ mode: 'legacy', applicationId: identity.applicationId, unixUser: identity.unixUser });
    }
  }

  async function rollbackStatic(spec) {
    await verifyIdentity(spec?.applicationId);
    return resolvedRollbackManager.rollbackStatic(spec);
  }

  return Object.freeze({ rollbackStatic, verifyIdentity });
}

export const staticRollbackRouter = createStaticRollbackRouter();

export const staticRollbackRouterInternals = Object.freeze({
  legacyEligibleWebsiteErrors: Object.freeze([...LEGACY_ELIGIBLE_WEBSITE_ERRORS]),
});
