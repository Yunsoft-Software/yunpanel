import {
  createNginxManager,
  createPassengerSiteManager,
  createWebsiteIdentityManager,
} from '@yunpanel/host-runtime';

export class WebsiteProvisioningHandlerError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsiteProvisioningHandlerError';
    this.code = code;
    this.status = status;
  }
}

function identityIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || typeof intent.unixUser !== 'string'
    || typeof intent.homeDirectory !== 'string') {
    throw new WebsiteProvisioningHandlerError(
      'website_identity_intent_invalid',
      'Website Unix identity provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    user: intent.unixUser,
    homeDirectory: intent.homeDirectory,
  });
}

function runtimeIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || !['passenger', 'static'].includes(intent.adapter)) {
    throw new WebsiteProvisioningHandlerError(
      'website_runtime_intent_invalid',
      'Website runtime provisioning intent is invalid',
      400,
    );
  }
  return intent;
}

function passengerRuntimeEvidence(operation) {
  const step = operation?.steps?.find((candidate) => candidate.id === 'runtime');
  const value = step?.state === 'succeeded' ? step.evidence : null;
  if (!value || value.satisfied !== true || value.adapter !== 'passenger'
    || typeof value.nodeBinary !== 'string'
    || typeof value.appRoot !== 'string'
    || typeof value.documentRoot !== 'string'
    || typeof value.startupFile !== 'string'
    || typeof value.unixUser !== 'string') {
    throw new WebsiteProvisioningHandlerError(
      'website_passenger_runtime_evidence_missing',
      'Passenger runtime evidence is required before Nginx activation',
      409,
    );
  }
  return value;
}

function nginxSpec({ operation, intent } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || typeof intent.primaryDomain !== 'string'
    || !Array.isArray(intent.aliases)
    || !['static', 'proxy', 'passenger'].includes(intent.targetType)) {
    throw new WebsiteProvisioningHandlerError(
      'website_nginx_intent_invalid',
      'Website Nginx provisioning intent is invalid',
      400,
    );
  }

  let target = intent.target;
  if (intent.targetType === 'passenger') {
    const runtime = passengerRuntimeEvidence(operation);
    target = Object.freeze({
      appRoot: runtime.appRoot,
      documentRoot: runtime.documentRoot,
      startupFile: runtime.startupFile,
      nodeBinary: runtime.nodeBinary,
      user: runtime.unixUser,
      group: runtime.unixUser,
      appEnv: intent.target?.appEnv ?? 'production',
    });
  }

  return Object.freeze({
    primaryDomain: intent.primaryDomain,
    aliases: Object.freeze([...intent.aliases]),
    targetType: intent.targetType,
    target,
    tls: null,
    canonicalRedirect: false,
    httpsRedirect: false,
  });
}

function nginxEvidence(stage) {
  return Object.freeze({
    satisfied: true,
    configName: stage.configName,
    checksum: stage.checksum,
    active: true,
  });
}

export function createWebsiteProvisioningHandlers({
  identityManager = createWebsiteIdentityManager(),
  passengerSiteManager = createPassengerSiteManager(),
  nginxManager = createNginxManager(),
} = {}) {
  if (!identityManager
    || typeof identityManager.apply !== 'function'
    || typeof identityManager.inspect !== 'function'
    || !passengerSiteManager
    || typeof passengerSiteManager.apply !== 'function'
    || typeof passengerSiteManager.inspect !== 'function'
    || !nginxManager
    || typeof nginxManager.stageDomain !== 'function'
    || typeof nginxManager.inspectStagedDomain !== 'function'
    || typeof nginxManager.inspectActiveDomain !== 'function'
    || typeof nginxManager.activateDomain !== 'function') {
    throw new WebsiteProvisioningHandlerError(
      'website_provisioning_handler_dependencies_invalid',
      'Website provisioning handler dependencies are invalid',
    );
  }

  async function applyRuntime({ intent } = {}) {
    const normalized = runtimeIntent(intent);
    if (normalized.adapter === 'static') {
      return Object.freeze({
        satisfied: false,
        reason: 'static_runtime_provisioning_pending',
        adapter: 'static',
        applicationId: normalized.applicationId ?? null,
      });
    }
    return passengerSiteManager.apply(normalized);
  }

  async function inspectRuntime({ intent } = {}) {
    const normalized = runtimeIntent(intent);
    if (normalized.adapter === 'static') {
      return Object.freeze({
        satisfied: false,
        reason: 'static_runtime_provisioning_pending',
        adapter: 'static',
        applicationId: normalized.applicationId ?? null,
      });
    }
    return passengerSiteManager.inspect(normalized);
  }

  async function applyNginx(context = {}) {
    const spec = nginxSpec(context);
    const stage = await nginxManager.stageDomain(spec);
    const active = await nginxManager.activateDomain({
      primaryDomain: spec.primaryDomain,
      checksum: stage.checksum,
    });
    if (!active?.active || active.checksum !== stage.checksum || active.configName !== stage.configName) {
      throw new WebsiteProvisioningHandlerError(
        'website_nginx_activation_unverified',
        'Website Nginx activation did not return matching evidence',
      );
    }
    return nginxEvidence(stage);
  }

  async function inspectNginx(context = {}) {
    const spec = nginxSpec(context);
    const staged = await nginxManager.inspectStagedDomain(spec);
    if (!staged?.satisfied || !staged.result?.checksum) {
      return Object.freeze({ satisfied: false, reason: 'website_nginx_stage_unavailable' });
    }
    const active = await nginxManager.inspectActiveDomain({
      primaryDomain: spec.primaryDomain,
      checksum: staged.result.checksum,
    });
    if (!active?.satisfied) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_nginx_not_active',
        checksum: staged.result.checksum,
      });
    }
    return nginxEvidence(staged.result);
  }

  return Object.freeze({
    unix_identity: Object.freeze({
      apply: ({ intent } = {}) => identityManager.apply(identityIntent(intent)),
      inspect: ({ intent } = {}) => identityManager.inspect(identityIntent(intent)),
    }),
    runtime: Object.freeze({
      apply: applyRuntime,
      inspect: inspectRuntime,
    }),
    nginx: Object.freeze({
      apply: applyNginx,
      inspect: inspectNginx,
    }),
  });
}

export const websiteProvisioningHandlerInternals = Object.freeze({
  identityIntent,
  runtimeIntent,
  passengerRuntimeEvidence,
  nginxSpec,
  nginxEvidence,
});
