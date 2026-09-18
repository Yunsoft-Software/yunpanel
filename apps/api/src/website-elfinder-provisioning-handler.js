import {
  createElFinderFpmSiteManager,
} from '@yunpanel/host-runtime';
import { createServiceUmaskManager } from '@yunpanel/host-runtime/service-umask-manager';

export class WebsiteElFinderProvisioningError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsiteElFinderProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function elFinderIntent(value) {
  const allowed = new Set(['adapter', 'websiteId', 'applicationId', 'unixUser']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.adapter !== 'elfinder-fpm'
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.websiteId !== 'string'
    || typeof value.applicationId !== 'string'
    || typeof value.unixUser !== 'string') {
    throw new WebsiteElFinderProvisioningError(
      'website_elfinder_intent_invalid',
      'Website elFinder provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    websiteId: value.websiteId,
    applicationId: value.applicationId,
    unixUser: value.unixUser,
  });
}

export function createWebsiteElFinderProvisioningHandler({
  fpmManager = createElFinderFpmSiteManager(),
  umaskManager = createServiceUmaskManager(),
} = {}) {
  if (!fpmManager || typeof fpmManager.apply !== 'function'
    || typeof fpmManager.inspect !== 'function'
    || typeof fpmManager.compensate !== 'function'
    || typeof fpmManager.inspectCompensation !== 'function'
    || !umaskManager || typeof umaskManager.apply !== 'function'
    || typeof umaskManager.inspect !== 'function') {
    throw new WebsiteElFinderProvisioningError(
      'website_elfinder_dependencies_invalid',
      'Website elFinder provisioning dependencies are invalid',
    );
  }

  async function apply({ intent, operationId } = {}) {
    const normalized = elFinderIntent(intent);
    const initial = await fpmManager.apply(normalized, { operationId });
    if (!initial?.satisfied || initial.adapter !== 'elfinder-fpm') {
      throw new WebsiteElFinderProvisioningError(
        'website_elfinder_fpm_unverified',
        'elFinder FPM provisioning did not return verified evidence',
      );
    }
    const umask = await umaskManager.apply('php');
    if (!umask?.satisfied || umask.umask !== '0027') {
      throw new WebsiteElFinderProvisioningError(
        'website_elfinder_umask_unverified',
        'elFinder PHP-FPM service UMask=0027 could not be verified',
      );
    }
    const verified = await fpmManager.inspect(normalized);
    if (!verified?.satisfied || verified.adapter !== 'elfinder-fpm') {
      throw new WebsiteElFinderProvisioningError(
        'website_elfinder_fpm_restart_unverified',
        'elFinder Website pool did not recover after PHP-FPM policy activation',
      );
    }
    return Object.freeze({ ...verified, runtimeUmask: umask.umask });
  }

  async function inspect({ intent } = {}) {
    const normalized = elFinderIntent(intent);
    const umask = await umaskManager.inspect('php');
    if (!umask?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'elfinder_fpm_umask_not_ready',
        umaskReason: umask?.reason ?? 'service_umask_unavailable',
      });
    }
    const fpm = await fpmManager.inspect(normalized);
    if (!fpm?.satisfied) return fpm;
    return Object.freeze({ ...fpm, runtimeUmask: umask.umask });
  }

  async function compensate({ intent, operationId } = {}) {
    return fpmManager.compensate(elFinderIntent(intent), { operationId });
  }

  async function inspectCompensation({ intent, operationId } = {}) {
    return fpmManager.inspectCompensation(elFinderIntent(intent), { operationId });
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteElFinderProvisioningInternals = Object.freeze({ elFinderIntent });
