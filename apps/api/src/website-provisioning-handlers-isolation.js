import { createServiceUmaskManager } from '@yunpanel/host-runtime/service-umask-manager';
import { createWebsiteProvisioningHandlers as createBaseWebsiteProvisioningHandlers } from './website-provisioning-handlers.js';
import { createWebsitePhpRuntimeProvisioningHandler } from './website-php-runtime-provisioning-handler.js';
import { createWebsiteSftpProvisioningHandler } from './website-sftp-provisioning-handler.js';

function umaskFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function passengerRuntimeHandler(baseRuntime, umaskManager) {
  return Object.freeze({
    async apply(context = {}) {
      const result = await baseRuntime.apply(context);
      if (!result?.satisfied) return result;
      const policy = await umaskManager.apply('passenger');
      if (!policy?.satisfied || policy.umask !== '0027') {
        umaskFailure('website_passenger_umask_unverified', 'Passenger service UMask=0027 could not be verified');
      }
      return Object.freeze({ ...result, runtimeUmask: policy.umask });
    },
    async inspect(context = {}) {
      const result = await baseRuntime.inspect(context);
      if (!result?.satisfied) return result;
      const policy = await umaskManager.inspect('passenger');
      if (!policy?.satisfied) {
        return Object.freeze({
          satisfied: false,
          reason: 'passenger_runtime_umask_not_ready',
          umaskReason: policy?.reason ?? 'service_umask_unavailable',
        });
      }
      return Object.freeze({ ...result, runtimeUmask: policy.umask });
    },
  });
}

export function createWebsiteProvisioningHandlers(options = {}) {
  const base = createBaseWebsiteProvisioningHandlers(options);
  const umaskManager = options.serviceUmaskManager ?? createServiceUmaskManager();
  return Object.freeze({
    ...base,
    runtime: passengerRuntimeHandler(base.runtime, umaskManager),
    php_runtime: createWebsitePhpRuntimeProvisioningHandler({
      ...(options.phpSiteContainerManager ? { containerManager: options.phpSiteContainerManager } : {}),
      ...(options.phpFpmSiteManager ? { fpmManager: options.phpFpmSiteManager } : {}),
      umaskManager,
    }),
    sftp: createWebsiteSftpProvisioningHandler({
      ...(options.sftpSiteManager ? { sftpManager: options.sftpSiteManager } : {}),
    }),
  });
}

export const websiteProvisioningIsolationInternals = Object.freeze({ passengerRuntimeHandler });
