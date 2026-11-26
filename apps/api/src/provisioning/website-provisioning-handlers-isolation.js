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
      const [runtime, isolation, releasePermissions] = await Promise.all([
        baseRuntime.inspect(context),
        isolationManager.previewMigration(isolationIntent(context)),
        typeof isolationManager.previewReleaseMigration === 'function'
          ? isolationManager.previewReleaseMigration(isolationIntent(context))
          : Promise.resolve(null),
      ]);
      const reason = runtime?.satisfied === true ? null : runtime?.reason ?? 'static_runtime_unavailable';
      const safeControlMigrationCandidate = runtime?.satisfied === true
        && isolation?.safeMigrationCandidate === true;
      const releaseRepairCandidate = runtime?.satisfied === true
        && releasePermissions?.repairCandidate === true;
      return Object.freeze({
        version: 1,
        adapter: 'static-runtime',
        satisfied: runtime?.satisfied === true && isolation?.satisfied === true,
        safeControlMigrationCandidate,
        releaseRepairCandidate,
        automaticMigration: false,
        migrationBlockedReason: releaseRepairCandidate
          ? 'static_release_explicit_migration_required'
          : 'static_legacy_permissions_not_operation_owned',
        current: Object.freeze({
          runtime,
          isolation,
          releasePermissions,
        }),
        desired: Object.freeze({
          websiteId: context.intent?.websiteId ?? null,
          applicationId: context.intent?.applicationId ?? null,
          mode: context.intent?.mode ?? 'legacy_unresolved',
          deploymentId: context.intent?.deploymentId ?? null,
        }),
        differences: Object.freeze([...new Set([
          ...(reason ? [reason] : []),
          ...(Array.isArray(isolation?.differences) ? isolation.differences : ['static_publish_preview_invalid']),
          ...(releasePermissions && Array.isArray(releasePermissions.differences)
            ? releasePermissions.differences
            : []),
        ])]),
      });
    },
    async inspectReleaseMigrationOperation(context = {}) {
      if (typeof isolationManager.inspectReleaseMigrationOperation !== 'function') {
        umaskFailure('website_static_release_migration_lifecycle_unavailable', 'Static release migration lifecycle is unavailable');
      }
      const result = await isolationManager.inspectReleaseMigrationOperation(
        isolationIntent(context),
        { operationId: context.operationId },
      );
      if (!result?.satisfied) return result;
      if (typeof context.expectedTreeSha256 === 'string'
        && result.treeSha256 !== context.expectedTreeSha256) {
        umaskFailure(
          'website_static_release_migration_evidence_mismatch',
          'Static release migration receipt does not match the expected release tree digest',
        );
      }
      return Object.freeze({ ...result, staticRuntimeMigration: true });
    },
    async applyReleaseMigration(context = {}) {
      if (typeof isolationManager.previewReleaseMigration !== 'function'
        || typeof isolationManager.applyReleaseMigration !== 'function') {
        umaskFailure('website_static_release_migration_lifecycle_unavailable', 'Static release migration lifecycle is unavailable');
      }
      const preview = await isolationManager.previewReleaseMigration(isolationIntent(context));
      if (typeof context.expectedTreeSha256 === 'string'
        && preview.current?.tree?.sha256 !== context.expectedTreeSha256) {
        umaskFailure(
          'website_static_release_migration_preview_stale',
          'Static release tree changed after the migration preview was journaled',
        );
      }
      if (preview.repairCandidate !== true) {
        umaskFailure(
          'website_static_release_migration_not_safe',
          'Static release migration requires exact managed ownership, mode or ACL drift with a stable current target',
        );
      }
      const result = await isolationManager.applyReleaseMigration(
        isolationIntent(context),
        { operationId: context.operationId },
      );
      if (!result?.satisfied
        || result.staticReleaseReceiptVersion !== 1
        || result.migratedStaticReleasePermissions !== true
        || typeof result.treeSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(result.treeSha256)
        || (typeof context.expectedTreeSha256 === 'string'
          && result.treeSha256 !== context.expectedTreeSha256)) {
        umaskFailure(
          'website_static_release_migration_unverified',
          'Static release migration did not return durable ownership evidence',
        );
      }
      return this.inspectReleaseMigrationOperation(context);
    },
    async inspectReleaseMigrationCompensation(context = {}) {
      if (typeof isolationManager.inspectReleaseMigrationCompensation !== 'function') {
        umaskFailure('website_static_release_migration_lifecycle_unavailable', 'Static release migration lifecycle is unavailable');
      }
      const inspected = await isolationManager.inspectReleaseMigrationCompensation(
        isolationIntent(context),
        { operationId: context.operationId },
      );
      if (inspected?.satisfied === true
        && typeof context.expectedTreeSha256 === 'string'
        && inspected.treeSha256 !== context.expectedTreeSha256) {
        umaskFailure(
          'website_static_release_migration_evidence_mismatch',
          'Static release rollback receipt does not match the expected release tree digest',
        );
      }
      if (inspected?.satisfied === true && inspected.receiptState !== 'compensated') {
        return Object.freeze({
          satisfied: false,
          reason: 'static_publish_release_migration_compensation_receipt_pending',
        });
      }
      return inspected;
    },
    async compensateReleaseMigration(context = {}) {
      if (typeof isolationManager.compensateReleaseMigration !== 'function') {
        umaskFailure('website_static_release_migration_lifecycle_unavailable', 'Static release migration lifecycle is unavailable');
      }
      const result = await isolationManager.compensateReleaseMigration(
        isolationIntent(context),
        { operationId: context.operationId },
      );
      if (!result?.satisfied
        || result.restoredStaticReleasePermissions !== true
        || (typeof context.expectedTreeSha256 === 'string'
          && result.treeSha256 !== context.expectedTreeSha256)) {
        umaskFailure(
          'website_static_release_migration_compensation_unverified',
          'Static release rollback did not return exact receipt ownership evidence',
        );
      }
      return result;
    },

    async inspectControlMigrationOperation(context = {}) {
      if (typeof isolationManager.inspectMigrationOperation !== 'function') {
        umaskFailure('website_static_control_migration_lifecycle_unavailable', 'Static control migration lifecycle is unavailable');
      }
      const isolation = await isolationManager.inspectMigrationOperation(
        isolationIntent(context),
        { operationId: context.operationId },
      );
      if (!isolation?.satisfied) return isolation;
      return Object.freeze({
        ...isolation,
        staticRuntimeMigration: true,
      });
    },
    async applyControlMigration(context = {}) {
      if (typeof isolationManager.applyMigration !== 'function'
        || typeof isolationManager.previewMigration !== 'function') {
        umaskFailure('website_static_control_migration_lifecycle_unavailable', 'Static control migration lifecycle is unavailable');
      }
      const preview = await isolationManager.previewMigration(isolationIntent(context));
      if (preview.safeMigrationCandidate !== true) {
        umaskFailure(
          'website_static_control_migration_not_safe',
          'Static control migration requires healthy release content and ACL state with only control-plane metadata drift',
        );
      }
      const isolation = await isolationManager.applyMigration(
        isolationIntent(context),
        { operationId: context.operationId },
      );
      if (!isolation?.satisfied
        || isolation.staticControlReceiptVersion !== 1
        || isolation.migratedStaticControlMetadata !== true) {
        umaskFailure('website_static_control_migration_unverified', 'Static control migration did not return durable ownership evidence');
      }
      return this.inspectControlMigrationOperation(context);
    },
    async inspectControlMigrationCompensation(context = {}) {
      if (typeof isolationManager.inspectMigrationCompensation !== 'function') {
        umaskFailure('website_static_control_migration_lifecycle_unavailable', 'Static control migration lifecycle is unavailable');
      }
      const inspected = await isolationManager.inspectMigrationCompensation(
        isolationIntent(context),
        { operationId: context.operationId },
      );
      if (inspected?.satisfied === true && inspected.receiptState !== 'compensated') {
        return Object.freeze({
          satisfied: false,
          reason: 'static_publish_migration_compensation_receipt_pending',
        });
      }
      return inspected;
    },
    async compensateControlMigration(context = {}) {
      if (typeof isolationManager.compensateMigration !== 'function') {
        umaskFailure('website_static_control_migration_lifecycle_unavailable', 'Static control migration lifecycle is unavailable');
      }
      return isolationManager.compensateMigration(
        isolationIntent(context),
        { operationId: context.operationId },
      );
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
