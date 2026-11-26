const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

export class WebsitePythonApplicationReleaseProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePythonApplicationReleaseProvisioningError';
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

function activationContext(context = {}) {
  const { operation, operationId, intent } = context;
  if (!operation || typeof operation !== 'object' || operation.operationId !== operationId
    || !intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'python-application-release'
    || typeof intent.applicationId !== 'string'
    || intent.releaseId !== operationId) {
    throw new WebsitePythonApplicationReleaseProvisioningError(
      'website_python_application_release_intent_invalid',
      'Python Application release intent does not match the provisioning operation',
      400,
    );
  }
  const planned = operation.resources?.application;
  const release = stepEvidence(operation, 'python_release');
  if (!planned || planned.id !== intent.applicationId || planned.type !== 'python'
    || !planned.runtime
    || !release || release.adapter !== 'python-release'
    || release.applicationId !== intent.applicationId
    || release.releaseId !== operationId || release.deploymentId !== operationId
    || (release.previousReleaseId !== null && typeof release.previousReleaseId !== 'string')
    || typeof release.commitSha !== 'string' || !COMMIT_PATTERN.test(release.commitSha)) {
    throw new WebsitePythonApplicationReleaseProvisioningError(
      'website_python_application_release_evidence_invalid',
      'Python Application release evidence is incomplete or drifted',
    );
  }
  return Object.freeze({
    applicationId: intent.applicationId,
    operationId,
    releaseId: release.releaseId,
    previousReleaseId: release.previousReleaseId,
    commitSha: release.commitSha.toLowerCase(),
    runtime: planned.runtime,
  });
}

function publicEvidence(spec, application) {
  return Object.freeze({
    satisfied: true,
    adapter: 'python-application-release',
    applicationId: spec.applicationId,
    releaseId: spec.releaseId,
    previousReleaseId: spec.previousReleaseId,
    commitSha: spec.commitSha,
    desiredRevision: application.desiredRevision,
    appliedRevision: application.appliedRevision,
  });
}

export function createWebsitePythonApplicationReleaseProvisioningHandler({ applicationRegistry } = {}) {
  if (!applicationRegistry
    || typeof applicationRegistry.getApplication !== 'function'
    || typeof applicationRegistry.activatePythonRelease !== 'function'
    || typeof applicationRegistry.resetPythonInitialRelease !== 'function') {
    throw new WebsitePythonApplicationReleaseProvisioningError(
      'website_python_application_release_dependencies_invalid',
      'Python Application release provisioning dependencies are invalid',
      503,
    );
  }

  async function inspect(context = {}) {
    const spec = activationContext(context);
    const application = await applicationRegistry.getApplication(spec.applicationId);
    if (!application) {
      return Object.freeze({ satisfied: false, reason: 'website_python_application_missing' });
    }
    if (application.type !== 'python') {
      throw new WebsitePythonApplicationReleaseProvisioningError(
        'website_python_application_release_adapter_drift',
        'Application runtime type changed before Python release reconciliation',
      );
    }
    if (application.currentReleaseId !== spec.releaseId) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_python_application_release_pending',
        applicationId: spec.applicationId,
        releaseId: spec.releaseId,
        currentReleaseId: application.currentReleaseId,
      });
    }
    return publicEvidence(spec, application);
  }

  async function apply(context = {}) {
    const spec = activationContext(context);
    const before = await inspect(context);
    if (before.satisfied === true) return before;
    const application = await applicationRegistry.activatePythonRelease(spec.applicationId, {
      operationId: spec.operationId,
      releaseId: spec.releaseId,
      previousReleaseId: spec.previousReleaseId,
      commitSha: spec.commitSha,
      runtime: spec.runtime,
    });
    return publicEvidence(spec, application);
  }

  async function inspectCompensation(context = {}) {
    const spec = activationContext(context);
    if (spec.previousReleaseId !== null) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_python_application_release_compensation_requires_previous_release_restore',
      });
    }
    const application = await applicationRegistry.getApplication(spec.applicationId);
    if (!application) return Object.freeze({ satisfied: true, applicationId: spec.applicationId, releaseId: spec.releaseId });
    if (application.currentReleaseId === null
      && !application.releases.some((release) => release.releaseId === spec.releaseId)) {
      return Object.freeze({
        satisfied: true,
        adapter: 'python-application-release',
        applicationId: spec.applicationId,
        releaseId: spec.releaseId,
        reset: true,
      });
    }
    if (application.currentReleaseId !== spec.releaseId) {
      throw new WebsitePythonApplicationReleaseProvisioningError(
        'website_python_application_release_compensation_drift',
        'Application release changed before Python release compensation',
      );
    }
    return Object.freeze({ satisfied: false, reason: 'website_python_application_release_compensation_pending' });
  }

  async function compensate(context = {}) {
    const spec = activationContext(context);
    const current = await inspectCompensation(context);
    if (current.satisfied === true) return current;
    if (spec.previousReleaseId !== null) return current;
    await applicationRegistry.resetPythonInitialRelease(spec.applicationId, {
      operationId: spec.operationId,
      releaseId: spec.releaseId,
    });
    return inspectCompensation(context);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websitePythonApplicationReleaseProvisioningInternals = Object.freeze({
  stepEvidence,
  activationContext,
  publicEvidence,
});
