import { createPhpFpmSiteManager } from '@yunpanel/host-runtime';
import { createPhpSiteContainerManager } from '@yunpanel/host-runtime/php-site-container-manager';
import { createServiceUmaskManager } from '@yunpanel/host-runtime/service-umask-manager';

export class WebsitePhpRuntimeProvisioningError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsitePhpRuntimeProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function runtimeIntent(value) {
  const allowed = new Set([
    'adapter',
    'websiteId',
    'applicationId',
    'unixUser',
    'documentRoot',
    'maxChildren',
    'memoryLimitMb',
    'maxExecutionSeconds',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.adapter !== 'php-fpm'
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.websiteId !== 'string'
    || typeof value.applicationId !== 'string'
    || typeof value.unixUser !== 'string'
    || typeof value.documentRoot !== 'string') {
    throw new WebsitePhpRuntimeProvisioningError(
      'website_php_runtime_intent_invalid',
      'Website PHP runtime provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    websiteId: value.websiteId,
    applicationId: value.applicationId,
    unixUser: value.unixUser,
    documentRoot: value.documentRoot,
    ...(value.maxChildren === undefined ? {} : { maxChildren: value.maxChildren }),
    ...(value.memoryLimitMb === undefined ? {} : { memoryLimitMb: value.memoryLimitMb }),
    ...(value.maxExecutionSeconds === undefined ? {} : { maxExecutionSeconds: value.maxExecutionSeconds }),
  });
}

function containerOperationId(operationId, releaseOperationId) {
  return releaseOperationId ?? operationId;
}

export function createWebsitePhpRuntimeProvisioningHandler({
  containerManager = createPhpSiteContainerManager(),
  fpmManager = createPhpFpmSiteManager(),
  umaskManager = createServiceUmaskManager(),
} = {}) {
  if (!containerManager || typeof containerManager.apply !== 'function' || typeof containerManager.inspect !== 'function'
    || !fpmManager || typeof fpmManager.apply !== 'function' || typeof fpmManager.inspect !== 'function'
    || typeof fpmManager.compensate !== 'function' || typeof fpmManager.inspectCompensation !== 'function'
    || !umaskManager || typeof umaskManager.apply !== 'function' || typeof umaskManager.inspect !== 'function') {
    throw new WebsitePhpRuntimeProvisioningError(
      'website_php_runtime_dependencies_invalid',
      'Website PHP runtime provisioning dependencies are invalid',
    );
  }

  async function apply({ intent, operationId } = {}) {
    const normalized = runtimeIntent(intent);
    const container = await containerManager.apply(normalized, { operationId });
    if (!container?.satisfied || container.adapter !== 'php-container') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_container_unverified',
        'PHP runtime container lockdown did not return verified evidence',
      );
    }
    const initialFpm = await fpmManager.apply(normalized, { operationId });
    if (!initialFpm?.satisfied || initialFpm.adapter !== 'php-fpm') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_fpm_unverified',
        'PHP-FPM provisioning did not return verified evidence',
      );
    }
    const umask = await umaskManager.apply('php');
    if (!umask?.satisfied || umask.umask !== '0027') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_umask_unverified',
        'PHP-FPM service UMask=0027 could not be verified',
      );
    }
    const fpm = await fpmManager.inspect(normalized);
    if (!fpm?.satisfied || fpm.adapter !== 'php-fpm') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_fpm_restart_unverified',
        'PHP-FPM Website pool did not recover after UMask policy activation',
      );
    }
    return Object.freeze({
      ...fpm,
      containerLocked: true,
      containerOwner: container.containerOwner,
      releaseUid: container.releaseUid,
      releaseGid: container.releaseGid,
      runtimeUmask: umask.umask,
    });
  }

  async function inspect({ intent, operationId } = {}) {
    const normalized = runtimeIntent(intent);
    const container = await containerManager.inspect(normalized, { operationId });
    if (!container?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'php_container_not_ready',
        containerReason: container?.reason ?? 'php_container_unavailable',
      });
    }
    const umask = await umaskManager.inspect('php');
    if (!umask?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'php_runtime_umask_not_ready',
        umaskReason: umask?.reason ?? 'service_umask_unavailable',
      });
    }
    const fpm = await fpmManager.inspect(normalized);
    if (!fpm?.satisfied) return fpm;
    return Object.freeze({
      ...fpm,
      containerLocked: true,
      containerOwner: container.containerOwner,
      releaseUid: container.releaseUid,
      releaseGid: container.releaseGid,
      runtimeUmask: umask.umask,
    });
  }

  async function previewMigration({ intent, operationId, releaseOperationId } = {}) {
    const normalized = runtimeIntent(intent);
    if (typeof containerManager.previewMigration !== 'function'
      || typeof fpmManager.previewMigration !== 'function') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_runtime_migration_preview_unavailable',
        'Website PHP runtime migration preview is unavailable',
        503,
      );
    }

    const [container, fpm, umask] = await Promise.all([
      containerManager.previewMigration(normalized, { operationId: containerOperationId(operationId, releaseOperationId) }),
      fpmManager.previewMigration(normalized, { operationId }),
      umaskManager.inspect('php'),
    ]);
    let fpmRuntime;
    try { fpmRuntime = await fpmManager.inspect(normalized); }
    catch (error) {
      fpmRuntime = Object.freeze({
        satisfied: false,
        reason: typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
          ? error.code
          : 'php_fpm_runtime_inspection_failed',
      });
    }
    const fpmRuntimeEvidence = fpmRuntime?.satisfied === true
      ? Object.freeze({ satisfied: true })
      : Object.freeze({
        satisfied: false,
        reason: typeof fpmRuntime?.reason === 'string' && /^[a-z0-9_]{1,120}$/.test(fpmRuntime.reason)
          ? fpmRuntime.reason
          : 'php_fpm_runtime_not_ready',
      });
    const umaskEvidence = umask?.satisfied === true && umask.umask === '0027'
      ? Object.freeze({ satisfied: true, umask: '0027' })
      : Object.freeze({
        satisfied: false,
        reason: typeof umask?.reason === 'string' && /^[a-z0-9_]{1,120}$/.test(umask.reason)
          ? umask.reason
          : 'service_umask_unavailable',
      });
    const differences = [
      ...(Array.isArray(container?.differences) ? container.differences : ['php_container_preview_invalid']),
      ...(Array.isArray(fpm?.differences) ? fpm.differences : ['php_fpm_preview_invalid']),
      ...(fpmRuntimeEvidence.satisfied ? [] : ['php_fpm_runtime_not_ready']),
      ...(umaskEvidence.satisfied ? [] : ['php_runtime_umask_not_ready']),
    ];

    const safeCreateCandidate = container?.satisfied === true
      && fpm?.safeCreateCandidate === true
      && umaskEvidence.satisfied === true;
    const safeContainerMigrationCandidate = container?.safeMigrationCandidate === true
      && fpmRuntimeEvidence.satisfied === true
      && umaskEvidence.satisfied === true;
    return Object.freeze({
      version: 1,
      adapter: 'php-runtime',
      satisfied: container?.satisfied === true && fpmRuntimeEvidence.satisfied === true && umaskEvidence.satisfied === true,
      safeCreateCandidate,
      safeContainerMigrationCandidate,
      current: Object.freeze({
        container,
        fpm,
        fpmRuntime: fpmRuntimeEvidence,
        umask: umaskEvidence,
      }),
      desired: Object.freeze({
        websiteId: normalized.websiteId,
        applicationId: normalized.applicationId,
        unixUser: normalized.unixUser,
        documentRoot: normalized.documentRoot,
        runtimeUmask: '0027',
      }),
      differences: Object.freeze([...new Set(differences)]),
    });
  }

  async function inspectContainerMigrationOperation(context = {}) {
    const normalized = runtimeIntent(context.intent);
    const releaseOperationId = containerOperationId(context.operationId, context.releaseOperationId);
    if (typeof containerManager.inspectMigrationOperation !== 'function') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_container_migration_lifecycle_unavailable',
        'Website PHP container migration lifecycle is unavailable',
        503,
      );
    }
    return containerManager.inspectMigrationOperation(normalized, {
      operationId: releaseOperationId,
      migrationOperationId: context.operationId,
    });
  }

  async function applyContainerMigration(context = {}) {
    const normalized = runtimeIntent(context.intent);
    const releaseOperationId = containerOperationId(context.operationId, context.releaseOperationId);
    if (typeof containerManager.applyMigration !== 'function') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_container_migration_lifecycle_unavailable',
        'Website PHP container migration lifecycle is unavailable',
        503,
      );
    }
    const preview = await previewMigration(context);
    if (preview.safeContainerMigrationCandidate !== true) {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_container_migration_not_safe',
        'Website PHP container migration requires exact control-plane metadata drift with healthy site FPM and shared UMask state',
        409,
      );
    }
    const migrated = await containerManager.applyMigration(normalized, {
      operationId: releaseOperationId,
      migrationOperationId: context.operationId,
    });
    if (!migrated?.satisfied || migrated.phpContainerReceiptVersion !== 1 || migrated.migratedPhpContainer !== true) {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_container_migration_unverified',
        'Website PHP container migration did not return durable ownership evidence',
        503,
      );
    }
    return inspectContainerMigrationOperation(context);
  }

  async function inspectContainerMigrationCompensation(context = {}) {
    const normalized = runtimeIntent(context.intent);
    const releaseOperationId = containerOperationId(context.operationId, context.releaseOperationId);
    if (typeof containerManager.inspectMigrationCompensation !== 'function') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_container_migration_lifecycle_unavailable',
        'Website PHP container migration lifecycle is unavailable',
        503,
      );
    }
    return containerManager.inspectMigrationCompensation(normalized, {
      operationId: releaseOperationId,
      migrationOperationId: context.operationId,
    });
  }

  async function compensateContainerMigration(context = {}) {
    const normalized = runtimeIntent(context.intent);
    const releaseOperationId = containerOperationId(context.operationId, context.releaseOperationId);
    if (typeof containerManager.compensateMigration !== 'function') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_container_migration_lifecycle_unavailable',
        'Website PHP container migration lifecycle is unavailable',
        503,
      );
    }
    return containerManager.compensateMigration(normalized, {
      operationId: releaseOperationId,
      migrationOperationId: context.operationId,
    });
  }

  async function inspectMigrationOperation(context = {}) {
    const normalized = runtimeIntent(context.intent);
    const releaseOperationId = containerOperationId(context.operationId, context.releaseOperationId);
    if (typeof fpmManager.inspectMigrationOperation !== 'function') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_runtime_migration_lifecycle_unavailable',
        'Website PHP runtime migration lifecycle is unavailable',
        503,
      );
    }
    const [container, umask, fpm] = await Promise.all([
      containerManager.inspect(normalized, { operationId: releaseOperationId }),
      umaskManager.inspect('php'),
      fpmManager.inspectMigrationOperation(normalized, { operationId: context.operationId }),
    ]);
    if (!container?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'php_container_not_ready',
        containerReason: container?.reason ?? 'php_container_unavailable',
      });
    }
    if (!umask?.satisfied || umask.umask !== '0027') {
      return Object.freeze({
        satisfied: false,
        reason: 'php_runtime_umask_not_ready',
        umaskReason: umask?.reason ?? 'service_umask_unavailable',
      });
    }
    if (!fpm?.satisfied) return fpm;
    return Object.freeze({
      ...fpm,
      phpRuntimeMigration: true,
      containerLocked: true,
      runtimeUmask: '0027',
    });
  }

  async function applyMigration(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (typeof fpmManager.applyMigration !== 'function') {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_runtime_migration_lifecycle_unavailable',
        'Website PHP runtime migration lifecycle is unavailable',
        503,
      );
    }
    const preview = await previewMigration(context);
    if (preview.satisfied === true) return inspectMigrationOperation(context);
    if (preview.safeCreateCandidate !== true) {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_runtime_migration_not_safe_create',
        'Website PHP runtime migration requires canonical container and shared UMask state with only a missing site pool',
        409,
      );
    }
    const fpm = await fpmManager.applyMigration(normalized, { operationId: context.operationId });
    if (!fpm?.satisfied || fpm.phpFpmReceiptVersion !== 1 || fpm.createdPhpFpmPool !== true) {
      throw new WebsitePhpRuntimeProvisioningError(
        'website_php_runtime_migration_unverified',
        'Website PHP runtime migration did not return durable site-pool ownership evidence',
        503,
      );
    }
    return inspectMigrationOperation(context);
  }

  async function inspectMigrationCompensation({ intent, operationId } = {}) {
    return fpmManager.inspectCompensation(runtimeIntent(intent), { operationId });
  }

  async function compensateMigration({ intent, operationId } = {}) {
    return fpmManager.compensate(runtimeIntent(intent), { operationId });
  }

  async function compensate({ intent, operationId } = {}) {
    return fpmManager.compensate(runtimeIntent(intent), { operationId });
  }

  async function inspectCompensation({ intent, operationId } = {}) {
    return fpmManager.inspectCompensation(runtimeIntent(intent), { operationId });
  }

  return Object.freeze({
    apply,
    inspect,
    previewMigration,
    inspectContainerMigrationOperation,
    applyContainerMigration,
    inspectContainerMigrationCompensation,
    compensateContainerMigration,
    inspectMigrationOperation,
    applyMigration,
    compensateMigration,
    inspectMigrationCompensation,
    compensate,
    inspectCompensation,
  });
}

export const websitePhpRuntimeProvisioningInternals = Object.freeze({ runtimeIntent });
