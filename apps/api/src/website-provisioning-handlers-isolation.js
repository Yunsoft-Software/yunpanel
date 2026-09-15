import { createWebsiteProvisioningHandlers as createBaseWebsiteProvisioningHandlers } from './website-provisioning-handlers.js';
import { createWebsitePhpRuntimeProvisioningHandler } from './website-php-runtime-provisioning-handler.js';
import { createWebsiteSftpProvisioningHandler } from './website-sftp-provisioning-handler.js';

export function createWebsiteProvisioningHandlers(options = {}) {
  const base = createBaseWebsiteProvisioningHandlers(options);
  return Object.freeze({
    ...base,
    php_runtime: createWebsitePhpRuntimeProvisioningHandler({
      ...(options.phpSiteContainerManager ? { containerManager: options.phpSiteContainerManager } : {}),
      ...(options.phpFpmSiteManager ? { fpmManager: options.phpFpmSiteManager } : {}),
    }),
    sftp: createWebsiteSftpProvisioningHandler({
      ...(options.sftpSiteManager ? { sftpManager: options.sftpSiteManager } : {}),
    }),
  });
}
