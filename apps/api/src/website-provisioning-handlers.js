import {
  createNginxManager,
  createPassengerSiteManager,
  createPhpFpmSiteManager,
  createWebsiteIdentityPathManager,
} from '@yunpanel/host-runtime';
import { createPhpSiteBootstrapManager } from '@yunpanel/host-runtime/php-site-bootstrap-manager';
import { createWebsiteStaticDeploymentManager } from '@yunpanel/host-runtime/website-static-deployment-manager';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const MAIL_DISCOVERY_SOCKET = '/run/yunpanel-mail-discovery/discovery.sock';

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

function phpBootstrapIntent(intent) {
  const allowed = new Set(['adapter', 'websiteId', 'applicationId', 'unixUser', 'documentRoot']);
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'php-bootstrap'
    || Object.keys(intent).some((key) => !allowed.has(key))
    || typeof intent.websiteId !== 'string'
    || typeof intent.applicationId !== 'string'
    || typeof intent.unixUser !== 'string'
    || typeof intent.documentRoot !== 'string') {
    throw new WebsiteProvisioningHandlerError(
      'website_php_bootstrap_intent_invalid',
      'Website PHP bootstrap provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    websiteId: intent.websiteId,
    applicationId: intent.applicationId,
    unixUser: intent.unixUser,
    documentRoot: intent.documentRoot,
  });
}

function phpRuntimeIntent(intent) {
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
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'php-fpm'
    || Object.keys(intent).some((key) => !allowed.has(key))
    || typeof intent.websiteId !== 'string'
    || typeof intent.applicationId !== 'string'
    || typeof intent.unixUser !== 'string'
    || typeof intent.documentRoot !== 'string') {
    throw new WebsiteProvisioningHandlerError(
      'website_php_runtime_intent_invalid',
      'Website PHP-FPM provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    websiteId: intent.websiteId,
    applicationId: intent.applicationId,
    unixUser: intent.unixUser,
    documentRoot: intent.documentRoot,
    ...(intent.maxChildren === undefined ? {} : { maxChildren: intent.maxChildren }),
    ...(intent.memoryLimitMb === undefined ? {} : { memoryLimitMb: intent.memoryLimitMb }),
    ...(intent.maxExecutionSeconds === undefined ? {} : { maxExecutionSeconds: intent.maxExecutionSeconds }),
  });
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

