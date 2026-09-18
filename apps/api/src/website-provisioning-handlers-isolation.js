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
    async previewMigration(context = {}) {
      if (typeof baseRuntime.previewMigration !== 'function') {
        umaskFailure('website_passenger_migration_preview_unavailable', 'Passenger migration preview is unavailable');
      }
      const [runtime, policy] = await Promise.all([
        baseRuntime.previewMigration(context),
        umaskManager.inspect('passenger'),
      ]);
      const umask = policy?.satisfied === true && policy.umask === '0027'
        ? Object.freeze({ satisfied: true, umask: '0027' })
        : Object.freeze({
          satisfied: false,
          reason: policy?.reason ?? 'service_umask_unavailable',
        });
      return Object.freeze({
        ...runtime,
        runtimeUmask: umask,
        satisfied: runtime?.satisfied === true && umask.satisfied === true,
        differences: Object.freeze([
          ...(Array.isArray(runtime?.differences) ? runtime.differences : ['passenger_runtime_preview_invalid']),
          ...(umask.satisfied ? [] : ['passenger_runtime_umask_not_ready']),
        ]),
      });
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
    async previewMigration(context = {}) {
      if (typeof isolationManager.previewMigration !== 'function') {
        umaskFailure('website_static_migration_preview_unavailable', 'Static publish migration preview is unavailable');
      }
      const [runtime, isolation] = await Promise.all([
        baseRuntime.inspect(context),
        isolationManager.previewMigration(isolationIntent(context)),
      ]);
      const reason = runtime?.satisfied === true ? null : runtime?.reason ?? 'static_runtime_unavailable';
      return Object.freeze({
        version: 1,
        adapter: 'static-runtime',
        satisfied: runtime?.satisfied === true && isolation?.satisfied === true,
        current: Object.freeze({
          runtime,
          isolation,
        }),
        desired: Object.freeze({
          websiteId: context.intent?.websiteId ?? null,
          applicationId: context.intent?.applicationId ?? null,
          mode: context.intent?.mode ?? 'legacy_unresolved',
          deploymentId: context.intent?.deploymentId ?? null,
        }),
        differences: Object.freeze([
          ...(reason ? [reason] : []),
          ...(Array.isArray(isolation?.differences) ? isolation.differences : ['static_publish_preview_invalid']),
        ]),
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
      ...(options.elFinderSharedApplicationManager
        ? { sharedApplicationManager: options.elFinderSharedApplicationManager } : {}),
      ...(options.elFinderGatewayManager ? { gatewayManager: options.elFinderGatewayManager } : {}),
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
