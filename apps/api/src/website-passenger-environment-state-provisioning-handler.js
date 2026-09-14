export class WebsitePassengerEnvironmentStateProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePassengerEnvironmentStateProvisioningError';
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

function stateContext(context = {}) {
  const { operation, operationId, intent } = context;
  if (!operation || typeof operation !== 'object' || operation.operationId !== operationId
    || !intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'passenger-environment-state'
    || typeof intent.applicationId !== 'string') {
    throw new WebsitePassengerEnvironmentStateProvisioningError(
      'website_passenger_environment_state_intent_invalid',
      'Passenger environment state intent is invalid',
      400,
    );
  }
  const planned = operation.resources?.application;
  const environment = stepEvidence(operation, 'passenger_environment');
  const release = stepEvidence(operation, 'application_release');
  if (!planned || planned.id !== intent.applicationId || planned.type !== 'node'
    || planned.runtimeAdapter !== 'passenger'
    || !environment || environment.adapter !== 'passenger-environment'
    || environment.applicationId !== intent.applicationId
    || !Number.isSafeInteger(environment.environmentRevision) || environment.environmentRevision < 0
    || !release || release.adapter !== 'passenger-application-release'
    || release.applicationId !== intent.applicationId || release.releaseId !== operationId) {
    throw new WebsitePassengerEnvironmentStateProvisioningError(
      'website_passenger_environment_state_evidence_invalid',
      'Passenger environment applied-state evidence is incomplete or drifted',
    );
  }
  return Object.freeze({
    applicationId: intent.applicationId,
    releaseId: release.releaseId,
    environmentRevision: environment.environmentRevision,
  });
}

function publicEvidence(spec, status) {
  return Object.freeze({
    satisfied: true,
    adapter: 'passenger-environment-state',
    applicationId: spec.applicationId,
    releaseId: spec.releaseId,
    environmentRevision: spec.environmentRevision,
    appliedRevision: status.appliedRevision,
    appliedReleaseId: status.appliedReleaseId,
  });
}

export function createWebsitePassengerEnvironmentStateProvisioningHandler({
  applicationRegistry,
  applicationEnvironmentRegistry,
} = {}) {
  if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !applicationEnvironmentRegistry
    || typeof applicationEnvironmentRegistry.environmentStatus !== 'function'
    || typeof applicationEnvironmentRegistry.markApplied !== 'function') {
    throw new WebsitePassengerEnvironmentStateProvisioningError(
      'website_passenger_environment_state_dependencies_invalid',
      'Passenger environment applied-state dependencies are invalid',
      503,
    );
  }

  async function inspect(context = {}) {
    const spec = stateContext(context);
    const application = await applicationRegistry.getApplication(spec.applicationId);
    if (!application || application.type !== 'node' || application.runtimeAdapter !== 'passenger') {
      throw new WebsitePassengerEnvironmentStateProvisioningError(
        'website_passenger_environment_state_application_drift',
        'Passenger Application changed before environment state reconciliation',
      );
    }
    if (application.currentReleaseId !== spec.releaseId) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_passenger_environment_state_release_pending',
        applicationId: spec.applicationId,
        releaseId: spec.releaseId,
        currentReleaseId: application.currentReleaseId,
      });
    }
    const status = await applicationEnvironmentRegistry.environmentStatus(spec.applicationId, {
      currentReleaseId: spec.releaseId,
    });
    if (status.savedRevision !== spec.environmentRevision) {
      throw new WebsitePassengerEnvironmentStateProvisioningError(
        'website_passenger_environment_state_revision_drift',
        'Application environment changed after Passenger environment materialization',
      );
    }
    if (status.appliedRevision === spec.environmentRevision
      && status.appliedReleaseId === spec.releaseId
      && status.appliedToRunningProcess === true) {
      return publicEvidence(spec, status);
    }
    if (status.appliedRevision !== null || status.appliedReleaseId !== null) {
      throw new WebsitePassengerEnvironmentStateProvisioningError(
        'website_passenger_environment_state_applied_drift',
        'Application environment applied metadata conflicts with Passenger provisioning',
      );
    }
    return Object.freeze({
      satisfied: false,
      reason: 'website_passenger_environment_state_pending',
      applicationId: spec.applicationId,
      releaseId: spec.releaseId,
      environmentRevision: spec.environmentRevision,
    });
  }

  async function apply(context = {}) {
    const spec = stateContext(context);
    const before = await inspect(context);
    if (before.satisfied === true) return before;
    if (before.reason !== 'website_passenger_environment_state_pending') return before;
    await applicationEnvironmentRegistry.markApplied({
      applicationId: spec.applicationId,
      revision: spec.environmentRevision,
      releaseId: spec.releaseId,
    });
    const after = await inspect(context);
    if (after.satisfied !== true) {
      throw new WebsitePassengerEnvironmentStateProvisioningError(
        'website_passenger_environment_state_unverified',
        'Passenger environment applied state could not be verified after reconciliation',
      );
    }
    return after;
  }

  return Object.freeze({ apply, inspect });
}

export const websitePassengerEnvironmentStateProvisioningInternals = Object.freeze({
  stepEvidence,
  stateContext,
  publicEvidence,
});
