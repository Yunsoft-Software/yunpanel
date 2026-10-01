import { createSite, previewSiteCreate } from './site-create-isolation-guard.js';
import { createHostingSiteCreateService } from './hosting-site-create-service.js';

/** Explicit internal composition using the same dependencies as mountSiteCreateRoutes.
 * No router, new login role or privileged worker is enabled by importing this module.
 * HTTP/job integration must use its own fresh Owner/MFA token/policy, never body roles.
 */
export function createHostingSiteCreateRuntime(dependencies = {}) {
  const previewFn = dependencies.previewSiteCreate
    ?? ((options) => previewSiteCreate(options));
  const createFn = dependencies.createSite
    ?? ((options) => createSite(options));

  return createHostingSiteCreateService({
    hostingAccounts: dependencies.userAdminStore?.hostingAccounts,
    websiteRegistry: dependencies.websiteRegistry,
    applicationRegistry: dependencies.applicationRegistry,
    domainRegistry: dependencies.domainRegistry,
    mailDomainRegistry: dependencies.mailDomainRegistry,
    websiteProvisioningRegistry: dependencies.websiteProvisioningRuntime?.registry
      ?? dependencies.websiteProvisioningRegistry,
    siteMutationLock: dependencies.siteMutationLock,
    localServerId: dependencies.localServerId,
    previewSiteCreate: (input) => {
      const arg = input && typeof input === 'object'
        ? Object.assign(Object.create(input), { input, ...dependencies })
        : { input, ...dependencies };
      return previewFn(arg);
    },
    createSite: (apply) => {
      const arg = apply && typeof apply === 'object'
        ? Object.assign(Object.create(apply), { ...dependencies, ...apply })
        : { ...dependencies, ...apply };
      return createFn(arg);
    },
  });
}
