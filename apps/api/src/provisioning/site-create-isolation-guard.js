import {
  createSite as createBaseSite,
  previewSiteCreate as previewBaseSiteCreate,
  SiteCreateError,
} from './site-create.js';

function assertIndependentWebsiteIsolation(input) {
  if (input?.wwwMode === 'independent') {
    throw new SiteCreateError(
      'site_create_independent_www_requires_website',
      'Independent www requires its own Website and Unix identity; use wwwMode alias until dedicated Website provisioning is selected',
      409,
    );
  }
  return input;
}

export function previewSiteCreate(options = {}) {
  assertIndependentWebsiteIsolation(options.input);
  return previewBaseSiteCreate(options);
}

export function createSite(options = {}) {
  assertIndependentWebsiteIsolation(options.input);
  return createBaseSite(options);
}

export { SiteCreateError };

export const siteCreateIsolationGuardInternals = Object.freeze({
  assertIndependentWebsiteIsolation,
});
