import {
  createNginxManager,
  createPassengerSiteManager,
  createWebsiteIdentityPathManager,
} from '@yunpanel/host-runtime';
import { createWebsiteStaticDeploymentManager } from '@yunpanel/host-runtime/website-static-deployment-manager';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

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
  if (intent.applicationId !== undefined
    && (typeof intent.applicationId !== 'string' || typeof intent.websiteId !== 'string')) {
    throw new WebsiteProvisioningHandlerError(
      'website_identity_intent_invalid',
      'Website path-bound Unix identity provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    user: intent.unixUser,
    homeDirectory: intent.homeDirectory,
    ...(typeof intent.applicationId === 'string' ? {
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
    } : {}),
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
  if (intent.adapter === 'static' && intent.mode !== undefined
    && !['deploy', 'bind_existing'].includes(intent.mode)) {
    throw new WebsiteProvisioningHandlerError(
      'website_static_runtime_intent_invalid',
      'Website static runtime provisioning mode is invalid',
      400,
    );
  }
  return intent;
}

function staticDeploymentSpec({ intent, operationId, websiteId } = {}) {
  const normalized = runtimeIntent(intent);
  if (normalized.adapter !== 'static' || normalized.mode !== 'deploy'
    || normalized.websiteId !== websiteId
    || normalized.deploymentId !== operationId
    || typeof normalized.applicationId !== 'string'
    || typeof normalized.repositoryUrl !== 'string'
    || typeof normalized.branch !== 'string'
    || !normalized.build || typeof normalized.build !== 'object' || Array.isArray(normalized.build)
    || !Number.isInteger(normalized.retention)) {
    throw new WebsiteProvisioningHandlerError(
      'website_static_runtime_intent_invalid',
      'Website static deployment intent does not match the durable operation',
      400,
    );
  }
  return Object.freeze({
    applicationId: normalized.applicationId,
    deploymentId: normalized.deploymentId,
    repositoryUrl: normalized.repositoryUrl,
    branch: normalized.branch,
    build: normalized.build,
    retention: normalized.retention,
  });
}

function staticBindingIdentity({ intent, websiteId } = {}) {
  const normalized = runtimeIntent(intent);
  if (normalized.adapter !== 'static' || normalized.mode !== 'bind_existing'
    || normalized.websiteId !== websiteId
    || typeof normalized.applicationId !== 'string') {
    throw new WebsiteProvisioningHandlerError(
      'website_static_runtime_intent_invalid',
      'Website static binding intent does not match the durable operation',
      400,
    );
  }
  return Object.freeze({ applicationId: normalized.applicationId });
}

function legacyStaticPending(intent) {
  return Object.freeze({
    satisfied: false,
    reason: 'static_runtime_provisioning_pending',
    adapter: 'static',
    applicationId: intent.applicationId ?? null,
  });
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

function certificatePending(intent) {
  return Object.freeze({
    satisfied: false,
    reason: 'certificate_provisioning_pending',
    primaryDomain: typeof intent?.primaryDomain === 'string' ? intent.primaryDomain : null,
  });
}

export function createWebsiteProvisioningHandlers({
  identityManager = createWebsiteIdentityPathManager(),
  passengerSiteManager = createPassengerSiteManager(),
  staticDeploymentManager = createWebsiteStaticDeploymentManager(),
  nginxManager = createNginxManager(),
} = {}) {
  if (!identityManager
    || typeof identityManager.apply !== 'function'
    || typeof identityManager.inspect !== 'function'
    || typeof identityManager.compensate !== 'function'
    || typeof identityManager.inspectCompensation !== 'function'
    || !passengerSiteManager
    || typeof passengerSiteManager.apply !== 'function'
    || typeof passengerSiteManager.inspect !== 'function'
    || !staticDeploymentManager
    || typeof staticDeploymentManager.deployStatic !== 'function'
    || typeof staticDeploymentManager.inspectCurrent !== 'function'
    || typeof staticDeploymentManager.inspectDeployment !== 'function'
    || !nginxManager
    || typeof nginxManager.stageDomain !== 'function'
    || typeof nginxManager.inspectStagedDomain !== 'function'
    || typeof nginxManager.inspectActiveDomain !== 'function'
    || typeof nginxManager.activateDomain !== 'function'
    || typeof nginxManager.compensateDomain !== 'function'
    || typeof nginxManager.inspectDomainCompensation !== 'function') {
    throw new WebsiteProvisioningHandlerError(
      'website_provisioning_handler_dependencies_invalid',
      'Website provisioning handler dependencies are invalid',
    );
  }

  async function applyIdentity({ intent, operationId } = {}) {
    return identityManager.apply(identityIntent(intent), { operationId });
  }

  async function inspectIdentity({ intent } = {}) {
    return identityManager.inspect(identityIntent(intent));
  }

  async function compensateIdentity({ intent, operationId, evidence } = {}) {
    return identityManager.compensate(identityIntent(intent), { operationId, evidence });
  }

  async function inspectIdentityCompensation({ intent, operationId, evidence } = {}) {
    return identityManager.inspectCompensation(identityIntent(intent), { operationId, evidence });
  }

  async function applyStaticRuntime(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.mode === undefined) return legacyStaticPending(normalized);
    if (normalized.mode === 'bind_existing') {
      return staticDeploymentManager.inspectCurrent(staticBindingIdentity(context));
    }

    const spec = staticDeploymentSpec(context);
    const existing = await staticDeploymentManager.inspectDeployment(spec);
    if (existing?.satisfied === true) return existing;

    const result = await staticDeploymentManager.deployStatic(spec);
    const inspected = await staticDeploymentManager.inspectDeployment(spec);
    if (!inspected || inspected.satisfied !== true) {
      throw new WebsiteProvisioningHandlerError(
        'website_static_deployment_unverified',
        'Website static deployment did not activate the deterministic release',
      );
    }
    return Object.freeze({
      ...inspected,
      commitSha: typeof result?.commitSha === 'string' ? result.commitSha : null,
      previousReleaseId: result?.previousReleaseId ?? null,
      artifactFiles: Number.isInteger(result?.artifactFiles) ? result.artifactFiles : null,
      artifactBytes: Number.isFinite(result?.artifactBytes) ? result.artifactBytes : null,
    });
  }

  async function inspectStaticRuntime(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.mode === undefined) return legacyStaticPending(normalized);
    if (normalized.mode === 'bind_existing') {
      return staticDeploymentManager.inspectCurrent(staticBindingIdentity(context));
    }
    return staticDeploymentManager.inspectDeployment(staticDeploymentSpec(context));
  }

  async function applyRuntime(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.adapter === 'static') return applyStaticRuntime(context);
    return passengerSiteManager.apply(normalized);
  }

  async function inspectRuntime(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.adapter === 'static') return inspectStaticRuntime(context);
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

  async function nginxCompensationTarget(context = {}) {
    const spec = nginxSpec(context);
    const persistedChecksum = context.evidence?.checksum;
    if (typeof persistedChecksum === 'string' && CHECKSUM_PATTERN.test(persistedChecksum)) {
      return Object.freeze({ primaryDomain: spec.primaryDomain, checksum: persistedChecksum });
    }
    const staged = await nginxManager.inspectStagedDomain(spec);
    if (!staged?.satisfied || typeof staged.result?.checksum !== 'string'
      || !CHECKSUM_PATTERN.test(staged.result.checksum)) {
      return null;
    }
    return Object.freeze({ primaryDomain: spec.primaryDomain, checksum: staged.result.checksum });
  }

  async function compensateNginx(context = {}) {
    const target = await nginxCompensationTarget(context);
    if (!target) {
      return Object.freeze({ satisfied: false, reason: 'website_nginx_compensation_stage_unavailable' });
    }
    return nginxManager.compensateDomain(target);
  }

  async function inspectNginxCompensation(context = {}) {
    const target = await nginxCompensationTarget(context);
    if (!target) {
      return Object.freeze({ satisfied: false, reason: 'website_nginx_compensation_stage_unavailable' });
    }
    return nginxManager.inspectDomainCompensation(target);
  }

  return Object.freeze({
    unix_identity: Object.freeze({
      apply: applyIdentity,
      inspect: inspectIdentity,
      compensate: compensateIdentity,
      inspectCompensation: inspectIdentityCompensation,
    }),
    runtime: Object.freeze({
      apply: applyRuntime,
      inspect: inspectRuntime,
    }),
    nginx: Object.freeze({
      apply: applyNginx,
      inspect: inspectNginx,
      compensate: compensateNginx,
      inspectCompensation: inspectNginxCompensation,
    }),
    certificate: Object.freeze({
      apply: ({ intent } = {}) => certificatePending(intent),
      inspect: ({ intent } = {}) => certificatePending(intent),
    }),
  });
}

export const websiteProvisioningHandlerInternals = Object.freeze({
  identityIntent,
  runtimeIntent,
  staticDeploymentSpec,
  staticBindingIdentity,
  legacyStaticPending,
  passengerRuntimeEvidence,
  nginxSpec,
  nginxEvidence,
  certificatePending,
});