function staticCompensationTarget(context = {}) {
  const spec = staticDeploymentSpec(context);
  const previousReleaseId = context.evidence && Object.hasOwn(context.evidence, 'previousReleaseId')
    ? context.evidence.previousReleaseId
    : null;
  return Object.freeze({
    applicationId: spec.applicationId,
    deploymentId: spec.deploymentId,
    previousReleaseId,
  });
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

function phpRuntimeEvidence(operation) {
  const step = operation?.steps?.find((candidate) => candidate.id === 'php_runtime');
  const value = step?.state === 'succeeded' ? step.evidence : null;
  if (!value || value.satisfied !== true || value.adapter !== 'php-fpm'
    || typeof value.applicationId !== 'string'
    || typeof value.documentRoot !== 'string'
    || typeof value.socketPath !== 'string'
    || typeof value.unixUser !== 'string') {
    throw new WebsiteProvisioningHandlerError(
      'website_php_runtime_evidence_missing',
      'PHP-FPM runtime evidence is required before Nginx activation',
      409,
    );
  }
  return value;
}

function passengerEnvironmentEvidence(operation, applicationId) {
  const step = operation?.steps?.find((candidate) => candidate.id === 'passenger_environment');
  if (!step) return null;
  const value = step.state === 'succeeded' ? step.evidence : null;
  if (!value || value.satisfied !== true || value.adapter !== 'passenger-environment'
    || value.applicationId !== applicationId
    || !Number.isSafeInteger(value.environmentRevision) || value.environmentRevision < 0
    || typeof value.environmentInclude !== 'string'
    || typeof value.includeSha256 !== 'string' || !CHECKSUM_PATTERN.test(value.includeSha256)) {
    throw new WebsiteProvisioningHandlerError(
      'website_passenger_environment_evidence_missing',
      'Passenger environment evidence is required before Nginx activation',
      409,
    );
  }
  return value;
}

function nginxSpec({ operation, intent, tls = null, httpsRedirect = false, canonicalRedirect = false } = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || typeof intent.primaryDomain !== 'string'
    || !Array.isArray(intent.aliases)
    || (intent.acmeOnlyHostnames !== undefined
      && (!Array.isArray(intent.acmeOnlyHostnames)
        || intent.acmeOnlyHostnames.some((hostname) => typeof hostname !== 'string' || !hostname)))
    || (intent.mailDiscoverySocketPath !== undefined
      && intent.mailDiscoverySocketPath !== MAIL_DISCOVERY_SOCKET)
    || !['static', 'proxy', 'passenger', 'php'].includes(intent.targetType)) {
    throw new WebsiteProvisioningHandlerError(
      'website_nginx_intent_invalid',
      'Website Nginx provisioning intent is invalid',
      400,
    );
  }

  let target = intent.target;
  if (intent.targetType === 'passenger') {
    const runtime = passengerRuntimeEvidence(operation);
    const environment = passengerEnvironmentEvidence(operation, runtime.applicationId);
    target = Object.freeze({
      appRoot: runtime.appRoot,
      documentRoot: runtime.documentRoot,
      startupFile: runtime.startupFile,
      nodeBinary: runtime.nodeBinary,
      user: runtime.unixUser,
      group: runtime.unixUser,
      appEnv: intent.target?.appEnv ?? 'production',
      environmentInclude: environment?.environmentInclude ?? null,
    });
  } else if (intent.targetType === 'php') {
    const runtime = phpRuntimeEvidence(operation);
    target = Object.freeze({
      root: runtime.documentRoot,
      socketPath: runtime.socketPath,
    });
  }

  if (tls !== null && (!tls || typeof tls !== 'object' || Array.isArray(tls)
    || typeof tls.fullchainPath !== 'string' || !tls.fullchainPath.startsWith('/')
    || typeof tls.privateKeyPath !== 'string' || !tls.privateKeyPath.startsWith('/'))) {
    throw new WebsiteProvisioningHandlerError(
      'website_nginx_tls_invalid',
      'Website Nginx TLS material identity is invalid',
      400,
    );
  }
  if (typeof httpsRedirect !== 'boolean' || typeof canonicalRedirect !== 'boolean') {
    throw new WebsiteProvisioningHandlerError(
      'website_nginx_redirect_policy_invalid',
      'Website Nginx redirect policy is invalid',
      400,
    );
  }

  return Object.freeze({
    primaryDomain: intent.primaryDomain,
    aliases: Object.freeze([...intent.aliases]),
    acmeOnlyHostnames: Object.freeze([...(intent.acmeOnlyHostnames ?? [])]),
    mailDiscoverySocketPath: intent.mailDiscoverySocketPath ?? null,
    targetType: intent.targetType,
    target,
    tls: tls === null ? null : Object.freeze({
      fullchainPath: tls.fullchainPath,
      privateKeyPath: tls.privateKeyPath,
    }),
    canonicalRedirect,
    httpsRedirect,
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
  phpSiteBootstrapManager = createPhpSiteBootstrapManager(),
  phpFpmSiteManager = createPhpFpmSiteManager(),
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
    || !phpSiteBootstrapManager
    || typeof phpSiteBootstrapManager.apply !== 'function'
    || typeof phpSiteBootstrapManager.inspect !== 'function'
    || typeof phpSiteBootstrapManager.compensate !== 'function'
    || typeof phpSiteBootstrapManager.inspectCompensation !== 'function'
    || !phpFpmSiteManager
    || typeof phpFpmSiteManager.apply !== 'function'
    || typeof phpFpmSiteManager.inspect !== 'function'
    || typeof phpFpmSiteManager.compensate !== 'function'
    || typeof phpFpmSiteManager.inspectCompensation !== 'function'
    || !staticDeploymentManager
    || typeof staticDeploymentManager.deployStatic !== 'function'
    || typeof staticDeploymentManager.inspectCurrent !== 'function'
    || typeof staticDeploymentManager.inspectDeployment !== 'function'
    || typeof staticDeploymentManager.compensateDeployment !== 'function'
    || typeof staticDeploymentManager.inspectCompensation !== 'function'
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

  async function previewIdentityMigration({ intent } = {}) {
    if (typeof identityManager.previewMigration !== 'function') {
      throw new WebsiteProvisioningHandlerError(
        'website_identity_migration_preview_unavailable',
        'Website Unix identity migration preview is unavailable',
        503,
      );
    }
    return identityManager.previewMigration(identityIntent(intent));
  }

  async function compensateIdentity({ intent, operationId, evidence } = {}) {
    return identityManager.compensate(identityIntent(intent), { operationId, evidence });
  }

  async function inspectIdentityCompensation({ intent, operationId, evidence } = {}) {
    return identityManager.inspectCompensation(identityIntent(intent), { operationId, evidence });
  }

  async function applyPhpBootstrap({ intent, operationId } = {}) {
    return phpSiteBootstrapManager.apply(phpBootstrapIntent(intent), { operationId });
  }

  async function inspectPhpBootstrap({ intent, operationId } = {}) {
    return phpSiteBootstrapManager.inspect(phpBootstrapIntent(intent), { operationId });
  }

  async function compensatePhpBootstrap({ intent, operationId } = {}) {
    return phpSiteBootstrapManager.compensate(phpBootstrapIntent(intent), { operationId });
  }

  async function inspectPhpBootstrapCompensation({ intent, operationId } = {}) {
    return phpSiteBootstrapManager.inspectCompensation(phpBootstrapIntent(intent), { operationId });
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

  async function compensateStaticRuntime(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.mode !== 'deploy') {
      return Object.freeze({
        satisfied: false,
        reason: 'website_static_compensation_not_required',
        adapter: 'static',
        applicationId: normalized.applicationId ?? null,
      });
    }
    return staticDeploymentManager.compensateDeployment(staticCompensationTarget(context));
  }

  async function inspectStaticRuntimeCompensation(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.mode !== 'deploy') {
      return Object.freeze({
        satisfied: false,
        reason: 'website_static_compensation_not_required',
        adapter: 'static',
        applicationId: normalized.applicationId ?? null,
      });
    }
    return staticDeploymentManager.inspectCompensation(staticCompensationTarget(context));
  }

  async function applyRuntime(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.adapter === 'static') return legacyStaticPending(normalized);
    return passengerSiteManager.apply(normalized);
  }

  async function inspectRuntime(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.adapter === 'static') return legacyStaticPending(normalized);
    return passengerSiteManager.inspect(normalized);
  }

  async function previewRuntimeMigration(context = {}) {
    const normalized = runtimeIntent(context.intent);
    if (normalized.adapter === 'static') return legacyStaticPending(normalized);
    if (typeof passengerSiteManager.previewMigration !== 'function') {
      throw new WebsiteProvisioningHandlerError(
        'website_passenger_migration_preview_unavailable',
        'Passenger Website migration preview is unavailable',
        503,
      );
    }
    return passengerSiteManager.previewMigration(normalized);
  }

  async function applyPhpRuntime({ intent, operationId } = {}) {
    return phpFpmSiteManager.apply(phpRuntimeIntent(intent), { operationId });
  }

  async function inspectPhpRuntime({ intent } = {}) {
    return phpFpmSiteManager.inspect(phpRuntimeIntent(intent));
  }

  async function compensatePhpRuntime({ intent, operationId } = {}) {
    return phpFpmSiteManager.compensate(phpRuntimeIntent(intent), { operationId });
  }

  async function inspectPhpRuntimeCompensation({ intent, operationId } = {}) {
    return phpFpmSiteManager.inspectCompensation(phpRuntimeIntent(intent), { operationId });
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
      previewMigration: previewIdentityMigration,
      compensate: compensateIdentity,
      inspectCompensation: inspectIdentityCompensation,
    }),
    php_bootstrap: Object.freeze({
      apply: applyPhpBootstrap,
      inspect: inspectPhpBootstrap,
      compensate: compensatePhpBootstrap,
      inspectCompensation: inspectPhpBootstrapCompensation,
    }),
    runtime: Object.freeze({
      apply: applyRuntime,
      inspect: inspectRuntime,
      previewMigration: previewRuntimeMigration,
    }),
    php_runtime: Object.freeze({
      apply: applyPhpRuntime,
      inspect: inspectPhpRuntime,
      compensate: compensatePhpRuntime,
      inspectCompensation: inspectPhpRuntimeCompensation,
    }),
    static_runtime: Object.freeze({
      apply: applyStaticRuntime,
      inspect: inspectStaticRuntime,
      compensate: compensateStaticRuntime,
      inspectCompensation: inspectStaticRuntimeCompensation,
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
  phpBootstrapIntent,
  phpRuntimeIntent,
  staticDeploymentSpec,
  staticBindingIdentity,
  staticCompensationTarget,
  legacyStaticPending,
  passengerRuntimeEvidence,
  phpRuntimeEvidence,
  passengerEnvironmentEvidence,
  nginxSpec,
  nginxEvidence,
  certificatePending,
});
