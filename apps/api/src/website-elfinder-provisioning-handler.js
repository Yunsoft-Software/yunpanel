import {
  createElFinderFpmSiteManager,
  createElFinderNginxGatewayManager,
  createManagedServiceManager,
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
  sharedApplicationManager = createManagedServiceManager(),
  gatewayManager = createElFinderNginxGatewayManager(),
  umaskManager = createServiceUmaskManager(),
} = {}) {
  if (!fpmManager || typeof fpmManager.apply !== 'function'
    || typeof fpmManager.inspect !== 'function'
    || typeof fpmManager.compensate !== 'function'
    || typeof fpmManager.inspectCompensation !== 'function'
    || !sharedApplicationManager || typeof sharedApplicationManager.install !== 'function'
    || typeof sharedApplicationManager.inspect !== 'function'
    || !gatewayManager || typeof gatewayManager.apply !== 'function'
    || typeof gatewayManager.inspect !== 'function'
    || !umaskManager || typeof umaskManager.apply !== 'function'
    || typeof umaskManager.inspect !== 'function') {
    throw new WebsiteElFinderProvisioningError(
      'website_elfinder_dependencies_invalid',
      'Website elFinder provisioning dependencies are invalid',
    );
  }

  async function apply({ intent, operationId } = {}) {
    const normalized = elFinderIntent(intent);
    const shared = await sharedApplicationManager.install('elfinder');
    if (!shared?.installed || shared.units?.length !== 0
      || shared.health?.configuration !== 'valid') {
      throw new WebsiteElFinderProvisioningError(
        'website_elfinder_shared_runtime_unverified',
        'elFinder shared application dependencies are not ready',
      );
    }
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
    const gateway = await gatewayManager.apply();
    if (!gateway?.satisfied || gateway.adapter !== 'elfinder-nginx-gateway') {
      throw new WebsiteElFinderProvisioningError(
        'website_elfinder_gateway_unverified',
        'elFinder private gateway did not return verified evidence',
      );
    }
    const verified = await fpmManager.inspect(normalized);
    if (!verified?.satisfied || verified.adapter !== 'elfinder-fpm') {
      throw new WebsiteElFinderProvisioningError(
        'website_elfinder_fpm_restart_unverified',
        'elFinder Website pool did not recover after shared runtime activation',
      );
    }
    return Object.freeze({
      ...verified,
      runtimeUmask: umask.umask,
      sharedApplicationReady: true,
      gatewaySocketPath: gateway.gatewaySocketPath,
      gatewayConfigSha256: gateway.configSha256,
    });
  }

  async function inspect({ intent } = {}) {
    const normalized = elFinderIntent(intent);
    const shared = await sharedApplicationManager.inspect('elfinder');
    if (!shared?.installed || shared.units?.length !== 0
      || shared.health?.configuration !== 'valid') {
      return Object.freeze({
        satisfied: false,
        reason: 'elfinder_shared_runtime_not_ready',
      });
    }
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
    const gateway = await gatewayManager.inspect();
    if (!gateway?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'elfinder_gateway_not_ready',
        gatewayReason: gateway?.reason ?? 'elfinder_gateway_unavailable',
      });
    }
    return Object.freeze({
      ...fpm,
      runtimeUmask: umask.umask,
      sharedApplicationReady: true,
      gatewaySocketPath: gateway.gatewaySocketPath,
      gatewayConfigSha256: gateway.configSha256,
    });
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
