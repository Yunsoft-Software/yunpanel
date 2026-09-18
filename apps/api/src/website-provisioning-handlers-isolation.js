import { createServiceUmaskManager } from '@yunpanel/host-runtime/service-umask-manager';
import { createStaticPublishIsolationManager } from '@yunpanel/host-runtime/static-publish-isolation-manager';
import { createWebsiteProvisioningHandlers as createBaseWebsiteProvisioningHandlers } from './website-provisioning-handlers.js';
import { createWebsiteElFinderProvisioningHandler } from './website-elfinder-provisioning-handler.js';
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

function staticRuntimeHandler(baseRuntime, isolationManager) {
  const isolationIntent = (context) => Object.freeze({
    websiteId: context.intent?.websiteId,
    applicationId: context.intent?.applicationId,
  });
  return Object.freeze({
    async apply(context = {}) {
      const result = await baseRuntime.apply(context);
      if (!result?.satisfied) return result;
      const isolation = await isolationManager.apply(isolationIntent(context));
      if (!isolation?.satisfied || isolation.adapter !== 'static-publish-isolation') {
        umaskFailure('website_static_publish_isolation_unverified', 'Static Website publish isolation could not be verified');
      }
      return Object.freeze({
        ...result,
        publishIsolated: true,
        isolatedReleaseCount: isolation.releaseCount,
        isolatedCurrentRelease: isolation.currentRelease,
      });
    },
    async inspect(context = {}) {
      const result = await baseRuntime.inspect(context);
      if (!result?.satisfied) return result;
      const isolation = await isolationManager.inspect(isolationIntent(context));
      if (!isolation?.satisfied) {
        return Object.freeze({
          satisfied: false,
          reason: 'static_publish_isolation_not_ready',
          isolationReason: isolation?.reason ?? 'static_publish_isolation_unavailable',
        });
      }
      return Object.freeze({
        ...result,
        publishIsolated: true,
        isolatedReleaseCount: isolation.releaseCount,
        isolatedCurrentRelease: isolation.currentRelease,
      });
    },
    compensate: (context = {}) => baseRuntime.compensate(context),
    inspectCompensation: (context = {}) => baseRuntime.inspectCompensation(context),
  });
}

export function createWebsiteProvisioningHandlers(options = {}) {
  const base = createBaseWebsiteProvisioningHandlers(options);
  const umaskManager = options.serviceUmaskManager ?? createServiceUmaskManager();
  const staticPublishIsolationManager = options.staticPublishIsolationManager ?? createStaticPublishIsolationManager();
  return Object.freeze({
    ...base,
    elfinder: createWebsiteElFinderProvisioningHandler({
      ...(options.elFinderFpmSiteManager ? { fpmManager: options.elFinderFpmSiteManager } : {}),
      umaskManager,
    }),
    runtime: passengerRuntimeHandler(base.runtime, umaskManager),
    php_runtime: createWebsitePhpRuntimeProvisioningHandler({
      ...(options.phpSiteContainerManager ? { containerManager: options.phpSiteContainerManager } : {}),
      ...(options.phpFpmSiteManager ? { fpmManager: options.phpFpmSiteManager } : {}),
      umaskManager,
    }),
    static_runtime: staticRuntimeHandler(base.static_runtime, staticPublishIsolationManager),
    sftp: createWebsiteSftpProvisioningHandler({
      ...(options.sftpSiteManager ? { sftpManager: options.sftpSiteManager } : {}),
    }),
  });
}

export const websiteProvisioningIsolationInternals = Object.freeze({
  passengerRuntimeHandler,
  staticRuntimeHandler,
});
