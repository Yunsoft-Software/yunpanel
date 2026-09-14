import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export class WebsitePassengerHealthProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePassengerHealthProvisioningError';
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
    || intent.adapter !== 'passenger-health'
    || typeof intent.applicationId !== 'string'
    || typeof intent.primaryDomain !== 'string'
    || typeof intent.healthPath !== 'string'
    || !Number.isInteger(intent.timeoutSeconds)) {
    throw new WebsitePassengerHealthProvisioningError(
      'website_passenger_health_intent_invalid',
      'Passenger Website health intent is invalid',
      400,
    );
  }
  const application = operation.resources?.application;
  const website = operation.resources?.website;
  const primaryDomain = operation.resources?.primaryDomain;
  const runtime = stepEvidence(operation, 'runtime');
  const nginx = stepEvidence(operation, 'nginx');
  const domainActivation = stepEvidence(operation, 'domain_activation');
  if (!application || application.id !== intent.applicationId || application.type !== 'node'
    || application.runtimeAdapter !== 'passenger'
    || !website || website.id !== websiteId || website.applicationId !== application.id
    || website.runtimeType !== 'node'
    || !primaryDomain || primaryDomain.primaryDomain !== intent.primaryDomain
    || application.runtime?.healthPath !== intent.healthPath
    || application.runtime?.healthTimeoutSeconds !== intent.timeoutSeconds
    || !runtime || runtime.adapter !== 'passenger' || runtime.applicationId !== application.id
    || !nginx || nginx.satisfied !== true || typeof nginx.checksum !== 'string' || !CHECKSUM_PATTERN.test(nginx.checksum)
    || !domainActivation || domainActivation.adapter !== 'domain-activation'
    || domainActivation.websiteId !== websiteId || domainActivation.nginxChecksum !== nginx.checksum) {
    throw new WebsitePassengerHealthProvisioningError(
      'website_passenger_health_evidence_invalid',
      'Passenger Website health prerequisites are incomplete or drifted',
    );
  }
  return Object.freeze({
    primaryDomain: intent.primaryDomain,
    healthPath: intent.healthPath,
    timeoutSeconds: intent.timeoutSeconds,
  });
}

export function createWebsitePassengerHealthProvisioningHandler({
  healthInspector = createWebsiteHttpHealthInspector(),
} = {}) {
  if (!healthInspector || typeof healthInspector.inspect !== 'function') {
    throw new WebsitePassengerHealthProvisioningError(
      'website_passenger_health_dependencies_invalid',
      'Passenger Website health inspector is unavailable',
      503,
    );
  }

  async function inspect(context = {}) {
    return healthInspector.inspect(healthSpec(context));
  }

  return Object.freeze({ apply: inspect, inspect });
}

export const websitePassengerHealthProvisioningInternals = Object.freeze({
  stepEvidence,
  healthSpec,
});
