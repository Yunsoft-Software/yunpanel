import {
  createSite as createBaseSite,
  previewSiteCreate as previewBaseSiteCreate,
  SiteCreateError,
  siteCreateInternals as baseSiteCreateInternals,
} from './site-create-base.js';

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

export async function previewSiteCreate(options = {}) {
  assertIndependentWebsiteIsolation(options.input);
  return previewBaseSiteCreate(options);
}

export async function createSite(options = {}) {
  assertIndependentWebsiteIsolation(options.input);
  return createBaseSite(options);
}

export { SiteCreateError };

export const siteCreateInternals = Object.freeze({
  ...baseSiteCreateInternals,
  normalizeInput(input) {
    assertIndependentWebsiteIsolation(input);
    return baseSiteCreateInternals.normalizeInput(input);
  },
  assertIndependentWebsiteIsolation,
});
