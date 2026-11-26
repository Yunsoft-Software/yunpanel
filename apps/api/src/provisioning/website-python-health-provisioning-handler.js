import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export class WebsitePythonHealthProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePythonHealthProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function stepEvidence(operation, stepId) {
  const step = operation?.steps?.find((candidate) => candidate.id === stepId);
  return step?.state === 'succeeded' && step.evidence && typeof step.evidence === 'object'
    ? step.evidence
    : null;
}

function healthSpec(context = {}) {
  const { operation, operationId, websiteId, intent } = context;
  if (!operation || typeof operation !== 'object' || operation.operationId !== operationId
    || operation.websiteId !== websiteId
    || !intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'python-health'
    || typeof intent.applicationId !== 'string'
    || typeof intent.primaryDomain !== 'string'
    || typeof intent.healthPath !== 'string'
    || !Number.isInteger(intent.timeoutSeconds)) {
    throw new WebsitePythonHealthProvisioningError(
      'website_python_health_intent_invalid',
      'Python Website health intent is invalid',
      400,
    );
  }
  const application = operation.resources?.application;
  const website = operation.resources?.website;
  const primaryDomain = operation.resources?.primaryDomain;
  const runtime = stepEvidence(operation, 'python_runtime');
  const nginx = stepEvidence(operation, 'nginx');
  const domainActivation = stepEvidence(operation, 'domain_activation');
  if (!application || application.id !== intent.applicationId || application.type !== 'python'
    || !website || website.id !== websiteId || website.applicationId !== application.id
    || website.runtimeType !== 'python'
    || !primaryDomain || primaryDomain.primaryDomain !== intent.primaryDomain
    || application.runtime?.healthPath !== intent.healthPath
    || application.runtime?.healthTimeoutSeconds !== intent.timeoutSeconds
    || !runtime || runtime.adapter !== 'python-runtime' || runtime.applicationId !== application.id
    || !nginx || nginx.satisfied !== true || typeof nginx.checksum !== 'string' || !CHECKSUM_PATTERN.test(nginx.checksum)
    || !domainActivation || domainActivation.adapter !== 'domain-activation'
    || domainActivation.websiteId !== websiteId || domainActivation.nginxChecksum !== nginx.checksum) {
    throw new WebsitePythonHealthProvisioningError(
      'website_python_health_evidence_invalid',
      'Python Website health prerequisites are incomplete or drifted',
    );
  }
  return Object.freeze({
    applicationId: application.id,
    websiteId,
    primaryDomain: intent.primaryDomain,
    healthPath: intent.healthPath,
    timeoutSeconds: intent.timeoutSeconds,
  });
}

export function createWebsitePythonHealthProvisioningHandler({
  healthInspector = createWebsiteHttpHealthInspector(),
} = {}) {
  if (!healthInspector || typeof healthInspector.inspect !== 'function') {
    throw new WebsitePythonHealthProvisioningError(
      'website_python_health_dependencies_invalid',
      'Python Website health inspector is unavailable',
      503,
    );
  }

  async function inspect(context = {}) {
    const spec = healthSpec(context);
    const result = await healthInspector.inspect({
      primaryDomain: spec.primaryDomain,
      healthPath: spec.healthPath,
      timeoutSeconds: spec.timeoutSeconds,
    });
    return Object.freeze({
      ...result,
      applicationId: spec.applicationId,
      websiteId: spec.websiteId,
    });
  }

  return Object.freeze({ apply: inspect, inspect });
}

export const websitePythonHealthProvisioningInternals = Object.freeze({
  stepEvidence,
  healthSpec,
});
