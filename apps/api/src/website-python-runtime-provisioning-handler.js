import { createPythonSiteManager } from '@yunpanel/host-runtime';

export class WebsitePythonRuntimeProvisioningError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsitePythonRuntimeProvisioningError';
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
    'runtime',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.adapter !== 'python-runtime'
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.websiteId !== 'string'
    || typeof value.applicationId !== 'string'
    || typeof value.unixUser !== 'string'
    || !value.runtime || typeof value.runtime !== 'object' || Array.isArray(value.runtime)) {
    throw new WebsitePythonRuntimeProvisioningError(
      'website_python_runtime_intent_invalid',
      'Website Python runtime provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    websiteId: value.websiteId,
    applicationId: value.applicationId,
    unixUser: value.unixUser,
    runtime: value.runtime,
  });
}

export function createWebsitePythonRuntimeProvisioningHandler({
  pythonSiteManager = createPythonSiteManager(),
} = {}) {
  if (!pythonSiteManager
    || typeof pythonSiteManager.apply !== 'function'
    || typeof pythonSiteManager.inspect !== 'function'
    || typeof pythonSiteManager.compensate !== 'function') {
    throw new WebsitePythonRuntimeProvisioningError(
      'website_python_runtime_dependencies_invalid',
      'Website Python runtime provisioning dependencies are invalid',
    );
  }

  async function apply({ intent, operationId } = {}) {
    const normalized = runtimeIntent(intent);
    const result = await pythonSiteManager.apply({
      operationId,
      websiteId: normalized.websiteId,
      applicationId: normalized.applicationId,
      unixUser: normalized.unixUser,
      runtime: normalized.runtime,
    });
    return Object.freeze({
      satisfied: true,
      adapter: 'python-runtime',
      applicationId: normalized.applicationId,
      websiteId: normalized.websiteId,
      serviceName: result.serviceName,
      socketPath: result.socketPath,
      port: result.port,
      active: result.active,
      activeState: result.activeState,
      pid: result.pid,
    });
  }

  async function inspect({ intent } = {}) {
    const normalized = runtimeIntent(intent);
    const inspected = await pythonSiteManager.inspect({
      applicationId: normalized.applicationId,
    });
    if (!inspected.active) {
      return Object.freeze({
        satisfied: false,
        reason: 'python_service_not_active',
        activeState: inspected.activeState,
        loadState: inspected.loadState,
      });
    }
    return Object.freeze({
      satisfied: true,
      adapter: 'python-runtime',
      applicationId: normalized.applicationId,
      websiteId: normalized.websiteId,
      serviceName: inspected.serviceName,
      socketPath: inspected.socketPath,
      active: inspected.active,
      activeState: inspected.activeState,
      pid: inspected.mainPid,
    });
  }

  async function compensate({ intent, operationId } = {}) {
    const normalized = runtimeIntent(intent);
    return pythonSiteManager.compensate({
      operationId,
      applicationId: normalized.applicationId,
    });
  }

  async function inspectCompensation({ intent } = {}) {
    const normalized = runtimeIntent(intent);
    const inspected = await pythonSiteManager.inspect({
      applicationId: normalized.applicationId,
    });
    if (!inspected.active) {
      return Object.freeze({ satisfied: true, compensated: true });
    }
    return Object.freeze({ satisfied: false, reason: 'python_service_still_active' });
  }

  return Object.freeze({
    apply,
    inspect,
    compensate,
    inspectCompensation,
  });
}

export const websitePythonRuntimeProvisioningInternals = Object.freeze({ runtimeIntent });
