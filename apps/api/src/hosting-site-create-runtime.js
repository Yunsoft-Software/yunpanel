import { createSite, previewSiteCreate } from './site-create-isolation-guard.js';
import { createHostingSiteCreateService } from './hosting-site-create-service.js';

/** Explicit internal composition using the same dependencies as mountSiteCreateRoutes.
 * No router, new login role or privileged worker is enabled by importing this module.
 * HTTP/job integration must use its own fresh Owner/MFA token/policy, never body roles.
 */
export function createHostingSiteCreateRuntime(dependencies = {}) {
  return createHostingSiteCreateService({
    hostingAccounts: dependencies.userAdminStore?.hostingAccounts,
    websiteRegistry: dependencies.websiteRegistry,
    applicationRegistry: dependencies.applicationRegistry,
    domainRegistry: dependencies.domainRegistry,
    mailDomainRegistry: dependencies.mailDomainRegistry,
    siteMutationLock: dependencies.siteMutationLock,
    localServerId: dependencies.localServerId,
    previewSiteCreate: (input) => previewSiteCreate({ ...dependencies, input }),
    createSite: (apply) => createSite({ ...dependencies, ...apply }),
  });
}
