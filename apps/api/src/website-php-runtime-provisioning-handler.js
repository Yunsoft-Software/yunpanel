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

  async function compensate({ intent, operationId } = {}) {
    return fpmManager.compensate(runtimeIntent(intent), { operationId });
  }

  async function inspectCompensation({ intent, operationId } = {}) {
    return fpmManager.inspectCompensation(runtimeIntent(intent), { operationId });
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websitePhpRuntimeProvisioningInternals = Object.freeze({ runtimeIntent });
